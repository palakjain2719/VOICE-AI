import { z } from "zod";
import { CRITERIA, LeadFactsSchema } from "@/domain/qualification/types";
import { CALL_TYPES } from "@/integrations/gemini/tasks";

/** Contract for the voice agent's live tool calls. Every request is validated against these. */
const base = {
  call_id: z.string().trim().min(1).max(200),
  caller_phone: z.string().trim().max(40).nullish(),
};

export const SaveIntakeSchema = z.object({
  ...base,
  call_type: z.enum(CALL_TYPES).optional(),
  name: z.string().trim().max(120).nullish(),
  callback_phone: z.string().trim().max(40).nullish(),
  email: z.string().trim().max(200).nullish(),
  location: z.string().trim().max(200).nullish(),
  project_type: z.string().trim().max(80).nullish(),
  scope: z.string().trim().max(400).nullish(),
  area_sqft: z.number().int().positive().max(100000).nullish(),
  current_state: z.string().trim().max(200).nullish(),
  timeline_text: z.string().trim().max(200).nullish(),
  decision_maker: z.string().trim().max(120).nullish(),
  budget_text: z.string().trim().max(200).nullish(),
  is_rented: z.boolean().nullish(),
  notes: z.string().trim().max(500).nullish(),
});

export const AnswerQuestionSchema = z.object({ ...base, question: z.string().trim().min(1).max(500) });
export const LogUnansweredSchema = AnswerQuestionSchema;

export const EvaluateQualificationSchema = z.object({
  ...base,
  name: z.string().trim().max(120).nullish(),
  callback_phone: z.string().trim().max(40).nullish(),
  email: z.string().trim().max(200).nullish(),
  project_type_label: z.string().trim().max(80).nullish(),
  scope_summary: z.string().trim().max(400).nullish(),
  current_state: z.string().trim().max(200).nullish(),
  facts: LeadFactsSchema.partial(),
  clarifications_asked: z.array(z.enum(CRITERIA)).max(5).default([]),
});

export const GetAvailabilitySchema = z.object({
  ...base,
  preferred_dates: z.array(z.iso.date()).max(7).optional(),
  dayparts: z.array(z.enum(["morning", "afternoon", "evening"])).max(3).optional(),
  weekdays_only: z.boolean().optional(),
  weekends_only: z.boolean().optional(),
});

export const BookConsultationSchema = z.object({
  ...base,
  slot_start: z.iso.datetime({ offset: true }),
  designer_id: z.uuid(),
  name: z.string().trim().max(120).nullish(),
  email: z.string().trim().max(200).nullish(),
  idempotency_key: z.string().trim().min(8).max(200).optional(),
});

export const EscalateSchema = z.object({
  ...base,
  type: z.enum(["complaint", "callback_request", "follow_up"]),
  name: z.string().trim().max(120).nullish(),
  callback_phone: z.string().trim().max(40).nullish(),
  issue: z.string().trim().min(1).max(1000),
  designer_name: z.string().trim().max(120).nullish(),
  project_location: z.string().trim().max(200).nullish(),
});

export const TakeMessageSchema = z.object({
  ...base,
  name: z.string().trim().max(120).nullish(),
  callback_phone: z.string().trim().max(40).nullish(),
  message_type: z.enum(["project_update", "designer_request", "callback_request", "other"]),
  for_name: z.string().trim().max(120).nullish(),
  about: z.string().trim().min(1).max(1000),
  callback_window: z.string().trim().max(120).nullish(),
});

export const VOICE_TOOLS = {
  save_intake: SaveIntakeSchema,
  answer_question: AnswerQuestionSchema,
  evaluate_qualification: EvaluateQualificationSchema,
  get_availability: GetAvailabilitySchema,
  book_consultation: BookConsultationSchema,
  log_unanswered_question: LogUnansweredSchema,
  escalate: EscalateSchema,
  take_message: TakeMessageSchema,
} as const;
export type VoiceToolName = keyof typeof VOICE_TOOLS;
