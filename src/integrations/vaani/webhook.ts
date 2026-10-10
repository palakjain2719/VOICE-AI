import { z } from "zod";
import { hmacSha256Hex, safeEqual } from "@/lib/crypto";

/**
 * Vaani Labs outbound webhooks (https://www.vaanilabs.in/docs/api/webhooks, OpenAPI
 * /openapi/v1/vaanivoice.yaml):
 *  - X-VaaniVoice-Signature: "sha256=" + lowercase hex HMAC-SHA256(raw body, vv_whk_ secret)
 *  - X-VaaniVoice-Event: event type; X-VaaniVoice-Delivery: numeric delivery id
 *  - Body: { id: "evt_…" (stable across retries), type, created (unix s), data: {…} }
 *  - `data` is event-specific, phone numbers are masked, and no sub-field is guaranteed.
 */
export const VAANI_EVENT_TYPES = ["call.completed", "call.failed", "meeting.ended", "lead.created", "usage.charged", "low_balance.warned", "webhook.ping"] as const;

export const VaaniEnvelopeSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  created: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type VaaniEnvelope = z.infer<typeof VaaniEnvelopeSchema>;

export function verifyVaaniSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  return safeEqual(header, `sha256=${hmacSha256Hex(secret, rawBody)}`);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
function time(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string" && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const parts = k.split(".");
    let cur: unknown = obj;
    for (const p of parts) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
    if (cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return undefined;
}

export interface TranscriptTurn {
  role: "agent" | "caller" | "unknown";
  text: string;
}

export interface NormalisedCallEvent {
  providerCallId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  callerPhone: string | null;
  transcript: string | null;
  turns: TranscriptTurn[] | null;
  failureReason: string | null;
  recordingReference: string | null;
  costPaise: number | null;
  flowId: string | null;
  surface: string | null;
}

function normaliseTurns(raw: unknown): TranscriptTurn[] | null {
  if (!Array.isArray(raw)) return null;
  const turns = raw
    .map((t): TranscriptTurn | null => {
      if (!t || typeof t !== "object") return null;
      const o = t as Record<string, unknown>;
      const text = str(o.text ?? o.content ?? o.message ?? o.transcript);
      if (!text) return null;
      const r = String(o.role ?? o.speaker ?? o.from ?? "").toLowerCase();
      const role = /agent|assistant|bot|ai|system/.test(r) ? "agent" : /user|caller|customer|human/.test(r) ? "caller" : "unknown";
      return { role, text };
    })
    .filter((t): t is TranscriptTurn => t !== null);
  return turns.length ? turns : null;
}

/** Best-effort mapping of an undocumented `data` payload into the fields we store. */
export function normaliseCallData(data: Record<string, unknown>): NormalisedCallEvent {
  const rawTranscript = pick(data, "transcript", "conversation", "messages", "call.transcript");
  const turns = normaliseTurns(rawTranscript);
  const transcript =
    typeof rawTranscript === "string"
      ? rawTranscript
      : turns
        ? turns.map((t) => `${t.role === "agent" ? "Agent" : t.role === "caller" ? "Caller" : "Speaker"}: ${t.text}`).join("\n")
        : null;
  const startedAt = time(pick(data, "started_at", "start_time", "startedAt", "call.started_at"));
  const endedAt = time(pick(data, "ended_at", "end_time", "endedAt", "call.ended_at"));
  let durationSeconds = num(pick(data, "duration_seconds", "duration_sec", "durationSeconds", "duration"));
  if (durationSeconds === null && startedAt && endedAt) durationSeconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
  return {
    providerCallId: str(pick(data, "call_id", "callId", "session_id", "sessionId", "call.id", "usage_id", "id")),
    startedAt,
    endedAt,
    durationSeconds,
    callerPhone: str(pick(data, "caller_phone", "from", "phone", "caller", "customer_phone", "call.from")),
    transcript,
    turns,
    failureReason: str(pick(data, "error", "reason", "failure_reason", "error_message")),
    recordingReference: str(pick(data, "recording_url", "recording", "recordingUrl")),
    costPaise: num(pick(data, "cost_paise", "costPaise")),
    flowId: str(pick(data, "flow_id", "flowId")),
    surface: str(pick(data, "surface")),
  };
}
