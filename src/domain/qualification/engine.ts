import { configHash, RULES_VERSION, type QualificationConfig } from "./config";
import { resolveServiceZone } from "./service-area";
import {
  CRITERIA,
  type CriterionKey,
  type CriterionOutcome,
  type LeadFacts,
  type QualificationResult,
} from "./types";

/**
 * Deterministic implementation of qualified.md. Gemini or the voice agent may supply the
 * facts; only this function decides GREEN / AMBER / RED.
 *
 *  - Any clear failure                → RED (never forwarded, closed gracefully)
 *  - Criterion 1–3 unclear, not asked → NEEDS_CLARIFICATION with one direct question
 *  - Criterion 1–3 unclear after ask  → NEEDS_REVIEW (human decides; no booking)
 *  - Criterion 4–5 unclear            → AMBER (qualified, uncertainty recorded)
 *  - Otherwise                        → GREEN
 */

export const CLARIFYING_QUESTIONS: Record<"real_project" | "service_area" | "timeline", { slug: string; text: string }> = {
  real_project: {
    slug: "clarify-execution",
    text: "Just so I understand — are you looking for us to design and carry out the work, or mainly for ideas and advice?",
  },
  service_area: {
    slug: "clarify-area",
    text: "Could you tell me which area the property is in — is it within Pune city or PCMC?",
  },
  // qualified.md: Ask: "When would you need the project complete?"
  timeline: { slug: "clarify-timeline", text: "When would you need the project complete?" },
};

const CLOSURE_BY_CRITERION: Record<CriterionKey, string> = {
  real_project: "closure-advice-only",
  service_area: "closure-service-area",
  timeline: "closure-timeline",
  budget: "closure-budget",
  decision_maker: "closure-multiple",
};

export interface EvaluateInput {
  facts: LeadFacts;
  config: QualificationConfig;
  /** Criteria (1–3) the agent has already asked its one clarifying question about. */
  clarificationsAsked?: CriterionKey[];
  /** Reference "today" for timeline maths; the call's start time. */
  now?: Date;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function realProject(f: LeadFacts, c: QualificationConfig): CriterionOutcome {
  if (f.intent === "advice_only")
    return { result: "fail", reasonCode: "advice_only", detail: "Caller wants advice or ideas, not design with execution." };
  if (f.intent === "decor_or_styling_only")
    return { result: "fail", reasonCode: "decor_only", detail: "Decor or styling only; minimum engagement is a room redesign with execution." };
  if (f.intent === "furniture_sourcing_only")
    return { result: "fail", reasonCode: "furniture_sourcing_only", detail: "Standalone furniture sourcing is not offered." };
  if (f.intent === "vastu_only")
    return { result: "fail", reasonCode: "vastu_only", detail: "Standalone Vastu consultation is not offered." };
  if (c.excludedPropertyTypes.includes(f.propertyType))
    return { result: "fail", reasonCode: "excluded_project_type", detail: `${f.propertyType} projects are out of scope (services.md).` };
  if (f.structuralWorkRequired === true)
    return { result: "fail", reasonCode: "structural_work", detail: "Requires structural or architectural work, which Aangan does not do." };
  if (f.executionIncluded === false)
    return { result: "fail", reasonCode: "no_execution", detail: "Caller will not have Aangan execute the work." };

  if (f.segment === "commercial" && f.areaSqft !== null) {
    const ceiling = c.commercial.maxSqft * (1 + c.commercial.maxSqftTolerancePct / 100);
    if (f.areaSqft > ceiling)
      return { result: "fail", reasonCode: "commercial_too_large", detail: `${f.areaSqft} sq ft exceeds the ~${c.commercial.maxSqft} sq ft commercial limit.` };
    if (f.areaSqft < c.commercial.minSqft)
      return { result: "fail", reasonCode: "commercial_too_small", detail: `${f.areaSqft} sq ft is below the ${c.commercial.minSqft} sq ft commercial minimum.` };
  }

  if (f.intent === "unknown" && f.executionIncluded === null)
    return { result: "unclear", reasonCode: "intent_unknown", detail: "Not yet clear whether the caller wants design with execution." };
  if (f.scopeKind === "single_room" && f.executionIncluded !== true && f.intent !== "design_and_execution")
    return { result: "unclear", reasonCode: "single_room_execution_unknown", detail: "Single room: execution not confirmed." };

  return { result: "pass", reasonCode: "design_and_execution", detail: "Design and execution project within Aangan's scope." };
}

function serviceArea(zone: string, locality: string | null): CriterionOutcome {
  if (zone === "pune" || zone === "pcmc")
    return { result: "pass", reasonCode: `in_${zone}`, detail: `Site in ${locality ?? zone} (${zone.toUpperCase()}).` };
  if (zone === "outside")
    return { result: "fail", reasonCode: "outside_service_area", detail: `Site in ${locality ?? "an area"} outside Pune city and PCMC.` };
  return { result: "unclear", reasonCode: "location_unknown", detail: "Project location not established." };
}

function timeline(f: LeadFacts, c: QualificationConfig, now: Date): CriterionOutcome {
  if (!f.requiredCompletionDate) {
    if (f.timelineFlexible === true)
      return { result: "pass", reasonCode: "flexible", detail: "Caller's timeline is flexible." };
    return { result: "unclear", reasonCode: "timeline_unknown", detail: "Required completion date not established." };
  }
  const weeks = (new Date(`${f.requiredCompletionDate}T23:59:59+05:30`).getTime() - now.getTime()) / WEEK_MS;
  const w = Math.round(weeks * 10) / 10;
  if (weeks < c.timeline.hardMinWeeks)
    return { result: "fail", reasonCode: "below_minimum_lead_time", detail: `Needs completion in ~${w} weeks; minimum lead time is ${c.timeline.hardMinWeeks} weeks.` };
  if (weeks < c.timeline.realisticMinWeeks) {
    if (c.timeline.tightTimelinePolicy === "fail")
      return { result: "fail", reasonCode: "timeline_too_tight", detail: `Needs completion in ~${w} weeks; design plus execution needs at least ${c.timeline.realisticMinWeeks}.` };
    return { result: "unclear", reasonCode: "timeline_tight", detail: `Needs completion in ~${w} weeks; feasibility needs a designer's judgement.` };
  }
  return { result: "pass", reasonCode: "timeline_realistic", detail: `Completion needed in ~${w} weeks.` };
}

function budget(f: LeadFacts, c: QualificationConfig): CriterionOutcome {
  if (!f.budgetMentioned) {
    if (c.budget.notMentionedIsUncertain)
      return { result: "unclear", reasonCode: "budget_not_discussed", detail: "Budget not discussed (not probed, per policy)." };
    return { result: "pass", reasonCode: "budget_not_discussed", detail: "Budget not volunteered; treated as qualified per qualified.md." };
  }
  if (f.budgetMaxInr === null)
    return { result: "unclear", reasonCode: "budget_vague", detail: `Caller mentioned budget without a figure${f.budgetText ? ` ("${f.budgetText}")` : ""}.` };
  if (f.budgetMaxInr < c.budget.clearlyInsufficientBelowInr)
    return { result: "fail", reasonCode: "budget_clearly_insufficient", detail: "Volunteered budget is clearly below any scope with execution." };
  return { result: "pass", reasonCode: "budget_not_misaligned", detail: "Volunteered budget shows no obvious misalignment." };
}

function decisionMaker(f: LeadFacts): CriterionOutcome {
  switch (f.decisionMaker) {
    case "self":
      return { result: "pass", reasonCode: "decision_maker", detail: "Caller is a decision-maker." };
    case "authorised_representative":
      return { result: "pass", reasonCode: "authorised_representative", detail: "Caller is authorised by the decision-maker." };
    case "not_authorised":
      return { result: "fail", reasonCode: "not_authorised", detail: "Caller stated they are not authorised to proceed." };
    case "researching_for_others":
      return { result: "unclear", reasonCode: "researching_for_others", detail: "Caller is researching for others; authority to proceed is uncertain." };
    default:
      return { result: "unclear", reasonCode: "decision_maker_unknown", detail: "Decision-maker status not established." };
  }
}

export function evaluate({ facts, config, clarificationsAsked = [], now = new Date() }: EvaluateInput): QualificationResult {
  const { zone, locality } = resolveServiceZone(facts.locationText, config.serviceArea);
  const criteria: Record<CriterionKey, CriterionOutcome> = {
    real_project: realProject(facts, config),
    service_area: serviceArea(zone, locality),
    timeline: timeline(facts, config, now),
    budget: budget(facts, config),
    decision_maker: decisionMaker(facts),
  };

  const failed = CRITERIA.filter((k) => criteria[k].result === "fail");
  const unclear = CRITERIA.filter((k) => criteria[k].result === "unclear");
  const uncertainties = unclear.map((k) => ({ criterion: k, reasonCode: criteria[k].reasonCode, detail: criteria[k].detail }));
  const base = {
    criteria,
    failedCriteria: failed,
    uncertainties,
    serviceZone: zone,
    matchedLocality: locality,
    rulesVersion: RULES_VERSION,
    configHash: configHash(config),
  };

  if (failed.length > 0) {
    return {
      ...base,
      status: "red",
      eligibleForBooking: false,
      nextQuestion: null,
      closureSlug: failed.length >= 2 ? "closure-multiple" : closureFor(failed[0], criteria),
    };
  }

  const blocking = unclear.filter((k): k is "real_project" | "service_area" | "timeline" =>
    k === "real_project" || k === "service_area" || k === "timeline",
  );
  // A tight-but-possible timeline is a judgement call, not a missing fact: ask nothing, review.
  const askable = blocking.filter((k) => !(k === "timeline" && criteria.timeline.reasonCode === "timeline_tight"));
  const notYetAsked = askable.filter((k) => !clarificationsAsked.includes(k));
  if (notYetAsked.length > 0) {
    const k = notYetAsked[0];
    return {
      ...base,
      status: "needs_clarification",
      eligibleForBooking: false,
      nextQuestion: { criterion: k, text: CLARIFYING_QUESTIONS[k].text },
      closureSlug: null,
    };
  }
  if (blocking.length > 0) {
    return { ...base, status: "needs_review", eligibleForBooking: false, nextQuestion: null, closureSlug: null };
  }

  const status = unclear.length > 0 ? "amber" : "green";
  return { ...base, status, eligibleForBooking: true, nextQuestion: null, closureSlug: null };
}

function closureFor(k: CriterionKey, criteria: Record<CriterionKey, CriterionOutcome>): string {
  if (k === "real_project" && ["excluded_project_type", "commercial_too_large", "commercial_too_small"].includes(criteria.real_project.reasonCode))
    return "closure-out-of-scope";
  if (k === "real_project" && criteria.real_project.reasonCode === "structural_work") return "closure-structural";
  return CLOSURE_BY_CRITERION[k];
}
