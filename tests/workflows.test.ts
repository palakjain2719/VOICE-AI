import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore, type MemoryStore } from "./support/memory-store";
import type { CalendarApi, CalendarEventInput } from "@/integrations/google/calendar";
import { GoogleAuthError } from "@/integrations/google/calendar";
import type { Interval } from "@/domain/booking/slots";
import { availabilityLive, bookLive, BookingRefused, ensureLiveCall, escalateLive, evaluateLive, answerLive, type LiveDeps } from "@/server/services/live-call";
import { processVaaniEvent } from "@/server/services/post-call";
import { sendConsultationConfirmation, RetryableError } from "@/server/services/confirmation";
import { runJobs } from "@/server/services/jobs";
import { EmailError, type EmailSender } from "@/integrations/resend/email";
import type { CallExtraction } from "@/integrations/gemini/tasks";
import { LeadFactsSchema } from "@/domain/qualification/types";
import { PRICING_DEFLECTION } from "@/domain/pricing/guard";

const NOW = new Date("2026-10-12T05:30:00Z"); // Monday 11:00 IST

function fakeCalendar(busy: Interval[] = []) {
  const events = new Map<string, CalendarEventInput>();
  const cal: CalendarApi & { events: typeof events; busy: Interval[] } = {
    events,
    busy,
    async freeBusy(ids) {
      return Object.fromEntries(ids.map((id) => [id, [...cal.busy, ...[...events.values()].map((e) => ({ start: new Date(e.start), end: new Date(e.end) }))]]));
    },
    async insertEvent(_cal, ev) {
      const existed = events.has(ev.id);
      events.set(ev.id, ev);
      return { id: ev.id, htmlLink: null, alreadyExisted: existed };
    },
    async cancelEvent(_c, id) {
      events.delete(id);
    },
    async listCalendars() {
      return [];
    },
  };
  return cal;
}

const qualifiedFacts = {
  intent: "design_and_execution" as const,
  segment: "residential" as const,
  propertyType: "apartment" as const,
  scopeKind: "full_home" as const,
  executionIncluded: true,
  locationText: "Aundh",
  requiredCompletionDate: "2027-03-31",
  decisionMaker: "self" as const,
};

let m: MemoryStore;
let cal: ReturnType<typeof fakeCalendar>;
let deps: LiveDeps;
let designerId: string;

beforeEach(() => {
  m = memoryStore();
  cal = fakeCalendar();
  designerId = m.addDesigner().id;
  deps = { store: m.store, now: () => NOW, calendarFor: async () => cal };
});

async function qualify(callId = "vaani-call-1", phone = "+91 98220 12345", email = "pooja@example.com") {
  return evaluateLive(deps, { call_id: callId, caller_phone: phone, name: "Pooja Rao", email, facts: qualifiedFacts, clarifications_asked: [] });
}

describe("live call: qualification", () => {
  it("records a GREEN evaluation, creates one lead and a 'qualified' funnel event", async () => {
    const r = await qualify();
    expect(r).toMatchObject({ status: "green", eligible_for_booking: true });
    expect(m.leads.size).toBe(1);
    expect(m.events.filter((e) => e.event_type === "qualified")).toHaveLength(1);
    expect(m.quals[0]).toMatchObject({ status: "green", evaluated_by: "rules_engine:live" });
  });

  it("returns the approved closure text for RED and never makes the lead bookable", async () => {
    const r = await evaluateLive(deps, { call_id: "c-red", caller_phone: null, facts: { ...qualifiedFacts, locationText: "Nashik" }, clarifications_asked: [] });
    expect(r.status).toBe("red");
    expect(r.closure_text).toMatch(/only work in Pune city and PCMC/);
    await expect(availabilityLive(deps, { call_id: "c-red" })).rejects.toBeInstanceOf(BookingRefused);
  });

  it("asks a clarifying question without recording a terminal outcome", async () => {
    const r = await evaluateLive(deps, { call_id: "c-q", caller_phone: null, facts: { ...qualifiedFacts, locationText: null }, clarifications_asked: [] });
    expect(r.status).toBe("needs_clarification");
    expect(r.next_question).toMatch(/Pune city or PCMC/);
    expect(m.quals).toHaveLength(0);
  });

  it("routes unresolved essentials to the human review queue", async () => {
    await evaluateLive(deps, { call_id: "c-rv", caller_phone: null, facts: { ...qualifiedFacts, locationText: null }, clarifications_asked: ["service_area"] });
    expect([...m.exceptions.values()].some((e) => e.kind === "ambiguous_qualification")).toBe(true);
  });
});

describe("live call: pricing and unknown questions", () => {
  it("deflects repeated pricing questions and records each as a policy event", async () => {
    for (const q of ["How much for a 2BHK?", "Even a rough range?", "What's your per sq ft rate?"]) {
      const r = await answerLive(deps, { call_id: "c-price", caller_phone: null, question: q });
      expect(r.say).toBe(PRICING_DEFLECTION);
    }
    expect(m.policy.filter((p) => p.kind === "pricing_request_deflected")).toHaveLength(3);
  });

  it("logs an unanswered question once, counts repeats, and raises one review item", async () => {
    await answerLive(deps, { call_id: "c-u1", caller_phone: null, question: "Do you work on Sundays?" });
    await answerLive(deps, { call_id: "c-u2", caller_phone: null, question: "Do you work on Sundays?" });
    expect(m.unanswered.size).toBe(1);
    expect([...m.unanswered.values()][0].occurrences).toBe(2);
    expect([...m.exceptions.values()].filter((e) => e.kind === "unanswered_question")).toHaveLength(1);
  });
});

describe("live call: availability and booking", () => {
  it("offers only real free slots, inside working hours, after the notice period", async () => {
    await qualify();
    cal.busy = [{ start: new Date("2026-10-13T04:30:00Z"), end: new Date("2026-10-13T13:30:00Z") }]; // Tue fully busy (IST 10:00–19:00)
    const r = await availabilityLive(deps, { call_id: "vaani-call-1" });
    expect(r.status).toBe("ok");
    expect(r.slots.length).toBeGreaterThan(0);
    for (const s of r.slots) {
      expect(new Date(s.start).getTime()).toBeGreaterThan(NOW.getTime() + 18 * 3600_000);
      expect(s.start.startsWith("2026-10-13")).toBe(false);
      expect(s.designerId).toBe(designerId);
    }
  });

  it("books, confirms only after the calendar write, queues email + HubSpot, and is idempotent", async () => {
    await qualify();
    const { slots } = await availabilityLive(deps, { call_id: "vaani-call-1" });
    const input = { call_id: "vaani-call-1", slot_start: slots[0].start, designer_id: designerId, email: "pooja@example.com", idempotency_key: "idem-1234" };
    const r = await bookLive(deps, input);
    expect(r.status).toBe("confirmed");
    expect(cal.events.size).toBe(1);
    const appt = [...m.appts.values()][0];
    expect(appt.status).toBe("confirmed");
    expect(appt.provider_event_id).toBe([...cal.events.keys()][0]);
    expect([...m.jobs.values()].map((j) => j.type).sort()).toEqual(["designer_handoff", "hubspot_sync_lead", "send_confirmation_email"]);
    expect(m.events.filter((e) => e.event_type === "booked")).toHaveLength(1);

    const again = await bookLive(deps, input);
    expect(again.status).toBe("confirmed");
    expect(m.appts.size).toBe(1);
    expect(cal.events.size).toBe(1);
    expect(m.jobs.size).toBe(3);
  });

  it("revalidates before writing: a slot taken meanwhile returns alternatives and creates nothing", async () => {
    await qualify();
    const { slots } = await availabilityLive(deps, { call_id: "vaani-call-1" });
    cal.busy = [{ start: new Date(slots[0].start), end: new Date(slots[0].end) }];
    const r = await bookLive(deps, { call_id: "vaani-call-1", slot_start: slots[0].start, designer_id: designerId });
    expect(r.status).toBe("conflict");
    if (r.status === "conflict") expect(r.alternatives.every((a) => a.start !== slots[0].start)).toBe(true);
    expect(m.appts.size).toBe(0);
    expect(cal.events.size).toBe(0);
  });

  it("prevents double-booking a designer across two leads", async () => {
    await qualify("call-A", "+919822000001", "a@example.com");
    await qualify("call-B", "+919822000002", "b@example.com");
    expect(m.leads.size).toBe(2);
    const { slots } = await availabilityLive(deps, { call_id: "call-A" });
    const a = await bookLive(deps, { call_id: "call-A", slot_start: slots[0].start, designer_id: designerId });
    const b = await bookLive(deps, { call_id: "call-B", slot_start: slots[0].start, designer_id: designerId });
    expect(a.status).toBe("confirmed");
    expect(b.status).not.toBe("confirmed");
    expect([...m.appts.values()].filter((x) => x.status === "confirmed")).toHaveLength(1);
  });

  it("calendar authorisation failure: no booking claimed, high-priority exception raised", async () => {
    await qualify();
    const { slots } = await availabilityLive(deps, { call_id: "vaani-call-1" });
    deps.calendarFor = async () => {
      throw new GoogleAuthError("Calendar authorisation expired or was revoked; reconnect required");
    };
    const r = await bookLive(deps, { call_id: "vaani-call-1", slot_start: slots[0].start, designer_id: designerId });
    expect(r.status).toBe("failed");
    expect(r.say).not.toMatch(/booked/i);
    expect([...m.exceptions.values()].some((e) => e.kind === "calendar_failure")).toBe(true);
  });

  it("refuses to book an enquiry that hasn't qualified", async () => {
    await ensureLiveCall(deps, "c-none", null);
    await expect(bookLive(deps, { call_id: "c-none", slot_start: "2026-10-14T05:00:00Z", designer_id: designerId })).rejects.toBeInstanceOf(BookingRefused);
  });
});

describe("confirmation email", () => {
  async function booked(email: string | null = "pooja@example.com") {
    await evaluateLive(deps, { call_id: "c-e", caller_phone: "+919822000009", name: "Pooja", email, facts: qualifiedFacts, clarifications_asked: [] });
    const { slots } = await availabilityLive(deps, { call_id: "c-e" });
    const r = await bookLive(deps, { call_id: "c-e", slot_start: slots[0].start, designer_id: designerId });
    if (r.status !== "confirmed") throw new Error("expected booking");
    return r.appointment_id;
  }

  it("sends once with an idempotency key and records the provider id", async () => {
    const id = await booked();
    const sender: EmailSender = { send: vi.fn(async () => ({ id: "re_1" })) };
    expect(await sendConsultationConfirmation({ store: m.store, sender }, id)).toBe("sent");
    expect(await sendConsultationConfirmation({ store: m.store, sender }, id)).toBe("already_sent");
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sender.send).mock.calls[0][0]).toMatchObject({ to: "pooja@example.com", idempotencyKey: `confirmation-${id}` });
    expect(m.appts.get(id)!.confirmation_email_status).toBe("sent");
  });

  it("email failure keeps the booking, marks the email failed, raises a retryable item", async () => {
    const id = await booked();
    const sender: EmailSender = { send: async () => { throw new EmailError(503, "Resend 503", true); } };
    await expect(sendConsultationConfirmation({ store: m.store, sender }, id)).rejects.toBeInstanceOf(RetryableError);
    expect(m.appts.get(id)!.status).toBe("confirmed");
    expect(m.appts.get(id)!.confirmation_email_status).toBe("failed");
    const ex = [...m.exceptions.values()].find((e) => e.kind === "email_failure")!;
    expect(ex.retryable).toBe(true);
    expect(cal.events.size).toBe(1); // never re-booked
  });

  it("no email collected: never claims an email, creates a phone-confirmation task", async () => {
    const id = await booked(null);
    expect(await sendConsultationConfirmation({ store: m.store, sender: { send: vi.fn() } }, id)).toBe("not_possible");
    expect(m.appts.get(id)!.confirmation_email_status).toBe("not_possible");
    expect([...m.exceptions.values()].some((e) => e.kind === "missing_information")).toBe(true);
  });

  it("job runner retries with backoff and eventually raises an exception", async () => {
    const id = await booked();
    let calls = 0;
    const handlers = { send_confirmation_email: async () => { calls++; await sendConsultationConfirmation({ store: m.store, sender: { send: async () => { throw new EmailError(500, "x", true); } } }, id); } };
    const r = await runJobs(m.store, handlers, { types: ["send_confirmation_email"] });
    expect(r[0].ok).toBe(false);
    const job = [...m.jobs.values()].find((j) => j.type === "send_confirmation_email")!;
    expect(job.status).toBe("failed");
    expect(new Date(job.run_after).getTime()).toBeGreaterThan(Date.now());
    expect(calls).toBe(1);
  });
});

describe("escalations", () => {
  it("complaint: priority exception, no sales lead, no callback promise without a policy", async () => {
    const r = await escalateLive(deps, { call_id: "c-comp", caller_phone: null, type: "complaint", name: "Sheetal Deshpande", issue: "Designer hasn't replied in five days", designer_name: "Aryan", project_location: "Viman Nagar" });
    expect(r.callback_promise).toBeNull();
    expect(r.say).not.toMatch(/minutes/);
    expect(m.leads.size).toBe(0);
    const ex = [...m.exceptions.values()].find((e) => e.kind === "complaint")!;
    expect(ex.severity).toBe("critical");
    expect([...m.calls.values()][0].call_type).toBe("existing_project_complaint");
  });

  it("promises a callback time only when the escalation policy defines one", async () => {
    m.settings.set("escalation_policy", { complaintCallbackMinutes: 15, notifyEmails: ["nikhil@example.com"] });
    const r = await escalateLive(deps, { call_id: "c-comp2", caller_phone: null, type: "complaint", issue: "Site work stopped" });
    expect(r.callback_promise).toBe("within 15 minutes");
    expect([...m.exceptions.values()][0].due_at).toBeTruthy();
    expect([...m.jobs.values()].some((j) => j.type === "notify_escalation")).toBe(true);
  });
});

describe("post-call processing (Vaani webhook)", () => {
  const envelope = (type: string, data: Record<string, unknown>, id = "evt_1") => ({ id, type, created: Math.floor(NOW.getTime() / 1000), data });
  const extraction = (over: Partial<CallExtraction> = {}): CallExtraction => ({
    callType: "new_enquiry",
    contact: { name: "Ritu Kapoor", callbackPhone: "9822012345", email: null },
    facts: LeadFactsSchema.parse({ ...qualifiedFacts, locationText: "Pimple Saudagar" }),
    projectTypeLabel: "3BHK full home",
    scopeSummary: "Kitchen, wardrobes, living room",
    currentPropertyState: "Builder furniture",
    clarificationsAsked: [],
    pricingRequested: false,
    unansweredQuestions: [],
    complaint: null,
    message: null,
    summary: "Caller wants a full redesign of a 3BHK in Pimple Saudagar by March.",
    ...over,
  });

  it("stores the call + transcript, qualifies, queues HubSpot, and flags the missing live booking", async () => {
    const extract = vi.fn(async () => ({ data: extraction(), usage: { model: "m", promptTokens: 1, outputTokens: 1 } }));
    const r = await processVaaniEvent({ store: m.store, now: () => NOW, extract }, envelope("call.completed", { call_id: "v-77", duration_seconds: 270, transcript: [{ role: "assistant", text: "Hello" }, { role: "user", text: "Hi, I'm Ritu" }] }), "ie-1");
    expect(r.outcome).toBe("processed");
    const call = [...m.calls.values()][0];
    expect(call).toMatchObject({ status: "completed", answered: true, processing_status: "processed", summary: expect.stringContaining("Pimple Saudagar") });
    expect(m.transcripts.get(call.id)?.transcript).toContain("Caller: Hi, I'm Ritu");
    expect([...m.leads.values()][0].qualification_status).toBe("green");
    expect([...m.jobs.values()].some((j) => j.type === "hubspot_sync_lead")).toBe(true);
    expect([...m.exceptions.values()].some((e) => e.kind === "booking_not_completed")).toBe(true);
    expect(m.appts.size).toBe(0); // never books from a webhook
  });

  it("a live evaluation stays authoritative over post-call extraction", async () => {
    await evaluateLive(deps, { call_id: "v-live", caller_phone: null, facts: { ...qualifiedFacts, locationText: "Nashik" }, clarifications_asked: [] });
    const extract = async () => ({ data: extraction(), usage: { model: "m", promptTokens: 1, outputTokens: 1 } });
    await processVaaniEvent({ store: m.store, now: () => NOW, extract }, envelope("call.completed", { call_id: "v-live", duration_seconds: 200, transcript: "Agent: hi\nCaller: hello" }), "ie-2");
    expect(m.quals).toHaveLength(1);
    expect([...m.leads.values()][0].qualification_status).toBe("red");
    expect([...m.jobs.values()].some((j) => j.type === "hubspot_sync_lead")).toBe(false);
  });

  it("an existing-client complaint never enters the sales funnel", async () => {
    const extract = async () => ({ data: extraction({ callType: "existing_project_complaint", complaint: { issue: "No reply in 5 days", designerName: "Aryan", projectLocation: "Viman Nagar" } }), usage: { model: "m", promptTokens: 1, outputTokens: 1 } });
    await processVaaniEvent({ store: m.store, now: () => NOW, extract }, envelope("call.completed", { call_id: "v-c", duration_seconds: 352, transcript: "Caller: I need to speak to someone" }), "ie-3");
    expect(m.leads.size).toBe(0);
    expect(m.events.filter((e) => e.event_type === "qualified")).toHaveLength(0);
    expect([...m.exceptions.values()].find((e) => e.kind === "complaint")?.severity).toBe("critical");
  });

  it("detects a price disclosure in the agent's own words", async () => {
    await processVaaniEvent({ store: m.store, now: () => NOW }, envelope("call.completed", { call_id: "v-p", duration_seconds: 100, transcript: [{ role: "agent", text: "For a 2BHK it's typically 12 lakh." }, { role: "caller", text: "My budget is 1.5 lakh" }] }), "ie-4");
    expect(m.policy.some((p) => p.kind === "pricing_disclosure_detected")).toBe(true);
    expect([...m.exceptions.values()].find((e) => e.kind === "pricing_violation")?.severity).toBe("critical");
  });

  it("caller budgets alone don't trigger a violation", async () => {
    await processVaaniEvent({ store: m.store, now: () => NOW }, envelope("call.completed", { call_id: "v-b", duration_seconds: 100, transcript: [{ role: "agent", text: PRICING_DEFLECTION }, { role: "caller", text: "My budget is 1 to 1.5 lakh" }] }), "ie-5");
    expect(m.policy.some((p) => p.kind === "pricing_disclosure_detected")).toBe(false);
  });

  it("T17: a dropped call followed by a reconnect links calls, reuses the lead and raises no failed-call item", async () => {
    const t0 = new Date("2026-09-22T08:44:00Z");
    const d1: LiveDeps = { ...deps, now: () => t0 };
    const first = await ensureLiveCall(d1, "drop-1", "+919822033333");
    const d2: LiveDeps = { ...deps, now: () => new Date(t0.getTime() + 2 * 60_000) };
    const second = await ensureLiveCall(d2, "drop-2", "+919822033333");
    expect(second.related_call_id).toBe(first.id);
    await evaluateLive(d2, { call_id: "drop-2", caller_phone: "+919822033333", facts: qualifiedFacts, clarifications_asked: [] });
    expect(m.leads.size).toBe(1);
    await processVaaniEvent({ store: m.store, now: () => t0 }, envelope("call.completed", { call_id: "drop-1", duration_seconds: 12, caller_phone: "+919822033333", started_at: t0.toISOString() }, "evt_drop"), "ie-6");
    expect(m.calls.get(first.id)!.status).toBe("disconnected");
    expect([...m.exceptions.values()].some((e) => e.kind === "failed_call")).toBe(false);
  });

  it("call.failed without a reconnect raises a follow-up item and is never counted as answered", async () => {
    await processVaaniEvent({ store: m.store, now: () => NOW }, envelope("call.failed", { call_id: "v-f", error: "TTS pipeline error" }), "ie-7");
    const call = [...m.calls.values()][0];
    expect(call.status).toBe("failed");
    expect(call.answered).toBe(false);
    expect([...m.exceptions.values()].some((e) => e.kind === "failed_call")).toBe(true);
  });

  it("usage.charged records a provider-reported (not estimated) cost, once", async () => {
    const env = envelope("usage.charged", { cost_paise: 1240, surface: "voicebot", duration_seconds: 300 }, "evt_cost");
    await processVaaniEvent({ store: m.store, now: () => NOW }, env, "ie-8");
    await processVaaniEvent({ store: m.store, now: () => NOW }, env, "ie-8");
    expect(m.costs).toHaveLength(1);
    expect(m.costs[0]).toMatchObject({ provider: "vaani", cost_amount: 12.4, is_estimate: false });
  });

  it("signed smoke-test events are stored as test fixtures and never reach HubSpot", async () => {
    const extract = async () => ({ data: extraction(), usage: { model: "m", promptTokens: 1, outputTokens: 1 } });
    await processVaaniEvent({ store: m.store, now: () => NOW, extract }, envelope("call.completed", { call_id: "smoke-123", aangan_test: true, duration_seconds: 200, transcript: "Caller: hi" }, "evt_smoke"), "ie-s");
    const call = [...m.calls.values()][0];
    expect(call).toMatchObject({ is_test: true, production_call: false });
    expect([...m.leads.values()][0].is_test).toBe(true);
    expect([...m.jobs.values()].some((j) => j.type === "hubspot_sync_lead")).toBe(false);
    // The flag is ignored on a normal call id.
    await processVaaniEvent({ store: m.store, now: () => NOW }, envelope("call.completed", { call_id: "real-1", aangan_test: true, duration_seconds: 200 }, "evt_real"), "ie-r");
    expect([...m.calls.values()].find((c) => c.provider_call_id === "real-1")!.is_test).toBe(false);
  });

  it("without Gemini configured the call is stored and left pending for extraction, not guessed", async () => {
    const r = await processVaaniEvent({ store: m.store, now: () => NOW }, envelope("call.completed", { call_id: "v-ng", duration_seconds: 200, transcript: "Caller: hello" }), "ie-9");
    expect(r.outcome).toBe("stored_without_extraction");
    expect([...m.calls.values()][0].processing_status).toBe("pending");
    expect(m.leads.size).toBe(0);
  });
});
