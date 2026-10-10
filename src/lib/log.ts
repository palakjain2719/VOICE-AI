/**
 * Structured server logger that redacts secrets and personal data before anything is written.
 * Browser responses never include these details; they get generic messages instead.
 */
const SECRET_KEY = /(key|secret|token|password|authorization|cookie|signature|refresh|access)/i;
const PII_KEY = /^(phone|caller_phone|caller_phone_normalized|email|to|name|transcript|turns)$/i;

const PATTERNS: [RegExp, string][] = [
  [/vv_(live|whk)_[A-Za-z0-9_-]+/g, "vv_$1_[REDACTED]"],
  [/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_GOOGLE_KEY]"],
  [/re_[A-Za-z0-9]{16,}/g, "[REDACTED_RESEND_KEY]"],
  [/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, "sb_$1_[REDACTED]"],
  [/pat-[a-z0-9]{2,4}-[0-9a-f-]{20,}/gi, "[REDACTED_HUBSPOT_KEY]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]"],
  [/ya29\.[A-Za-z0-9._-]+/g, "[REDACTED_GOOGLE_TOKEN]"],
  [/1\/\/[A-Za-z0-9._-]{20,}/g, "[REDACTED_REFRESH_TOKEN]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/(?<![\w-])\+?(?:91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\w-])/g, "[phone]"],
];

export function redactString(s: string): string {
  return PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) out[k] = "[REDACTED]";
      else if (PII_KEY.test(k)) out[k] = v == null ? v : "[PII]";
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactString(msg).slice(0, 500);
}

type Level = "info" | "warn" | "error";
function write(level: Level, event: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ level, event, at: new Date().toISOString(), ...(data ? (redact(data) as object) : {}) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, data?: Record<string, unknown>) => write("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => write("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => write("error", event, data),
};
