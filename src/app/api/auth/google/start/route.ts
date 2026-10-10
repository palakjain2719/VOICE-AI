import { NextResponse, type NextRequest } from "next/server";
import { handle, HttpError } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { randomToken } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { buildAuthUrl } from "@/integrations/google/calendar";
import { googleOAuthConfig } from "@/server/runtime";

/** Starts Google OAuth for a designer's calendar. The designer signs in with their own Google account. */
export const GET = handle("google.start", async (req: NextRequest) => {
  const user = await requireRole("admin");
  const designerId = req.nextUrl.searchParams.get("designer_id");
  if (!designerId || !/^[0-9a-f-]{36}$/.test(designerId)) throw new HttpError(400, "designer_id required", "invalid_request");
  const cfg = googleOAuthConfig();
  const state = randomToken(24);
  const { error } = await createAdminClient().from("oauth_states").insert({ state, designer_id: designerId, created_by: actorId(user), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
  if (error) throw new Error(error.message);
  return NextResponse.redirect(buildAuthUrl(cfg, state));
});
