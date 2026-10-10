import { NextResponse } from "next/server";
import { handle } from "@/server/http";
import { requireRole } from "@/server/auth";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/server";

/** Safe Vaani status: which settings are present (never their values) and the last webhook seen. */
export const GET = handle("vaani.status", async () => {
  await requireRole("admin");
  const e = env();
  const db = createAdminClient();
  const [{ data: last }, { data: status }] = await Promise.all([
    db.from("integration_events").select("event_type, status, received_at, safe_error").eq("provider", "vaani").order("received_at", { ascending: false }).limit(5),
    db.from("integration_status").select("*").eq("provider", "vaani").maybeSingle(),
  ]);
  return NextResponse.json({
    configured: { api_key: !!e.VAANI_API_KEY && e.VAANI_API_KEY.startsWith("vv_live_"), webhook_secret: !!e.VAANI_WEBHOOK_SECRET, voice_tool_secret: !!e.VOICE_TOOL_SECRET, flow_id: !!e.VAANI_FLOW_ID },
    webhook_url: e.APP_BASE_URL ? `${e.APP_BASE_URL}/api/webhooks/vaani` : null,
    recent_events: last ?? [],
    health: status ?? null,
  });
});
