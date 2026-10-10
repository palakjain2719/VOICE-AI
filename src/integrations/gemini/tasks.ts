import { z } from "zod";
import type { JsonModel, GeminiUsage } from "./client";
import { LeadFactsSchema } from "@/domain/qualification/types";
import type { RuntimeArticle } from "@/domain/knowledge/answer";

export const CALL_TYPES = [
  "new_enquiry", "existing_project_complaint", "existing_lead_follow_up",
  "callback_request", "general_question", "unknown",
] as const;

export const CallExtractionSchema = z.object({
  callType: z.enum(CALL_TYPES),
  contact: z.object({
    name: z.string().max(120).nullable(),
    callbackPhone: z.string().max(40).nullable(),
    email: z.string().max(200).nullable(),
  }),
  facts: LeadFactsSchema,
  projectTypeLabel: z.string().max(80).nullable().describe("Short label, e.g. '3BHK full home', 'Office fitout'"),
  scopeSummary: z.string().max(400).nullable(),
  currentPropertyState: z.string().max(200).nullable(),
  clarificationsAsked: z.array(z.enum(["real_project", "service_area", "timeline"])),
  pricingRequested: z.boolean(),
  unansweredQuestions: z.array(z.string().max(300)).max(10),
  complaint: z
    .object({ issue: z.string().max(500), designerName: z.string().max(120).nullable(), projectLocation: z.string().max(200).nullable() })
    .nullable(),
  message: z
    .object({
      forName: z.string().max(120).nullable().describe("Person the caller asked for, if any"),
      about: z.string().max(500),
      callbackWindow: z.string().max(120).nullable(),
      type: z.enum(["project_update", "designer_request", "callback_request", "other"]),
    })
    .nullable()
    .describe("Only when the caller left a message for someone or asked for a specific person to call back"),
  summary: z.string().max(800),
});
export type CallExtraction = z.infer<typeof CallExtractionSchema>;

const EXTRACTION_SYSTEM = `You extract structured facts from phone-call transcripts for Aangan Studio, an interior design and execution studio in Pune.
Rules:
- Extract only what the CALLER actually said. Use "unknown" or null whenever something was not stated. Never guess.
- intent: "design_and_execution" when the caller asks Aangan to redo, redesign, design and build, fit out, or "do the interiors" of a space (e.g. "redo the whole flat", "full fitout from scratch", "need workstations, cabins and a meeting room") and gives none of the red flags below. "advice_only" for "just ideas / suggestions", "come and advise", consultation-only, or "I'll do the execution myself"; "decor_or_styling_only", "furniture_sourcing_only", "vastu_only" when that is all they want. "unknown" only if the caller hasn't said what they want done.
- executionIncluded: true when intent is design_and_execution as above; false when they say they'll execute themselves or only want advice; else null.
- requiredCompletionDate: the date by which the project must be COMPLETE, as YYYY-MM-DD, resolved against the call date given. Month-only answers resolve to the last day of that month (next occurrence). Festivals: resolve to their date in the relevant year if you know it. If they only gave a start date or nothing, null.
- timelineFlexible: true if they said "no rush", "flexible", "whenever".
- budgetMentioned: true only if the caller volunteered a budget. budgetMaxInr: the upper figure in rupees (1 lakh = 100000). Never infer a budget.
- decisionMaker: "self" (owner / decides, incl. with spouse), "authorised_representative" (decision-maker has authorised them), "researching_for_others" (checking on behalf of family, others decide), "not_authorised" only if they explicitly say they cannot proceed, else "unknown".
- areaSqft: carpet area in sq ft if stated.
- locationText: the locality/city words the caller used for the SITE.
- clarificationsAsked: which of real_project / service_area / timeline the agent explicitly asked a clarifying question about.
- unansweredQuestions: caller questions the agent said it could not answer.
- message: fill only if the caller asked for a specific person or left a message/project update for the team.
- summary: 2–4 neutral sentences for the designer. No prices.`;

export async function extractCall(model: JsonModel, transcript: string, callDateIso: string): Promise<{ data: CallExtraction; usage: GeminiUsage }> {
  return model.generateJson({
    system: EXTRACTION_SYSTEM,
    prompt: `Call date (Asia/Kolkata): ${callDateIso.slice(0, 10)}\n\nTranscript:\n${transcript.slice(0, 60_000)}`,
    schema: CallExtractionSchema,
  });
}

const SelectionSchema = z.object({ slug: z.string().nullable() });

/** Model may only choose among approved articles; it never writes customer-facing text. */
export function articleSelector(model: JsonModel) {
  return async (question: string, candidates: RuntimeArticle[]): Promise<string | null> => {
    const list = candidates.map((c) => `- ${c.slug}: ${c.spokenAnswer}`).join("\n");
    const { data } = await model.generateJson({
      system:
        "Pick the ONE approved answer that directly and fully answers the caller's question. If none of them answers it, return null. Do not stretch: a related topic that doesn't answer the actual question means null.",
      prompt: `Caller question: ${question}\n\nApproved answers:\n${list}`,
      schema: SelectionSchema,
      maxOutputTokens: 512
    });
    return data.slug && candidates.some((c) => c.slug === data.slug) ? data.slug : null;
  };
}
