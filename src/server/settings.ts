import { z } from "zod";
import { DEFAULT_QUALIFICATION_CONFIG, QualificationConfigSchema, type QualificationConfig } from "@/domain/qualification/config";
import { BookingConfigSchema, DEFAULT_BOOKING_CONFIG, type BookingConfig } from "@/domain/booking/slots";
import { PipelineMappingSchema, type PipelineMapping } from "@/server/services/hubspot-sync";
import type { Store } from "@/server/store/types";
import { log } from "@/lib/log";

/** Escalation policy. Callback promises are only made when a time is configured here. */
export const EscalationPolicySchema = z.object({
  complaintCallbackMinutes: z.number().int().positive().nullable(),
  notifyEmails: z.array(z.email()).max(5),
});
export type EscalationPolicy = z.infer<typeof EscalationPolicySchema>;
export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = { complaintCallbackMinutes: null, notifyEmails: [] };

export const ConfirmationPolicySchema = z.object({
  /** When no email is available: create a task for the team to confirm by phone, or do nothing. */
  noEmailFallback: z.enum(["manual_phone_confirmation", "none"]),
  rescheduleContactLine: z.string().max(200).nullable(),
});
export type ConfirmationPolicy = z.infer<typeof ConfirmationPolicySchema>;
export const DEFAULT_CONFIRMATION_POLICY: ConfirmationPolicy = { noEmailFallback: "manual_phone_confirmation", rescheduleContactLine: null };

export const CostRatesSchema = z.object({
  /** Gemini list prices in USD per million tokens, entered by an admin from Google's pricing page. */
  geminiInputUsdPerMTok: z.number().nonnegative().nullable(),
  geminiOutputUsdPerMTok: z.number().nonnegative().nullable(),
  /** Conversion used for the estimate; costs from Gemini are always flagged as estimates. */
  usdToInr: z.number().positive().nullable(),
});
export type CostRates = z.infer<typeof CostRatesSchema>;

export const VoiceBudgetSchema = z.object({
  /** Alert threshold for Vaani spend per day (INR). Vaani's API has no documented way to stop calls, so this alerts only. */
  dailyCapInr: z.number().positive().nullable(),
});
export type VoiceBudget = z.infer<typeof VoiceBudgetSchema>;

export const SETTINGS = {
  qualification: { key: "qualification_config", schema: QualificationConfigSchema, fallback: DEFAULT_QUALIFICATION_CONFIG },
  booking: { key: "booking_config", schema: BookingConfigSchema, fallback: DEFAULT_BOOKING_CONFIG },
  escalation: { key: "escalation_policy", schema: EscalationPolicySchema, fallback: DEFAULT_ESCALATION_POLICY },
  confirmation: { key: "confirmation_policy", schema: ConfirmationPolicySchema, fallback: DEFAULT_CONFIRMATION_POLICY },
  voiceBudget: { key: "voice_budget", schema: VoiceBudgetSchema, fallback: { dailyCapInr: null } as VoiceBudget },
  costRates: { key: "cost_rates", schema: CostRatesSchema, fallback: { geminiInputUsdPerMTok: null, geminiOutputUsdPerMTok: null, usdToInr: null } as CostRates },
} as const;

async function load<T>(store: Store, key: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  const raw = await store.getSetting<unknown>(key);
  if (raw == null) return fallback;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    log.error("settings.invalid", { key });
    return fallback;
  }
  return parsed.data;
}

export const loadQualificationConfig = (s: Store): Promise<QualificationConfig> => load(s, SETTINGS.qualification.key, SETTINGS.qualification.schema, SETTINGS.qualification.fallback);
export const loadBookingConfig = (s: Store): Promise<BookingConfig> => load(s, SETTINGS.booking.key, SETTINGS.booking.schema, SETTINGS.booking.fallback);
export const loadEscalationPolicy = (s: Store): Promise<EscalationPolicy> => load(s, SETTINGS.escalation.key, SETTINGS.escalation.schema, SETTINGS.escalation.fallback);
export const loadConfirmationPolicy = (s: Store): Promise<ConfirmationPolicy> => load(s, SETTINGS.confirmation.key, SETTINGS.confirmation.schema, SETTINGS.confirmation.fallback);
export const loadCostRates = (s: Store): Promise<CostRates> => load(s, SETTINGS.costRates.key, SETTINGS.costRates.schema, SETTINGS.costRates.fallback);

export async function loadPipelineMapping(s: Store): Promise<PipelineMapping | null> {
  const raw = await s.getSetting<unknown>("hubspot_pipeline");
  if (raw == null) return null;
  const parsed = PipelineMappingSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
