import { evaluate } from "@/domain/qualification/engine";
import { detectPricingDisclosure } from "@/domain/pricing/guard";
import { normaliseQuestion } from "@/domain/knowledge/answer";
import { normaliseCallData, type VaaniEnvelope } from "@/integrations/vaani/webhook";
import type { CallExtraction } from "@/integrations/gemini/tasks";
import type { GeminiUsage } from "@/integrations/gemini/client";
import { normalisePhone } from "@/lib/phone";
import { safeErrorMessage } from "@/lib/log";
import { loadCostRates, loadQualificationConfig } from "@/server/settings";
import type { CallRow, Store } from "@/server/store/types";
import { leadPatchFromFacts, recordQualification } from "./live-call";
import { recordTeamMessage } from "./team";

export interface PostCallDeps {
  store: Store;
  now: () => Date;
  /** Gemini extraction; undefined when Gemini is not configured. */
  extract?: (transcript: string, callDateIso: string) => Promise<{ data: CallExtraction; usage: GeminiUsage }>;
}

const SHORT_CALL_SECONDS = 25;

/**
 * Processes one stored Vaani event. Safe to re-run: the call is keyed by provider call id,
 * leads by phone, lead events and cost events by dedupe keys, exceptions by dedupe keys.
 * It never books appointments — booking only happens live, through the voice tools.
 */
export async function processVaaniEvent(deps: PostCallDeps, envelope: VaaniEnvelope, integrationEventId: string): Promise<{ outcome: string; callId?: string }> {
  const { store } = deps;
  const data = normaliseCallData(envelope.data);

  if (envelope.type === "webhook.ping") {
    await store.recordIntegrationHealth("vaani", true, "webhook.ping");
    return { outcome: "ping" };
  }
  if (envelope.type === "usage.charged") {
    if (data.costPaise !== null) {
      await store.insertCostEvent({
        provider: "vaani",
        usage_type: data.surface ?? "voice",
        units: data.durationSeconds !== null ? data.durationSeconds / 60 : null,
        unit_label: "minutes",
        unit_rate: null,
        cost_amount: data.costPaise / 100,
        currency: "INR",
        is_estimate: false,
        usage_at: new Date(envelope.created * 1000).toISOString(),
        source: "vaani:usage.charged",
        external_id: envelope.id,
        call_id: data.providerCallId ? (await store.getCallByProviderId("vaani", data.providerCallId))?.id ?? null : null,
      });
    }
    return { outcome: data.costPaise !== null ? "cost_recorded" : "cost_missing" };
  }
  if (envelope.type !== "call.completed" && envelope.type !== "call.failed") return { outcome: "ignored" };

  const providerCallId = data.providerCallId ?? `event:${envelope.id}`;
  // Signed synthetic events from `npm run smoke` are stored as test fixtures, never production.
  const isTest = envelope.data.aangan_test === true && providerCallId.startsWith("smoke-");
  const phoneNorm = normalisePhone(data.callerPhone);
  const { call: existing } = await store.ensureCall("vaani", providerCallId, {
    status: "in_progress",
    started_at: data.startedAt ?? new Date(envelope.created * 1000).toISOString(),
    caller_phone: data.callerPhone,
    caller_phone_normalized: phoneNorm,
    production_call: !isTest,
    is_test: isTest,
  });
  await store.updateIntegrationEvent(integrationEventId, { related_call_id: existing.id });

  const failed = envelope.type === "call.failed";
  const short = !failed && (data.durationSeconds ?? Infinity) < SHORT_CALL_SECONDS && !existing.lead_id;
  let call = await store.updateCall(existing.id, {
    status: failed ? "failed" : short ? "disconnected" : "completed",
    answered: failed ? (existing.answered ?? false) : true,
    ended_at: data.endedAt ?? new Date(envelope.created * 1000).toISOString(),
    duration_seconds: data.durationSeconds,
    failure_reason: failed ? data.failureReason ?? "Provider reported a pipeline failure" : null,
    recording_reference: data.recordingReference,
    provider_metadata: { event_id: envelope.id, flow_id: data.flowId, surface: data.surface },
    processing_status: "processing",
  });
  if (call.answered) {
    await store.addLeadEvent({ lead_id: call.lead_id, call_id: call.id, event_type: "call_answered", dedupe_key: `call:${call.id}`, is_test: call.is_test });
  }
  if (data.costPaise !== null) {
    await store.insertCostEvent({
      provider: "vaani", usage_type: data.surface ?? "voice", units: data.durationSeconds !== null ? data.durationSeconds / 60 : null,
      unit_label: "minutes", unit_rate: null, cost_amount: data.costPaise / 100, currency: "INR", is_estimate: false,
      usage_at: call.ended_at ?? call.started_at ?? new Date().toISOString(), source: `vaani:${envelope.type}`, external_id: `${envelope.id}:call`, call_id: call.id,
    });
  }
  if (data.transcript) await store.saveTranscript(call.id, data.transcript, data.turns, "provider_webhook");

  // Pricing safety: scan what the AGENT said. Caller turns legitimately contain budgets.
  if (data.turns?.some((t) => t.role === "agent")) {
    const agentText = data.turns.filter((t) => t.role === "agent").map((t) => t.text).join("\n");
    const check = detectPricingDisclosure(agentText);
    if (check.violation) {
      await store.recordPolicyEvent({ call_id: call.id, kind: "pricing_disclosure_detected", detail: { matches: check.matches }, is_test: call.is_test });
      await store.upsertException({
        kind: "pricing_violation", severity: "critical", call_id: call.id, dedupe_key: `pricing:${call.id}`, is_test: call.is_test,
        title: "Possible price disclosure by the voice agent",
        detail: `Matched: ${check.matches.join(" | ")}. Review the transcript and the agent configuration.`,
      });
    }
  } else if (data.transcript) {
    await store.recordPolicyEvent({ call_id: call.id, kind: "pricing_scan_unavailable", detail: { reason: "transcript has no speaker roles" }, is_test: call.is_test });
  }

  if (failed || short) {
    const reconnected = phoneNorm ? await store.findRecentCallFromPhone(phoneNorm, call.started_at ?? new Date().toISOString(), call.id) : null;
    if (!reconnected) {
      await store.upsertException({
        kind: "failed_call", severity: "high", call_id: call.id, dedupe_key: `failed-call:${call.id}`, is_test: call.is_test,
        title: failed ? "Call failed mid-conversation" : "Call dropped early",
        detail: phoneNorm ? "Caller number available — call back." : "Caller number masked or unavailable; no automatic follow-up possible.",
      });
    }
  }

  if (!data.transcript || !deps.extract) {
    call = await store.updateCall(call.id, { processing_status: data.transcript ? "pending" : "processed", processing_error: data.transcript ? "Gemini not configured; extraction pending" : null });
    return { outcome: failed ? "failed_call" : "stored_without_extraction", callId: call.id };
  }

  try {
    const { data: x, usage } = await deps.extract(data.transcript, call.started_at ?? new Date().toISOString());
    await recordGeminiCost(deps, call, usage);
    await applyExtraction(deps, call, x);
    await store.updateCall(call.id, { processing_status: "processed", processing_error: null });
    await store.recordIntegrationHealth("gemini", true, "extract");
    return { outcome: "processed", callId: call.id };
  } catch (e) {
    await store.recordIntegrationHealth("gemini", false, "extract", safeErrorMessage(e));
    await store.updateCall(call.id, { processing_status: "failed", processing_error: safeErrorMessage(e) });
    throw e;
  }
}

export async function recordGeminiCost(deps: PostCallDeps, call: CallRow, usage: GeminiUsage) {
  const rates = await loadCostRates(deps.store);
  if (rates.geminiInputUsdPerMTok == null || rates.geminiOutputUsdPerMTok == null || !rates.usdToInr) return;
  const usd = (usage.promptTokens / 1e6) * rates.geminiInputUsdPerMTok + (usage.outputTokens / 1e6) * rates.geminiOutputUsdPerMTok;
  await deps.store.insertCostEvent({
    provider: "gemini", usage_type: "extraction", units: usage.promptTokens + usage.outputTokens, unit_label: "tokens", unit_rate: null,
    cost_amount: Math.round(usd * rates.usdToInr * 10000) / 10000, currency: "INR", is_estimate: true, usage_at: new Date().toISOString(),
    source: `gemini:${usage.model}`, external_id: `extract:${call.id}`, call_id: call.id, is_test: call.is_test,
  });
}

export async function applyExtraction(deps: PostCallDeps, call: CallRow, x: CallExtraction) {
  const { store } = deps;
  const callType = call.call_type !== "unknown" ? call.call_type : x.callType;
  call = await store.updateCall(call.id, { call_type: callType, summary: x.summary });

  for (const q of x.unansweredQuestions) {
    const uq = await store.logUnansweredQuestion({ question: q, normalized: normaliseQuestion(q), call_id: call.id, is_test: call.is_test });
    await store.upsertException({
      kind: "unanswered_question", severity: "low", call_id: call.id, unanswered_question_id: uq.id, dedupe_key: `unanswered:${uq.id}`, is_test: call.is_test,
      title: `Unanswered: “${q.slice(0, 120)}”`, detail: "Logged from the call transcript.",
    });
  }
  if (x.message) {
    await recordTeamMessage(store, {
      call_id: call.id, caller_name: x.contact.name, caller_phone: x.contact.callbackPhone ?? call.caller_phone_normalized ?? call.caller_phone,
      message_type: x.message.type, for_name: x.message.forName, about: x.message.about, callback_window: x.message.callbackWindow,
      dedupe_key: `call:${call.id}:${x.message.forName ?? "team"}`, is_test: call.is_test,
    });
  }
  if (x.pricingRequested) await store.recordPolicyEvent({ call_id: call.id, kind: "pricing_request_deflected", detail: { source: "post_call_extraction" }, is_test: call.is_test });

  if (callType === "existing_project_complaint") {
    await store.upsertException({
      kind: "complaint", severity: "critical", call_id: call.id, dedupe_key: `escalation:${call.id}:complaint`, is_test: call.is_test,
      title: `Complaint: ${x.contact.name ?? "existing client"}${x.complaint?.projectLocation ? `, ${x.complaint.projectLocation}` : ""}`,
      detail: x.complaint ? `${x.complaint.issue}${x.complaint.designerName ? ` (designer: ${x.complaint.designerName})` : ""}` : x.summary,
    });
    return; // complaints never enter the sales funnel
  }
  if (callType === "callback_request" || callType === "existing_lead_follow_up") {
    await store.upsertException({
      kind: "follow_up_required", severity: callType === "existing_lead_follow_up" ? "high" : "normal", call_id: call.id,
      dedupe_key: `follow-up:${call.id}`, is_test: call.is_test,
      title: callType === "existing_lead_follow_up" ? `Missed follow-up: ${x.contact.name ?? "caller"}` : `Callback requested: ${x.contact.name ?? "caller"}`,
      detail: x.summary,
    });
    if (callType === "callback_request") return;
  }
  if (callType !== "new_enquiry" && callType !== "existing_lead_follow_up") return;

  // A live evaluation (via the voice tools) is authoritative; post-call only fills gaps.
  const live = await store.latestQualificationForCall(call.id);
  const patch = leadPatchFromFacts(x.facts, {
    name: x.contact.name, phone: x.contact.callbackPhone, email: x.contact.email,
    projectTypeLabel: x.projectTypeLabel, scopeSummary: x.scopeSummary, currentState: x.currentPropertyState,
  });
  const phone = patch.phone_normalized ?? call.caller_phone_normalized;
  let lead = call.lead_id ? await store.getLead(call.lead_id) : phone ? await store.findLeadByPhone(phone) : null;
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null));
  if (lead) {
    const fill = Object.fromEntries(Object.entries(clean).filter(([k]) => lead![k as keyof typeof lead] == null || lead![k as keyof typeof lead] === ""));
    lead = await store.updateLead(lead.id, { ...fill, last_call_id: call.id });
  } else {
    lead = await store.insertLead({ ...clean, phone_normalized: phone, phone: phone ?? call.caller_phone, first_call_id: call.id, last_call_id: call.id, is_test: call.is_test });
  }
  if (call.lead_id !== lead.id) call = await store.updateCall(call.id, { lead_id: lead.id });

  if (!live) {
    const config = await loadQualificationConfig(store);
    const result = evaluate({ facts: x.facts, config, clarificationsAsked: x.clarificationsAsked, now: new Date(call.started_at ?? Date.now()) });
    // Post-call there is no caller left to ask: unresolved clarifications become human review.
    const final = result.status === "needs_clarification" ? { ...result, status: "needs_review" as const, nextQuestion: null } : result;
    lead = await recordQualification({ store }, call, lead, x.facts, final, "rules_engine:post_call");
  }

  if (lead.qualification_status === "green" || lead.qualification_status === "amber") {
    if (!lead.is_test) await store.enqueueJob("hubspot_sync_lead", { lead_id: lead.id, reason: "qualified" }, `hubspot:${lead.id}:call:${call.id}`);
    const appt = await store.getLiveAppointmentForLead(lead.id);
    if (!appt) {
      await store.upsertException({
        kind: "booking_not_completed", severity: "high", call_id: call.id, lead_id: lead.id, dedupe_key: `no-booking:${lead.id}`, is_test: call.is_test,
        title: `Qualified lead without a booked consultation: ${lead.name ?? "caller"}`,
        detail: "The caller qualified but no consultation was booked during the call. Contact them to arrange one.",
      });
    }
  }
}
