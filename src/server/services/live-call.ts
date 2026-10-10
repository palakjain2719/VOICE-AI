import type { z } from "zod";
import { answerQuestion, normaliseQuestion, type ArticleSelector, type RuntimeArticle } from "@/domain/knowledge/answer";
import { FALLBACK_ANSWER } from "@/domain/knowledge/seed";
import { evaluate } from "@/domain/qualification/engine";
import { declineCategory, fitScore } from "@/domain/qualification/scoring";
import { LeadFactsSchema, type LeadFacts, type QualificationResult } from "@/domain/qualification/types";
import { computeSlots, formatSlotLabel, isSlotFree, type Slot } from "@/domain/booking/slots";
import { normaliseEmail, normalisePhone } from "@/lib/phone";
import { safeErrorMessage } from "@/lib/log";
import type { CalendarApi } from "@/integrations/google/calendar";
import { eventIdFor } from "@/integrations/google/calendar";
import { loadBookingConfig, loadEscalationPolicy, loadQualificationConfig } from "@/server/settings";
import { OverlapError, type CallRow, type DesignerRow, type LeadRow, type Store } from "@/server/store/types";
import { recordTeamMessage } from "./team";
import type {
  TakeMessageSchema,
  AnswerQuestionSchema,
  BookConsultationSchema,
  EscalateSchema,
  EvaluateQualificationSchema,
  GetAvailabilitySchema,
  SaveIntakeSchema,
} from "./voice-tool-schemas";

export interface LiveDeps {
  store: Store;
  now: () => Date;
  selector?: ArticleSelector;
  /** Resolves a calendar client for a designer; throws GoogleAuthError when not connected. */
  calendarFor: (designer: DesignerRow) => Promise<CalendarApi>;
  /** Integration-health key for the calendar in use ("calcom" or "google_calendar"). */
  calendarProvider?: string;
  /** Called after work is queued so it can be processed straight away (e.g. via after()). */
  kick?: () => void;
  provider?: string;
  isTest?: boolean;
}

const RECONNECT_WINDOW_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Calls and leads
// ---------------------------------------------------------------------------

/** Insert-or-get the call; links a reconnect from the same number within 30 minutes. */
export async function ensureLiveCall(deps: LiveDeps, callId: string, callerPhone?: string | null): Promise<CallRow> {
  const provider = deps.provider ?? "vaani";
  const phoneNorm = normalisePhone(callerPhone);
  const { call, created } = await deps.store.ensureCall(provider, callId, {
    status: "in_progress",
    answered: true,
    started_at: deps.now().toISOString(),
    caller_phone: callerPhone ?? null,
    caller_phone_normalized: phoneNorm,
    production_call: !deps.isTest,
    is_test: !!deps.isTest,
  });
  if (created && phoneNorm) {
    const prior = await deps.store.findRecentCallFromPhone(phoneNorm, new Date(deps.now().getTime() - RECONNECT_WINDOW_MS).toISOString(), call.id);
    if (prior) {
      return deps.store.updateCall(call.id, {
        related_call_id: prior.id,
        lead_id: prior.lead_id,
        intake: { ...prior.intake, reconnected_from: prior.id },
      });
    }
  }
  if (!call.caller_phone_normalized && phoneNorm) return deps.store.updateCall(call.id, { caller_phone_normalized: phoneNorm });
  return call;
}

async function upsertLead(deps: LiveDeps, call: CallRow, patch: Partial<LeadRow>): Promise<LeadRow> {
  const phone = patch.phone_normalized ?? call.caller_phone_normalized;
  let lead = call.lead_id ? await deps.store.getLead(call.lead_id) : null;
  if (!lead && phone) lead = await deps.store.findLeadByPhone(phone);
  if (!lead && patch.email) lead = await deps.store.findLeadByEmail(patch.email);
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null)) as Partial<LeadRow>;
  if (lead) {
    lead = await deps.store.updateLead(lead.id, { ...clean, last_call_id: call.id, ...(phone && !lead.phone_normalized ? { phone_normalized: phone, phone } : {}) });
  } else {
    lead = await deps.store.insertLead({
      ...clean,
      phone_normalized: phone,
      phone: phone ?? call.caller_phone,
      first_call_id: call.id,
      last_call_id: call.id,
      is_test: call.is_test,
    });
  }
  if (call.lead_id !== lead.id) await deps.store.updateCall(call.id, { lead_id: lead.id });
  return lead;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function saveIntake(deps: LiveDeps, input: z.infer<typeof SaveIntakeSchema>) {
  const call = await ensureLiveCall(deps, input.call_id, input.caller_phone);
  const { call_type, ...rest } = input;
  const fields = Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "call_id" && k !== "caller_phone"));
  const intake = { ...call.intake, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null)) };
  await deps.store.updateCall(call.id, { intake, ...(call_type ? { call_type } : {}) });
  return { ok: true, saved: Object.keys(fields).filter((k) => fields[k] != null) };
}

export async function answerLive(deps: LiveDeps, input: z.infer<typeof AnswerQuestionSchema>) {
  const call = await ensureLiveCall(deps, input.call_id, input.caller_phone);
  const articles: RuntimeArticle[] = await deps.store.listPublishedArticles();
  const result = await answerQuestion(input.question, articles, deps.selector);
  if (result.kind === "pricing_deflection") {
    await deps.store.recordPolicyEvent({ call_id: call.id, kind: result.pricingBlocked ? "pricing_disclosure_blocked" : "pricing_request_deflected", detail: { article: result.articleSlug }, is_test: call.is_test });
  }
  if (result.logUnanswered) {
    await logUnanswered(deps, call, input.question);
    await deps.store.recordPolicyEvent({ call_id: call.id, kind: "fallback_answer_given", is_test: call.is_test });
  }
  return { say: result.text, kind: result.kind, article: result.articleSlug };
}

async function logUnanswered(deps: LiveDeps, call: CallRow, question: string) {
  const q = await deps.store.logUnansweredQuestion({ question, normalized: normaliseQuestion(question), call_id: call.id, is_test: call.is_test });
  await deps.store.upsertException({
    kind: "unanswered_question",
    title: `Unanswered: “${question.slice(0, 120)}”`,
    detail: "The agent gave the approved fallback. Review and, if appropriate, approve an answer for the knowledge base.",
    call_id: call.id,
    unanswered_question_id: q.id,
    severity: "low",
    dedupe_key: `unanswered:${q.id}`,
    is_test: call.is_test,
  });
  return q;
}

export async function logUnansweredLive(deps: LiveDeps, input: z.infer<typeof AnswerQuestionSchema>) {
  const call = await ensureLiveCall(deps, input.call_id, input.caller_phone);
  await logUnanswered(deps, call, input.question);
  return { ok: true, say: FALLBACK_ANSWER };
}

/** Persists a rules evaluation and its funnel events; shared by live and post-call paths. */
export async function recordQualification(
  deps: Pick<LiveDeps, "store">,
  call: CallRow,
  lead: LeadRow,
  facts: LeadFacts,
  result: QualificationResult,
  evaluatedBy: "rules_engine:live" | "rules_engine:post_call",
): Promise<LeadRow> {
  const { store } = deps;
  await store.insertQualification({
    call_id: call.id,
    lead_id: lead.id,
    status: result.status,
    criteria: result.criteria,
    reasons: Object.values(result.criteria).map((c) => `${c.result}: ${c.detail}`),
    uncertainties: result.uncertainties,
    facts,
    rules_version: result.rulesVersion,
    config_hash: result.configHash,
    evaluated_by: evaluatedBy,
  });
  const updated = await store.updateLead(lead.id, {
    qualification_status: result.status,
    qualification_reasons: Object.entries(result.criteria).map(([k, c]) => ({ criterion: k, ...c })),
    uncertainties: result.uncertainties,
    service_zone: result.serviceZone,
    locality: result.matchedLocality,
    fit_score: fitScore(result),
    decline_category: declineCategory(result),
    // Test fixtures never go to the CRM.
    hubspot_sync_status: result.eligibleForBooking && !lead.is_test ? "pending" : lead.hubspot_sync_status,
  });
  const ev = (event_type: "qualified" | "rejected" | "needs_review") =>
    store.addLeadEvent({ lead_id: lead.id, call_id: call.id, event_type, dedupe_key: `lead:${lead.id}`, metadata: { status: result.status, rules_version: result.rulesVersion }, is_test: lead.is_test });
  if (result.status === "green" || result.status === "amber") await ev("qualified");
  else if (result.status === "red") await ev("rejected");
  else if (result.status === "needs_review") {
    await ev("needs_review");
    await store.upsertException({
      kind: "ambiguous_qualification",
      title: `Review enquiry: ${lead.name ?? "caller"}${lead.locality ? `, ${lead.locality}` : ""}`,
      detail: result.uncertainties.map((u) => u.detail).join(" "),
      call_id: call.id,
      lead_id: lead.id,
      severity: "normal",
      dedupe_key: `review:${lead.id}`,
      is_test: lead.is_test,
    });
  }
  return updated;
}

export function leadPatchFromFacts(facts: LeadFacts, extra: { name?: string | null; phone?: string | null; email?: string | null; projectTypeLabel?: string | null; scopeSummary?: string | null; currentState?: string | null }): Partial<LeadRow> {
  const phone = normalisePhone(extra.phone);
  return {
    name: extra.name ?? undefined,
    ...(phone ? { phone_normalized: phone, phone } : {}),
    email: normaliseEmail(extra.email) ?? undefined,
    location: facts.locationText ?? undefined,
    project_segment: facts.segment,
    project_type: extra.projectTypeLabel ?? (facts.propertyType !== "unknown" ? facts.propertyType : undefined),
    project_scope: extra.scopeSummary ?? undefined,
    property_area_sqft: facts.areaSqft ?? undefined,
    current_property_state: extra.currentState ?? undefined,
    timeline: facts.timelineText ?? undefined,
    required_completion_date: facts.requiredCompletionDate ?? undefined,
    budget_volunteered: facts.budgetMentioned,
    budget_notes: facts.budgetText ?? undefined,
    decision_maker_status: facts.decisionMaker,
    is_rented: facts.isRented ?? undefined,
  };
}

export async function evaluateLive(deps: LiveDeps, input: z.infer<typeof EvaluateQualificationSchema>) {
  const call = await ensureLiveCall(deps, input.call_id, input.caller_phone);
  const facts = LeadFactsSchema.parse(input.facts);
  const config = await loadQualificationConfig(deps.store);
  const result = evaluate({ facts, config, clarificationsAsked: input.clarifications_asked, now: deps.now() });
  let lead = await upsertLead(
    deps,
    call,
    leadPatchFromFacts(facts, {
      name: input.name,
      phone: input.callback_phone,
      email: input.email,
      projectTypeLabel: input.project_type_label,
      scopeSummary: input.scope_summary,
      currentState: input.current_state,
    }),
  );
  if (call.call_type === "unknown") await deps.store.updateCall(call.id, { call_type: "new_enquiry" });

  // Clarification turns are not final outcomes; only record terminal evaluations.
  if (result.status !== "needs_clarification") lead = await recordQualification(deps, call, lead, facts, result, "rules_engine:live");

  const articles = await deps.store.listPublishedArticles();
  const closure = result.closureSlug ? articles.find((a) => a.slug === result.closureSlug)?.spokenAnswer ?? null : null;
  return {
    status: result.status,
    eligible_for_booking: result.eligibleForBooking,
    next_question: result.nextQuestion?.text ?? null,
    next_criterion: result.nextQuestion?.criterion ?? null,
    closure_text: closure,
    uncertainties: result.uncertainties.map((u) => u.criterion),
    lead_id: lead.id,
  };
}

// ---------------------------------------------------------------------------
// Availability and booking
// ---------------------------------------------------------------------------

async function eligibleLeadFor(deps: LiveDeps, call: CallRow): Promise<LeadRow> {
  const lead = call.lead_id ? await deps.store.getLead(call.lead_id) : null;
  if (!lead || (lead.qualification_status !== "green" && lead.qualification_status !== "amber")) {
    throw new BookingRefused("not_eligible", "This enquiry has not been qualified for a consultation.");
  }
  return lead;
}

export class BookingRefused extends Error {
  constructor(
    public readonly code: "not_eligible" | "calendar_unavailable" | "no_designers" | "invalid_slot",
    message: string,
  ) {
    super(message);
  }
}

async function busyFor(deps: LiveDeps, designers: DesignerRow[], fromIso: string, toIso: string) {
  const busy: Record<string, { start: Date; end: Date }[]> = {};
  const usable: DesignerRow[] = [];
  for (const d of designers) {
    try {
      const cal = await deps.calendarFor(d);
      const fb = await cal.freeBusy([d.calendar_id!], fromIso, toIso);
      busy[d.id] = fb[d.calendar_id!] ?? [];
      usable.push(d);
    } catch (e) {
      // A designer whose calendar can't be read is skipped, never assumed free.
      await deps.store.recordIntegrationHealth(deps.calendarProvider ?? "google_calendar", false, "freeBusy", safeErrorMessage(e), { designer_id: d.id });
    }
  }
  return { busy, usable };
}

export async function availabilityLive(deps: LiveDeps, input: z.infer<typeof GetAvailabilitySchema>): Promise<{ status: "ok" | "none" | "unavailable"; slots: (Slot & { designer_name: string })[]; say: string }> {
  const call = await ensureLiveCall(deps, input.call_id, input.caller_phone);
  await eligibleLeadFor(deps, call);
  const config = await loadBookingConfig(deps.store);
  const designers = await deps.store.listBookableDesigners();
  const now = deps.now();
  const to = new Date(now.getTime() + (config.horizonDays + 1) * 86400_000);
  const { busy, usable } = await busyFor(deps, designers, now.toISOString(), to.toISOString());
  if (!usable.length) {
    await deps.store.upsertException({
      kind: "calendar_failure",
      title: "Booking unavailable: no designer calendar could be read",
      detail: "Check designer calendar connections in Integrations.",
      call_id: call.id,
      severity: "high",
      dedupe_key: `calendar-unavailable:${now.toISOString().slice(0, 10)}`,
      is_test: call.is_test,
    });
    return { status: "unavailable", slots: [], say: "I'm not able to see the designers' calendars right now. I'll make sure the team calls you back to fix a time." };
  }
  await deps.store.recordIntegrationHealth(deps.calendarProvider ?? "google_calendar", true, "freeBusy");
  const loads = await Promise.all(usable.map(async (d) => ({ id: d.id, load: await deps.store.countUpcomingAppointments(d.id, now.toISOString()) })));
  const slots = computeSlots({
    designers: loads,
    busy,
    config,
    now,
    preference: { dates: input.preferred_dates, dayparts: input.dayparts, weekdaysOnly: input.weekdays_only, weekendsOnly: input.weekends_only },
  });
  const named = slots.map((s) => ({ ...s, designer_name: usable.find((d) => d.id === s.designerId)?.name ?? "" }));
  if (!named.length) return { status: "none", slots: [], say: "I don't have a free consultation slot at those times. Would another day or time of day work for you?" };
  return { status: "ok", slots: named, say: `I can offer ${named.map((s) => s.label).join(", or ")}. Which suits you best?` };
}

export type BookingOutcome =
  | { status: "confirmed"; appointment_id: string; start: string; label: string; designer_name: string | null; email_will_be_sent: boolean; say: string }
  | { status: "conflict"; alternatives: (Slot & { designer_name: string })[]; say: string }
  | { status: "failed"; say: string };

export async function bookLive(deps: LiveDeps, input: z.infer<typeof BookConsultationSchema>): Promise<BookingOutcome> {
  const { store } = deps;
  const call = await ensureLiveCall(deps, input.call_id, input.caller_phone);
  let lead = await eligibleLeadFor(deps, call);
  const config = await loadBookingConfig(store);
  const key = input.idempotency_key ?? `book:${call.id}:${input.slot_start}:${input.designer_id}`;

  // Idempotent replay: the same request returns the same outcome.
  const prior = await store.getAppointmentByIdempotencyKey(key);
  if (prior?.status === "confirmed") return confirmedOutcome(deps, prior.id);

  const existing = await store.getLiveAppointmentForLead(lead.id);
  if (existing?.status === "confirmed") return confirmedOutcome(deps, existing.id);

  const designer = await store.getDesigner(input.designer_id);
  if (!designer || !designer.active || !designer.booking_enabled || !designer.calendar_id) {
    return { status: "failed", say: "I'm sorry, I couldn't book that slot. Let me check other times for you." };
  }
  const start = new Date(input.slot_start);
  const end = new Date(start.getTime() + config.durationMinutes * 60_000);
  if (start.getTime() < deps.now().getTime() + config.minNoticeHours * 3600_000) {
    return conflict(deps, call, "That time is too soon for a consultation.");
  }

  const email = normaliseEmail(input.email);
  if (input.name || email) lead = await store.updateLead(lead.id, { ...(input.name ? { name: input.name } : {}), ...(email ? { email } : {}) });

  let cal: CalendarApi;
  try {
    cal = await deps.calendarFor(designer);
    // Revalidate immediately before writing.
    const fb = await cal.freeBusy([designer.calendar_id], new Date(start.getTime() - 86400_000).toISOString(), new Date(end.getTime() + 86400_000).toISOString());
    if (!isSlotFree(fb[designer.calendar_id] ?? [], start, end, config.bufferMinutes)) return conflict(deps, call, "That slot has just been taken.");
  } catch (e) {
    return calendarFailure(deps, call, lead, e);
  }

  let appt;
  try {
    appt = await store.insertAppointment({
      lead_id: lead.id,
      call_id: call.id,
      designer_id: designer.id,
      provider_calendar_id: designer.calendar_id,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      timezone: config.timezone,
      meeting_type: config.meetingType,
      status: "pending",
      idempotency_key: key,
      is_test: call.is_test,
    });
  } catch (e) {
    if (e instanceof OverlapError) return conflict(deps, call, "That slot has just been taken.");
    throw e;
  }
  if (appt.status === "confirmed") return confirmedOutcome(deps, appt.id);

  try {
    const ev = await cal.insertEvent(designer.calendar_id, {
      id: eventIdFor(appt.id),
      summary: `Aangan consultation — ${lead.name ?? "New client"}${lead.locality ? ` (${lead.locality})` : ""}`,
      description: [
        lead.project_type && `Project: ${lead.project_type}`,
        lead.project_scope && `Scope: ${lead.project_scope}`,
        lead.location && `Location: ${lead.location}`,
        lead.phone_normalized && `Phone: ${lead.phone_normalized}`,
        `Qualification: ${lead.qualification_status.toUpperCase()}`,
        "Full brief and call summary are on the HubSpot deal.",
      ]
        .filter(Boolean)
        .join("\n"),
      start: start.toISOString(),
      end: end.toISOString(),
      timezone: config.timezone,
      location: config.meetingType === "site_visit" ? lead.location : null,
      attendee: { name: lead.name, email: lead.email, phone: lead.phone_normalized },
    });
    appt = await store.updateAppointment(appt.id, { status: "confirmed", provider_event_id: ev.id });
  } catch (e) {
    await store.updateAppointment(appt.id, { status: "failed", failure_reason: safeErrorMessage(e) });
    return calendarFailure(deps, call, lead, e);
  }
  await store.recordIntegrationHealth(deps.calendarProvider ?? "google_calendar", true, "events.insert");

  await store.addLeadEvent({ lead_id: lead.id, call_id: call.id, event_type: "booked", dedupe_key: `appt:${appt.id}`, metadata: { designer_id: designer.id, start: appt.start_at }, is_test: lead.is_test });
  await store.updateLead(lead.id, { assigned_designer_id: designer.id, hubspot_sync_status: "pending" });

  const emailPossible = !!lead.email;
  await store.updateAppointment(appt.id, { confirmation_email_status: emailPossible ? "queued" : "not_possible" });
  await store.enqueueJob("send_confirmation_email", { appointment_id: appt.id }, `email:${appt.id}`);
  // Designer handoff: the assigned designer gets the full brief straight away.
  await store.enqueueJob("designer_handoff", { lead_id: lead.id, appointment_id: appt.id }, `handoff:${lead.id}:${appt.id}`);
  // Test fixtures (smoke tests) never reach the real CRM.
  if (!lead.is_test) await store.enqueueJob("hubspot_sync_lead", { lead_id: lead.id, reason: "booked" }, `hubspot:${lead.id}:booked:${appt.id}`);
  deps.kick?.();
  return confirmedOutcome(deps, appt.id);
}

async function confirmedOutcome(deps: LiveDeps, appointmentId: string): Promise<BookingOutcome> {
  const appt = (await deps.store.getAppointment(appointmentId))!;
  const lead = await deps.store.getLead(appt.lead_id);
  const designer = appt.designer_id ? await deps.store.getDesigner(appt.designer_id) : null;
  const label = formatSlotLabel(appt.start_at, appt.timezone);
  const emailWillBeSent = !!lead?.email && appt.confirmation_email_status !== "not_possible";
  return {
    status: "confirmed",
    appointment_id: appt.id,
    start: appt.start_at,
    label,
    designer_name: designer?.name ?? null,
    email_will_be_sent: emailWillBeSent,
    say: `You're booked for ${label}${designer ? ` with ${designer.name}` : ""}.${emailWillBeSent ? " You'll receive a confirmation email shortly." : ""}`,
  };
}

async function conflict(deps: LiveDeps, call: CallRow, why: string): Promise<BookingOutcome> {
  const alt = await availabilityLive(deps, { call_id: call.provider_call_id!, caller_phone: call.caller_phone });
  if (!alt.slots.length) return { status: "failed", say: `${why} I'll ask the team to call you to arrange a time.` };
  return { status: "conflict", alternatives: alt.slots, say: `${why} I can offer ${alt.slots.map((s) => s.label).join(", or ")} instead.` };
}

async function calendarFailure(deps: LiveDeps, call: CallRow, lead: LeadRow, e: unknown): Promise<BookingOutcome> {
  await deps.store.recordIntegrationHealth(deps.calendarProvider ?? "google_calendar", false, "booking", safeErrorMessage(e));
  await deps.store.upsertException({
    kind: "calendar_failure",
    title: `Consultation not booked for ${lead.name ?? "caller"} — calendar error`,
    detail: safeErrorMessage(e),
    call_id: call.id,
    lead_id: lead.id,
    severity: "high",
    retryable: false,
    dedupe_key: `calendar-failure:${lead.id}`,
    is_test: lead.is_test,
  });
  return { status: "failed", say: "I'm sorry, I couldn't complete the booking just now. I've noted your details and the team will call you to confirm a time." };
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

export async function escalateLive(deps: LiveDeps, input: z.infer<typeof EscalateSchema>) {
  const call = await ensureLiveCall(deps, input.call_id, input.caller_phone);
  const policy = await loadEscalationPolicy(deps.store);
  const callType = input.type === "complaint" ? "existing_project_complaint" : input.type === "follow_up" ? "existing_lead_follow_up" : "callback_request";
  const phone = normalisePhone(input.callback_phone) ?? call.caller_phone_normalized;
  await deps.store.updateCall(call.id, {
    call_type: callType,
    intake: { ...call.intake, escalation: { name: input.name, callback_phone: phone, issue: input.issue, designer_name: input.designer_name, project_location: input.project_location } },
  });
  const due = input.type === "complaint" && policy.complaintCallbackMinutes ? new Date(deps.now().getTime() + policy.complaintCallbackMinutes * 60_000).toISOString() : null;
  const exceptionId = await deps.store.upsertException({
    kind: input.type === "complaint" ? "complaint" : "follow_up_required",
    title: input.type === "complaint" ? `Complaint: ${input.name ?? "existing client"}${input.project_location ? `, ${input.project_location}` : ""}` : `Callback requested: ${input.name ?? "caller"}`,
    detail: `${input.issue}${input.designer_name ? ` (designer: ${input.designer_name})` : ""}`,
    call_id: call.id,
    severity: input.type === "complaint" ? "critical" : "normal",
    due_at: due,
    dedupe_key: `escalation:${call.id}:${input.type}`,
    is_test: call.is_test,
  });
  if (input.type === "complaint" && policy.notifyEmails.length) {
    await deps.store.enqueueJob("notify_escalation", { exception_id: exceptionId }, `notify:${exceptionId}`);
    deps.kick?.();
  }
  const callbackPromise = due && policy.complaintCallbackMinutes ? `within ${policy.complaintCallbackMinutes} minutes` : null;
  return {
    ok: true,
    priority: input.type === "complaint" ? "critical" : "normal",
    callback_promise: callbackPromise,
    say: callbackPromise
      ? `I've passed this to our senior team as a priority. Someone will call you back ${callbackPromise}.`
      : "I've passed this to our team as a priority, and the right person will get back to you.",
  };
}

// ---------------------------------------------------------------------------
// Messages for the team
// ---------------------------------------------------------------------------

export async function takeMessageLive(deps: LiveDeps, input: z.infer<typeof TakeMessageSchema>) {
  const call = await ensureLiveCall(deps, input.call_id, input.caller_phone);
  if (call.call_type === "unknown") await deps.store.updateCall(call.id, { call_type: input.message_type === "project_update" ? "existing_project_complaint" : "callback_request" });
  const r = await recordTeamMessage(deps.store, {
    call_id: call.id,
    caller_name: input.name ?? null,
    caller_phone: input.callback_phone ?? call.caller_phone_normalized ?? call.caller_phone,
    message_type: input.message_type,
    for_name: input.for_name ?? null,
    about: input.about,
    callback_window: input.callback_window ?? null,
    dedupe_key: `call:${call.id}:${input.for_name ?? "team"}`,
    is_test: call.is_test,
  });
  deps.kick?.();
  return {
    ok: true,
    routed_to: r.designer?.name ?? null,
    say: r.designer
      ? `I've passed your message to ${r.designer.name}, who will call you back as soon as possible.`
      : "I've passed your message to the team, and the right person will call you back as soon as possible.",
  };
}
