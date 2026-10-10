import { describe, expect, it, vi } from "vitest";
import { memoryStore } from "./support/memory-store";
import { evaluate } from "@/domain/qualification/engine";
import { DEFAULT_QUALIFICATION_CONFIG as config } from "@/domain/qualification/config";
import { LeadFactsSchema } from "@/domain/qualification/types";
import { declineCategory, fitScore } from "@/domain/qualification/scoring";
import { numbersAreGrounded, summaryBullets } from "@/domain/metrics/summary";
import { decideException } from "@/server/services/review";
import { deliverTeamMessage, handoffToDesigner, recordTeamMessage } from "@/server/services/team";
import { evaluateLive, takeMessageLive, type LiveDeps } from "@/server/services/live-call";
import type { EmailSender } from "@/integrations/resend/email";

const home = { intent: "design_and_execution", segment: "residential", propertyType: "apartment", executionIncluded: true, decisionMaker: "self", timelineFlexible: true } as const;

describe("fit score and decline category", () => {
  it("scores 20 per pass and 10 per unclear", () => {
    expect(fitScore(evaluate({ facts: LeadFactsSchema.parse({ ...home, locationText: "Aundh" }), config }))).toBe(100);
    expect(fitScore(evaluate({ facts: LeadFactsSchema.parse({ ...home, locationText: "Aundh", decisionMaker: "unknown" }), config }))).toBe(90);
  });
  it("maps the first failed criterion to a decline reason", () => {
    const cat = (f: object) => declineCategory(evaluate({ facts: LeadFactsSchema.parse({ ...home, ...f }), config }));
    expect(cat({ locationText: "Nashik" })).toBe("area");
    expect(cat({ locationText: "Baner", propertyType: "restaurant", segment: "commercial" })).toBe("category");
    expect(cat({ locationText: "Baner", intent: "advice_only" })).toBe("engagement");
    expect(cat({ locationText: "Baner", budgetMentioned: true, budgetMaxInr: 100000 })).toBe("budget");
    expect(cat({ locationText: "Baner" })).toBeNull();
  });
});

describe("AI summary grounding", () => {
  const facts = {
    periodLabel: "the last 7 days",
    funnel: { incoming: 61, answered: 60, failed: 1, disconnected: 0, new_enquiries_answered: 55, new_enquiries_evaluated: 50, complaints: 3, green: 30, amber: 5, red: 15, needs_review: 4, qualified: 35, booked: 32, consultation_completed: 0, deal_opened: 0, won: 0, lost: 0 },
    afterHours: 61, calls: 61,
    pipeline: { weighted: 54_140_000, unweighted: 97_210_000, addedInPeriod: 97_210_000, openCount: 35 },
    topDecline: { label: "Category", n: 4 }, backlog: 10, oldestHours: 68,
  };
  it("builds bullets only from counted values, each with a link", () => {
    const b = summaryBullets(facts);
    expect(b.length).toBe(5);
    expect(b.every((x) => x.href.startsWith("/"))).toBe(true);
    expect(b[1].text).toContain("61 of 61 calls");
  });
  it("rejects reworded text that introduces a number not in the source", () => {
    expect(numbersAreGrounded("10 items wait; oldest is 68 hours", "Ten items, the oldest 68 hours old")).toBe(true);
    expect(numbersAreGrounded("10 items wait; oldest is 68 hours", "12 items wait")).toBe(false);
  });
  it("says so when there are no calls instead of inventing activity", () => {
    expect(summaryBullets({ ...facts, calls: 0 })[0].text).toMatch(/No live calls yet/);
  });
});

function setup() {
  const m = memoryStore();
  const deps: LiveDeps = { store: m.store, now: () => new Date("2026-10-12T05:30:00Z"), calendarFor: async () => { throw new Error("no calendar"); } };
  return { m, deps };
}

describe("review decisions", () => {
  async function reviewItem() {
    const { m, deps } = setup();
    await evaluateLive(deps, { call_id: "c-1", caller_phone: "+919822011111", name: "Rahul", email: "rahul@example.com", facts: { ...home, locationText: null }, clarifications_asked: ["service_area"] });
    const ex = [...m.exceptions.values()].find((e) => e.kind === "ambiguous_qualification")!;
    return { m, ex };
  }

  it("approve: lead becomes qualified by a person, goes to HubSpot, and a booking callback is created", async () => {
    const { m, ex } = await reviewItem();
    await decideException(m.store, { exceptionId: ex.id, decision: "approve", actorId: "user-1", note: "Area is Wagholi side of Kharadi — fine" });
    const lead = [...m.leads.values()][0];
    expect(lead.qualification_status).toBe("amber");
    expect(m.quals.at(-1)).toMatchObject({ evaluated_by: "human:user-1" });
    expect([...m.jobs.values()].some((j) => j.type === "hubspot_sync_lead")).toBe(true);
    expect([...m.exceptions.values()].find((e) => e.kind === "booking_not_completed")).toMatchObject({ lane: "callback" });
    expect(m.exceptions.get(ex.id)).toMatchObject({ status: "resolved", decision: "approved" });
    expect(m.audits.length).toBeGreaterThan(0);
  });

  it("reject: lead declined, closing email queued, no HubSpot sync", async () => {
    const { m, ex } = await reviewItem();
    await decideException(m.store, { exceptionId: ex.id, decision: "reject", actorId: "user-1" });
    expect([...m.leads.values()][0].qualification_status).toBe("red");
    expect([...m.jobs.values()].map((j) => j.type)).toEqual(["send_closure_email"]);
    expect(m.exceptions.get(ex.id)).toMatchObject({ status: "dismissed", decision: "rejected" });
  });

  it("route: moves the item to another lane and keeps it open", async () => {
    const { m, ex } = await reviewItem();
    await decideException(m.store, { exceptionId: ex.id, decision: "route_admin", actorId: "user-1" });
    expect(m.exceptions.get(ex.id)).toMatchObject({ lane: "admin", status: "open" });
    await expect(decideException(m.store, { exceptionId: "missing", decision: "approve", actorId: "u" })).rejects.toThrow(/not found/);
  });
});

describe("messages and designer handoff", () => {
  const sender = (): EmailSender => ({ send: vi.fn(async () => ({ id: "re_1" })) });

  it("take_message routes to a uniquely-named designer and queues delivery", async () => {
    const { m, deps } = setup();
    const rohan = m.addDesigner({ name: "Rohan Joshi", email: "rohan@example.com" });
    m.addDesigner({ name: "Asha Kulkarni" });
    const r = await takeMessageLive(deps, { call_id: "c-m", caller_phone: "+919822000004", name: "Meenal", message_type: "project_update", for_name: "Rohan", about: "Kitchen tile samples", callback_window: "today after 6 pm" });
    expect(r.routed_to).toBe("Rohan Joshi");
    const msg = [...m.messages.values()][0];
    expect(msg).toMatchObject({ for_designer_id: rohan.id, about: "Kitchen tile samples" });
    expect([...m.jobs.values()].some((j) => j.type === "notify_message")).toBe(true);
    const s = sender();
    expect(await deliverTeamMessage({ store: m.store, sender: s, appBaseUrl: null }, msg.id)).toBe("sent");
    expect(vi.mocked(s.send).mock.calls[0][0]).toMatchObject({ to: "rohan@example.com", idempotencyKey: `message-${msg.id}` });
  });

  it("ambiguous names are left for a person to route", async () => {
    const { m } = setup();
    m.addDesigner({ name: "Asha Kulkarni" });
    m.addDesigner({ name: "Asha Rao" });
    const r = await recordTeamMessage(m.store, { call_id: null, caller_name: "X", caller_phone: null, message_type: "designer_request", for_name: "Asha", about: "call me", callback_window: null, dedupe_key: "k" });
    expect(r.designer).toBeNull();
    expect(m.jobs.size).toBe(0);
  });

  it("designer handoff emails the brief once and records the handoff time", async () => {
    const { m, deps } = setup();
    const d = m.addDesigner({ email: "asha@example.com" });
    await evaluateLive(deps, { call_id: "c-h", caller_phone: "+919822022222", name: "Pooja", facts: { ...home, locationText: "Magarpatta" }, clarifications_asked: [] });
    const lead = [...m.leads.values()][0];
    await m.store.updateLead(lead.id, { assigned_designer_id: d.id, project_scope: "Kitchen, both bedrooms, living room" });
    const s = sender();
    expect(await handoffToDesigner({ store: m.store, sender: s, appBaseUrl: "https://app.test" }, lead.id, null)).toBe("sent");
    expect(await handoffToDesigner({ store: m.store, sender: s, appBaseUrl: "https://app.test" }, lead.id, null)).toBe("already");
    const body = vi.mocked(s.send).mock.calls[0][0].text;
    expect(body).toContain("Kitchen, both bedrooms, living room");
    expect(body).not.toMatch(/₹|lakh|per sq/i);
    expect(m.leads.get(lead.id)!.handoff_at).toBeTruthy();
  });
});
