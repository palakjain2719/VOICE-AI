import { describe, expect, it } from "vitest";
import { memoryStore } from "./support/memory-store";
import { handleTurn, inputSummary, newState, type Understanding } from "@/server/services/conversation";
import type { JsonModel } from "@/integrations/gemini/client";
import { PRICING_DEFLECTION } from "@/domain/pricing/guard";

const blank: Understanding = { intent: "unclear", facts: {}, name: null, phone: null, email: null, question: null, wantsBooking: null, slotChoice: null, complaintIssue: null, designerName: null, messageFor: null, messageAbout: null, callbackWindow: null, declined: false };

/** Fake model: returns scripted understandings in order. */
function scripted(...turns: Partial<Understanding>[]): JsonModel {
  let i = 0;
  return {
    async generateJson() { return { data: { ...blank, ...turns[i++] } as never, usage: { model: "fake", promptTokens: 0, outputTokens: 0 } }; },
    async generateText() { return { text: "", usage: { model: "fake", promptTokens: 0, outputTokens: 0 } }; },
  };
}

function deps(model: JsonModel) {
  const m = memoryStore();
  return { m, d: { live: { store: m.store, now: () => new Date("2026-10-12T05:30:00Z"), calendarFor: async () => { throw new Error("no calendar"); }, isTest: true }, model } };
}

describe("conversation engine", () => {
  it("declines an out-of-area enquiry on the first turn with the approved closure", async () => {
    const { m, d } = deps(scripted({ intent: "new_enquiry", facts: { intent: "design_and_execution", executionIncluded: true, locationText: "Nashik" } }));
    const r = await handleTurn(d, "c1", newState(), "Full interiors for my flat in Nashik");
    expect(r.done).toBe(true);
    expect(r.say).toMatch(/only work in Pune city and PCMC/);
    expect([...m.leads.values()][0].qualification_status).toBe("red");
  });

  it("asks one question at a time and never asks for budget", async () => {
    const { d } = deps(scripted({ intent: "new_enquiry", facts: { intent: "design_and_execution", executionIncluded: true, segment: "residential" } }));
    const r = await handleTurn(d, "c2", newState(), "I want my 2BHK redone");
    expect(r.done).toBe(false);
    expect(r.say).toMatch(/your name/);
    expect(r.say).not.toMatch(/budget/i);
    expect(inputSummary(r.state).find((x) => x.key === "budget")?.done).toBe(false);
  });

  it("answers a price question with the approved reply, then continues", async () => {
    const { d } = deps(scripted({ intent: "new_enquiry", question: "How much does a 2BHK cost?", facts: { intent: "design_and_execution", executionIncluded: true } }));
    const r = await handleTurn(d, "c3", newState(), "How much does a 2BHK cost?");
    expect(r.say.startsWith(PRICING_DEFLECTION)).toBe(true);
    expect(r.done).toBe(false);
  });

  it("routes a complaint to escalation without sales questions", async () => {
    const { m, d } = deps(scripted(
      { intent: "existing_project_complaint", complaintIssue: "Designer not replying for five days" },
      { intent: "existing_project_complaint", name: "Sheetal" },
      { intent: "existing_project_complaint", phone: "9822033333" },
    ));
    let s = newState();
    for (const t of ["My designer hasn't replied", "Sheetal", "9822033333"]) s = (await handleTurn(d, "c4", s, t)).state;
    expect(s.outcome).toBe("complaint escalated");
    expect(m.leads.size).toBe(0);
    expect([...m.exceptions.values()].some((e) => e.kind === "complaint")).toBe(true);
  });

  it("when calendars are unavailable it says so and never claims a booking", async () => {
    const { m, d } = deps(scripted(
      { intent: "new_enquiry", facts: { intent: "design_and_execution", executionIncluded: true, segment: "residential", scopeKind: "full_home", locationText: "Aundh", timelineFlexible: true, decisionMaker: "self", areaSqft: 900 }, name: "Pooja", phone: "9822012345" },
      { intent: "new_enquiry", wantsBooking: true },
    ));
    m.addDesigner();
    let r = await handleTurn(d, "c5", newState(), "All details at once");
    expect(r.state.qualification?.status).toBe("green");
    r = await handleTurn(d, "c5", r.state, "Yes please book");
    expect(r.done).toBe(true);
    expect(r.say).not.toMatch(/you're booked/i);
    expect(m.appts.size).toBe(0);
  });
});
