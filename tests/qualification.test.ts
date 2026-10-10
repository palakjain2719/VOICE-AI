import { describe, expect, it } from "vitest";
import { evaluate } from "@/domain/qualification/engine";
import { DEFAULT_QUALIFICATION_CONFIG as config, configHash } from "@/domain/qualification/config";
import { LeadFactsSchema, type LeadFacts } from "@/domain/qualification/types";
import { resolveServiceZone } from "@/domain/qualification/service-area";

const at = (d: string) => new Date(`${d}T11:00:00+05:30`);
const facts = (f: Partial<LeadFacts>) => LeadFactsSchema.parse(f);
const home = { intent: "design_and_execution", segment: "residential", propertyType: "apartment", executionIncluded: true } as const;

describe("qualification rubric (qualified.md) on the September transcripts", () => {
  it("1. T01 — full-home 3BHK in Kothrud, March, owner with spouse's go-ahead → GREEN", () => {
    const r = evaluate({ facts: facts({ ...home, scopeKind: "full_home", areaSqft: 1400, locationText: "Kothrud, Dahanukar Colony", requiredCompletionDate: "2027-03-31", decisionMaker: "self" }), config, now: at("2026-09-02") });
    expect(r.status).toBe("green");
    expect(r.eligibleForBooking).toBe(true);
    expect(r.serviceZone).toBe("pune");
  });

  it("2. T02 — asks price first, decision-maker never established → AMBER (pricing does not disqualify)", () => {
    const r = evaluate({ facts: facts({ ...home, scopeKind: "full_home", areaSqft: 950, locationText: "Wakad", requiredCompletionDate: "2026-11-30" }), config, now: at("2026-09-03") });
    expect(r.status).toBe("amber");
    expect(r.uncertainties.map((u) => u.criterion)).toEqual(["decision_maker"]);
    expect(r.eligibleForBooking).toBe(true);
  });

  it("3a. T03 — Nashik → RED with the service-area closure", () => {
    const r = evaluate({ facts: facts({ ...home, scopeKind: "partial_home", locationText: "Nashik", timelineFlexible: true, decisionMaker: "self" }), config, now: at("2026-09-03") });
    expect(r.status).toBe("red");
    expect(r.failedCriteria).toEqual(["service_area"]);
    expect(r.closureSlug).toBe("closure-service-area");
  });

  it("3b. F03 — 'Talegaon Dabhade, near Pune' resolves outside the area → RED", () => {
    expect(resolveServiceZone("Talegaon Dabhade, near Pune", config.serviceArea).zone).toBe("outside");
    const r = evaluate({ facts: facts({ ...home, locationText: "Talegaon Dabhade, near Pune", timelineFlexible: true, budgetMentioned: true, budgetMaxInr: 2000000 }), config, now: at("2026-09-06") });
    expect(r.status).toBe("red");
  });

  it("4. T04 — advice-only living-room visit → RED with the advice-only closure", () => {
    const r = evaluate({ facts: facts({ intent: "advice_only", segment: "residential", scopeKind: "single_room", executionIncluded: false }), config, now: at("2026-09-04") });
    expect(r.status).toBe("red");
    expect(r.criteria.real_project.reasonCode).toBe("advice_only");
    expect(r.closureSlug).toBe("closure-advice-only");
  });

  it("5. T06 — 800 sq ft startup office in Baner, December, founder → GREEN", () => {
    const r = evaluate({ facts: facts({ intent: "design_and_execution", segment: "commercial", propertyType: "office", scopeKind: "commercial_fitout", areaSqft: 800, executionIncluded: true, locationText: "Baner", requiredCompletionDate: "2026-12-31", decisionMaker: "self" }), config, now: at("2026-09-05") });
    expect(r.status).toBe("green");
  });

  it("5b. F05 — 2,200 sq ft Hinjewadi office with a volunteered budget → GREEN", () => {
    const r = evaluate({ facts: facts({ intent: "design_and_execution", segment: "commercial", propertyType: "office", areaSqft: 2200, executionIncluded: true, locationText: "Hinjewadi Phase 1, Pune", requiredCompletionDate: "2027-01-15", decisionMaker: "authorised_representative", budgetMentioned: true, budgetMaxInr: 8000000 }), config, now: at("2026-09-11") });
    expect(r.status).toBe("green");
    expect(r.serviceZone).toBe("pcmc");
  });

  it("6. T18 — 180 sq ft coworking pod is below the commercial minimum → RED (out of scope)", () => {
    const r = evaluate({ facts: facts({ intent: "design_and_execution", segment: "commercial", propertyType: "coworking", areaSqft: 180, executionIncluded: true, locationText: "Pune", timelineFlexible: true, decisionMaker: "self" }), config, now: at("2026-09-23") });
    expect(r.status).toBe("red");
    expect(r.criteria.real_project.reasonCode).toBe("commercial_too_small");
    expect(r.closureSlug).toBe("closure-out-of-scope");
  });

  it("6b. Commercial project well above ~3,000 sq ft → RED", () => {
    const r = evaluate({ facts: facts({ intent: "design_and_execution", segment: "commercial", propertyType: "office", areaSqft: 5000, executionIncluded: true, locationText: "Baner", timelineFlexible: true, decisionMaker: "self" }), config });
    expect(r.criteria.real_project.reasonCode).toBe("commercial_too_large");
  });

  it("7. T19 / W07 — restaurant and gym projects → RED", () => {
    for (const propertyType of ["restaurant", "gym"] as const) {
      const r = evaluate({ facts: facts({ intent: "design_and_execution", segment: "commercial", propertyType, areaSqft: 2500, locationText: "Koregaon Park", timelineFlexible: true, decisionMaker: "self" }), config });
      expect(r.status).toBe("red");
      expect(r.criteria.real_project.reasonCode).toBe("excluded_project_type");
    }
  });

  it("8. F01 — budget not disclosed is not probed and not disqualifying → GREEN", () => {
    const r = evaluate({ facts: facts({ ...home, scopeKind: "full_home", areaSqft: 920, locationText: "Kalyani Nagar, Pune", requiredCompletionDate: "2027-02-28", decisionMaker: "self", budgetMentioned: false, budgetText: "Prefer not to mention" }), config, now: at("2026-09-01") });
    expect(r.status).toBe("green");
    expect(r.criteria.budget.result).toBe("pass");
  });

  it("9. T11 — rented 2BHK in Baner, reversible work, no structural change → eligible", () => {
    const r = evaluate({ facts: facts({ ...home, scopeKind: "partial_home", roomsInScope: 3, locationText: "Baner", isRented: true, structuralWorkRequired: false, decisionMaker: "self", timelineFlexible: true }), config, now: at("2026-09-12") });
    expect(r.status).toBe("green");
  });

  it("9b. T11 without any timeline → one clarifying question, then human review if still unknown", () => {
    const f = facts({ ...home, locationText: "Baner", isRented: true, decisionMaker: "self" });
    const first = evaluate({ facts: f, config, now: at("2026-09-12") });
    expect(first.status).toBe("needs_clarification");
    expect(first.nextQuestion?.text).toBe("When would you need the project complete?");
    const after = evaluate({ facts: f, config, clarificationsAsked: ["timeline"], now: at("2026-09-12") });
    expect(after.status).toBe("needs_review");
    expect(after.eligibleForBooking).toBe(false);
  });

  it("10. T07 / F08 — needs completion in ~3 weeks → RED with the timeline closure", () => {
    const r = evaluate({ facts: facts({ ...home, scopeKind: "partial_home", locationText: "Wakad, Pune", requiredCompletionDate: "2026-10-09", decisionMaker: "self", budgetMentioned: true, budgetMaxInr: 500000 }), config, now: at("2026-09-18") });
    expect(r.status).toBe("red");
    expect(r.criteria.timeline.reasonCode).toBe("below_minimum_lead_time");
    expect(r.closureSlug).toBe("closure-timeline");
  });

  it("10b. A tight-but-possible timeline (8 weeks) goes to a designer's judgement, without re-asking", () => {
    const r = evaluate({ facts: facts({ ...home, locationText: "Aundh", requiredCompletionDate: "2026-11-27", decisionMaker: "self" }), config, now: at("2026-10-02") });
    expect(r.status).toBe("needs_review");
    expect(r.nextQuestion).toBeNull();
  });

  it("11. T14 — son researching for parents; decision authority uncertain → AMBER, not pushed", () => {
    const r = evaluate({ facts: facts({ ...home, scopeKind: "full_home", locationText: "Hadapsar", decisionMaker: "researching_for_others", timelineFlexible: true }), config, now: at("2026-09-17") });
    expect(r.status).toBe("amber");
    expect(r.uncertainties[0].reasonCode).toBe("researching_for_others");
    expect(r.nextQuestion).toBeNull();
  });

  it("T10 — volunteered ₹1–1.5 lakh for kitchen + bedroom → RED with the budget closure", () => {
    const r = evaluate({ facts: facts({ ...home, scopeKind: "partial_home", roomsInScope: 2, areaSqft: 550, locationText: "Kharadi", timelineFlexible: true, budgetMentioned: true, budgetMaxInr: 150000, decisionMaker: "self" }), config, now: at("2026-09-11") });
    expect(r.status).toBe("red");
    expect(r.failedCriteria).toEqual(["budget"]);
    expect(r.closureSlug).toBe("closure-budget");
  });

  it("A vague volunteered budget ('reasonable') is uncertainty, not failure → AMBER", () => {
    const r = evaluate({ facts: facts({ ...home, locationText: "Pune", timelineFlexible: true, decisionMaker: "self", budgetMentioned: true, budgetText: "reasonable" }), config });
    expect(r.status).toBe("amber");
  });

  it("Two or more failures use the exact multi-criteria closure", () => {
    const r = evaluate({ facts: facts({ intent: "advice_only", locationText: "Mumbai", timelineFlexible: true }), config });
    expect(r.failedCriteria.length).toBeGreaterThanOrEqual(2);
    expect(r.closureSlug).toBe("closure-multiple");
  });

  it("Unknown location → the one direct area question first", () => {
    const r = evaluate({ facts: facts({ ...home, timelineFlexible: true, decisionMaker: "self" }), config });
    expect(r.status).toBe("needs_clarification");
    expect(r.nextQuestion?.criterion).toBe("service_area");
  });

  it("A clear failure wins over open questions (no point asking when it already fails)", () => {
    const r = evaluate({ facts: facts({ intent: "vastu_only" }), config });
    expect(r.status).toBe("red");
  });

  it("Single room with full execution qualifies; structural work does not", () => {
    expect(evaluate({ facts: facts({ ...home, scopeKind: "single_room", locationText: "Aundh", timelineFlexible: true, decisionMaker: "self" }), config }).status).toBe("green");
    expect(evaluate({ facts: facts({ ...home, structuralWorkRequired: true, locationText: "Aundh", timelineFlexible: true, decisionMaker: "self" }), config }).closureSlug).toBe("closure-structural");
  });

  it("Every evaluation records rules version and config hash; config changes change the hash", () => {
    const r = evaluate({ facts: facts({}), config });
    expect(r.rulesVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(r.configHash).toBe(configHash(config));
    expect(configHash({ ...config, commercial: { ...config.commercial, minSqft: 400 } })).not.toBe(r.configHash);
  });

  it("is deterministic", () => {
    const f = facts({ ...home, locationText: "Viman Nagar", requiredCompletionDate: "2027-01-31", decisionMaker: "self" });
    const a = evaluate({ facts: f, config, now: at("2026-09-19") });
    const b = evaluate({ facts: f, config, now: at("2026-09-19") });
    expect(a).toEqual(b);
  });
});
