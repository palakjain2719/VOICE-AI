import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { log, safeErrorMessage } from "@/lib/log";
import { exchangeCode, googleCalendar } from "@/integrations/google/calendar";
import { googleOAuthConfig } from "@/server/runtime";
import { store } from "@/server/store/supabase-store";
import { getCurrentUser, hasRole, actorId } from "@/server/auth";

/**
 * OAuth callback: validates the one-time state (CSRF), stores the refresh token encrypted and
 * links the credential to the designer. Defaults the designer's calendar to their primary one.
 */
export async function GET(req: NextRequest) {
  const back = (q: string) => NextResponse.redirect(new URL(`/settings?tab=designers&${q}`, req.url));
  const state = req.nextUrl.searchParams.get("state");
  const code = req.nextUrl.searchParams.get("code");
  if (req.nextUrl.searchParams.get("error") || !state || !code) return back("google=denied");
  const user = await getCurrentUser();
  if (!user || !hasRole(user, "admin")) return back("google=forbidden");
  const db = createAdminClient();
  const { data: st } = await db.from("oauth_states").select("*").eq("state", state).maybeSingle();
  if (!st || st.used_at || new Date(st.expires_at) < new Date() || st.created_by !== actorId(user)) return back("google=expired");
  await db.from("oauth_states").update({ used_at: new Date().toISOString() }).eq("state", state);
  try {
    const cfg = googleOAuthConfig();
    const t = await exchangeCode(cfg, code);
    const { data: cred, error } = await db
      .from("google_credentials")
      .upsert({ google_account_email: t.email, refresh_token_encrypted: t.refreshTokenEncrypted, access_token_encrypted: t.accessTokenEncrypted, access_token_expires_at: t.expiresAt, scopes: t.scopes, status: "active", last_error: null, connected_by: actorId(user) }, { onConflict: "google_account_email" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    const cals = await googleCalendar(cred, cfg, store()).listCalendars();
    const primary = cals.find((c) => c.primary)?.id ?? null;
    const { data: designer } = await db.from("designers").select("calendar_id").eq("id", st.designer_id).single();
    await db.from("designers").update({ google_credential_id: cred.id, calendar_id: designer?.calendar_id ?? primary }).eq("id", st.designer_id);
    await store().audit({ actor_id: actorId(user), action: "google.connect", entity_type: "designer", entity_id: st.designer_id, after: { calendars_available: cals.length } });
    await store().recordIntegrationHealth("google_calendar", true, "oauth.connect");
    return back("google=connected");
  } catch (e) {
    log.error("google.callback_failed", { error: safeErrorMessage(e) });
    await store().recordIntegrationHealth("google_calendar", false, "oauth.connect", safeErrorMessage(e));
    return back("google=failed");
  }
}
