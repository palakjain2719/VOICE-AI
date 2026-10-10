import { CRITERIA, type QualificationResult } from "./types";

/**
 * Transparent fit score for lists and sorting: each criterion passed = 20, unclear = 10, failed = 0.
 * It summarises the rubric result; it is not a probability or a revenue estimate.
 */
export function fitScore(r: Pick<QualificationResult, "criteria">): number {
  return CRITERIA.reduce((s, k) => s + (r.criteria[k].result === "pass" ? 20 : r.criteria[k].result === "unclear" ? 10 : 0), 0);
}

export type DeclineCategory = "category" | "area" | "budget" | "timeline" | "engagement";

const ENGAGEMENT = new Set(["advice_only", "decor_only", "furniture_sourcing_only", "vastu_only", "no_execution", "not_authorised"]);

/** Why an enquiry was turned away, for "where demand comes from — and what we turn away". */
export function declineCategory(r: Pick<QualificationResult, "status" | "failedCriteria" | "criteria">): DeclineCategory | null {
  if (r.status !== "red" || !r.failedCriteria.length) return null;
  const k = r.failedCriteria[0];
  if (k === "service_area") return "area";
  if (k === "budget") return "budget";
  if (k === "timeline") return "timeline";
  if (k === "decision_maker") return "engagement";
  return ENGAGEMENT.has(r.criteria.real_project.reasonCode) ? "engagement" : "category";
}
