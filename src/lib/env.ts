import "server-only";
import { z } from "zod";

/**
 * Server-side configuration. Each integration validates only the variables it needs, so a
 * missing HubSpot key disables HubSpot (with a visible setup error) without breaking calls.
 */
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  APP_BASE_URL: optional,
  CRON_SECRET: optional,
  TOKEN_ENCRYPTION_KEY: optional,
  VOICE_TOOL_SECRET: optional,
  VAANI_API_KEY: optional,
  VAANI_WEBHOOK_SECRET: optional,
  VAANI_FLOW_ID: optional,
  GEMINI_API_KEY: optional,
  GEMINI_MODEL: optional,
  NEXT_PUBLIC_SUPABASE_URL: optional,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optional,
  SUPABASE_SECRET_KEY: optional,
  HUBSPOT_SERVICE_KEY: optional,
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GOOGLE_REDIRECT_URI: optional,
  RESEND_API_KEY: optional,
  EMAIL_FROM: optional,
});
export type Env = z.infer<typeof EnvSchema>;

export function env(): Env {
  return EnvSchema.parse(process.env);
}

export class ConfigError extends Error {
  constructor(
    public readonly provider: string,
    public readonly missing: string[],
  ) {
    super(`${provider} is not configured: missing ${missing.join(", ")}`);
    this.name = "ConfigError";
  }
}

export function requireEnv<K extends keyof Env>(provider: string, keys: K[]): { [P in K]: string } {
  const e = env();
  const missing = keys.filter((k) => !e[k]);
  if (missing.length) throw new ConfigError(provider, missing as string[]);
  return Object.fromEntries(keys.map((k) => [k, e[k]])) as { [P in K]: string };
}

export function isConfigured(keys: (keyof Env)[]): boolean {
  const e = env();
  return keys.every((k) => !!e[k]);
}

export const PROVIDER_ENV: Record<string, (keyof Env)[]> = {
  vaani: ["VAANI_API_KEY", "VAANI_WEBHOOK_SECRET", "VOICE_TOOL_SECRET"],
  gemini: ["GEMINI_API_KEY", "GEMINI_MODEL"],
  supabase: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"],
  hubspot: ["HUBSPOT_SERVICE_KEY"],
  google_calendar: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "TOKEN_ENCRYPTION_KEY"],
  resend: ["RESEND_API_KEY", "EMAIL_FROM"],
  app: ["APP_BASE_URL", "CRON_SECRET"],
};
