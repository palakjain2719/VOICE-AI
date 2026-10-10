import "server-only";
import { randomUUID } from "node:crypto";
import { gemini } from "@/integrations/gemini/client";
import { extractCall } from "@/integrations/gemini/tasks";
import { log, safeErrorMessage } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/server";
import { store } from "@/server/store/supabase-store";
import { liveDeps, processJobs } from "@/server/runtime";
import { applyExtraction } from "@/server/services/post-call";
import { handleTurn, startConversation, type ConversationState } from "@/server/services/conversation";
import type { LiveDeps } from "@/server/services/live-call";

/**
 * Test calls from the in-app console. Same engine and services as a live call, but stored as test
 * fixtures (provider "web_test", is_test) so they never count in live metrics unless a viewer
 * explicitly includes test calls.
 */
export const TEST_PROVIDER = "web_test";

function deps(): LiveDeps {
  return { ...liveDeps(), provider: TEST_PROVIDER, isTest: true };
}

export async function startTestCall() {
  const callId = `test-${randomUUID()}`;
  const { state } = await startConversation(deps(), callId);
  return { callId, state };
}

async function loadState(callId: string) {
  const call = await store().getCallByProviderId(TEST_PROVIDER, callId);
  if (!call) return null;
  return { call, state: (call.intake as { conversation?: ConversationState }).conversation ?? null };
}

export async function testCallTurn(callId: string, text: string) {
  const loaded = await loadState(callId);
  if (!loaded?.state) throw new Error("Unknown test call");
  if (loaded.state.stage === "closed") return { say: "This call has ended.", state: loaded.state, done: true };
  const r = await handleTurn({ live: deps(), model: gemini(), finalize }, callId, loaded.state, text);
  const fresh = await store().getCall(loaded.call.id);
  await store().updateCall(loaded.call.id, { intake: { ...(fresh?.intake ?? {}), conversation: r.state } });
  return r;
}

/** End of call: transcript, status, Gemini summary, then run the outputs (email, HubSpot, designer brief). */
async function finalize(callId: string, state: ConversationState) {
  const s = store();
  const call = await s.getCallByProviderId(TEST_PROVIDER, callId);
  if (!call) return;
  const transcript = state.turns.map((t) => `${t.role === "agent" ? "Agent" : "Caller"}: ${t.text}`).join("\n");
  const started = Date.parse(state.turns[0]?.at ?? new Date().toISOString());
  const ended = Date.now();
  await s.saveTranscript(call.id, transcript, state.turns, "test_console");
  const updated = await s.updateCall(call.id, {
    status: "completed", answered: true, ended_at: new Date(ended).toISOString(), duration_seconds: Math.round((ended - started) / 1000),
    started_at: new Date(started).toISOString(), intake: { ...call.intake, conversation: state },
  });
  try {
    const { data } = await extractCall(gemini(), transcript, new Date(started).toISOString());
    // Complaints and messages were already handled live; the summary and any unanswered questions are what's added here.
    await applyExtraction({ store: s, now: () => new Date() }, updated, { ...data, complaint: null, message: null });
    await s.updateCall(call.id, { processing_status: "processed" });
  } catch (e) {
    log.warn("test_call.summary_failed", { error: safeErrorMessage(e) });
  }
  await processJobs({ limit: 10 }).catch((e) => log.warn("test_call.jobs_failed", { error: safeErrorMessage(e) }));
}

/** What the call produced downstream — the "Outputs" and "Backend" columns of the flow map. */
export async function testCallOutputs(callId: string) {
  const db = createAdminClient();
  const call = await store().getCallByProviderId(TEST_PROVIDER, callId);
  if (!call) return null;
  const lead = call.lead_id ? await store().getLead(call.lead_id) : null;
  const [{ data: appts }, { data: exceptions }, { data: messages }, transcript] = await Promise.all([
    lead ? db.from("appointments").select("id, status, start_at, confirmation_email_status, provider_event_id, designers(name)").eq("lead_id", lead.id) : Promise.resolve({ data: [] }),
    db.from("exceptions").select("id, kind, title, lane, status").eq("call_id", call.id),
    db.from("team_messages").select("id, for_name, delivered_via, designers(name)").eq("call_id", call.id),
    store().getTranscript(call.id),
  ]);
  const apptIds = (appts ?? []).map((a) => a.id);
  const keys = [lead && `hubspot:${lead.id}%`, ...apptIds.map((id) => `email:${id}`), lead && `handoff:${lead.id}%`].filter(Boolean) as string[];
  const jobs = [];
  for (const k of keys) {
    const { data } = await db.from("jobs").select("type, status, attempts, last_error").like("idempotency_key", k);
    jobs.push(...(data ?? []));
  }
  return {
    call: { id: call.id, status: call.status, duration: call.duration_seconds, summary: call.summary, hasTranscript: !!transcript?.transcript },
    lead: lead && { id: lead.id, status: lead.qualification_status, hubspot: lead.hubspot_sync_status, handoffAt: lead.handoff_at ?? null, uncertainties: lead.uncertainties },
    appointments: appts ?? [],
    exceptions: exceptions ?? [],
    messages: messages ?? [],
    jobs,
  };
}
