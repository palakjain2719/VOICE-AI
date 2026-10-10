import "server-only";
import { requireEnv, env } from "@/lib/env";

const BASE = "https://www.vaanilabs.in";

/**
 * The documented public API (Bearer vv_live_ key) only mints WebSocket sessions and meeting
 * rooms; every endpoint is billable (a 100-paise reservation is held at session open). There is
 * no read-only "ping" endpoint, so the connection test is an explicit admin action.
 */
export async function mintTestSession(): Promise<{ ok: boolean; status: number; error?: string; expiresAt?: number }> {
  const { VAANI_API_KEY } = requireEnv("vaani", ["VAANI_API_KEY"]);
  const flowId = env().VAANI_FLOW_ID;
  const res = await fetch(`${BASE}/api/public/v1/textvoice/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${VAANI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(flowId ? { flow_id: flowId } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; expires_at?: number };
  // Deliberately never return ws_url / ws_token: they are bearer credentials.
  return { ok: res.ok, status: res.status, error: res.ok ? undefined : body.error ?? `HTTP ${res.status}`, expiresAt: body.expires_at };
}
