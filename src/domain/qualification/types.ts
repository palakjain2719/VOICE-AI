import { z } from "zod";

/**
 * Structured facts the qualification rules run on. Gemini (post-call) or the voice agent
 * (live tool call) may fill these, but the decision itself is made by `evaluate()`.
 * Every field allows "unknown" so missing information is never mistaken for a pass.
 */
export const LeadFactsSchema = z.object({
  intent: z
    .enum(["design_and_execution", "advice_only", "decor_or_styling_only", "furniture_sourcing_only", "vastu_only", "unknown"])
    .default("unknown"),
  segment: z.enum(["residential", "commercial", "unknown"]).default("unknown"),
  propertyType: z
    .enum([
      "apartment", "independent_house", "villa", "office", "clinic", "studio", "coworking",
      "restaurant", "hotel", "retail", "gym", "other", "unknown",
    ])
    .default("unknown"),
  scopeKind: z.enum(["full_home", "partial_home", "single_room", "commercial_fitout", "unknown"]).default("unknown"),
  roomsInScope: z.number().int().min(0).max(50).nullable().default(null),
  executionIncluded: z.boolean().nullable().default(null),
  structuralWorkRequired: z.boolean().nullable().default(null),
  areaSqft: z.number().int().positive().max(100000).nullable().default(null),
  locationText: z.string().max(200).nullable().default(null),
  requiredCompletionDate: z.iso.date().nullable().default(null),
  timelineText: z.string().max(200).nullable().default(null),
  timelineFlexible: z.boolean().nullable().default(null),
  budgetMentioned: z.boolean().default(false),
  budgetMaxInr: z.number().int().positive().nullable().default(null),
  budgetText: z.string().max(200).nullable().default(null),
  decisionMaker: z
    .enum(["self", "authorised_representative", "researching_for_others", "not_authorised", "unknown"])
    .default("unknown"),
  isRented: z.boolean().nullable().default(null),
});
export type LeadFacts = z.infer<typeof LeadFactsSchema>;

export const CRITERIA = ["real_project", "service_area", "timeline", "budget", "decision_maker"] as const;
export type CriterionKey = (typeof CRITERIA)[number];
export type CriterionResult = "pass" | "fail" | "unclear";

export interface CriterionOutcome {
  result: CriterionResult;
  reasonCode: string;
  detail: string;
}

export type QualificationStatus = "green" | "amber" | "red" | "needs_clarification" | "needs_review";

export interface QualificationResult {
  status: QualificationStatus;
  eligibleForBooking: boolean;
  criteria: Record<CriterionKey, CriterionOutcome>;
  failedCriteria: CriterionKey[];
  uncertainties: { criterion: CriterionKey; reasonCode: string; detail: string }[];
  /** One direct follow-up question, only when criteria 1–3 are unclear and not yet asked. */
  nextQuestion: { criterion: CriterionKey; text: string } | null;
  /** Approved knowledge slug the agent should use to close the call (red outcomes). */
  closureSlug: string | null;
  serviceZone: "pune" | "pcmc" | "outside" | "unknown";
  matchedLocality: string | null;
  rulesVersion: string;
  configHash: string;
}
