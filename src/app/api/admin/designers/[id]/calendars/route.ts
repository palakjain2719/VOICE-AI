import { NextResponse, type NextRequest } from "next/server";
import { handle, HttpError } from "@/server/http";
import { requireRole } from "@/server/auth";
import { store } from "@/server/store/supabase-store";
import { googleCalendar } from "@/integrations/google/calendar";
import { calcom, calendarProvider, googleOAuthConfig } from "@/server/runtime";

/** Writable calendars on the designer's connected Google account, for choosing the booking calendar. */
export const GET = handle("admin.designer_calendars", async (_req: NextRequest, ctx: RouteContext<"/api/admin/designers/[id]/calendars">) => {
  await requireRole("admin");
  const { id } = await ctx.params;
  const s = store();
  const d = await s.getDesigner(id);
  if (calendarProvider() === "calcom") return NextResponse.json({ calendars: await calcom().listCalendars() });
  if (!d?.google_credential_id) throw new HttpError(400, "No Google account connected for this designer.", "not_connected");
  const cred = await s.getGoogleCredential(d.google_credential_id);
  if (!cred) throw new HttpError(400, "Credential missing; reconnect.", "not_connected");
  return NextResponse.json({ calendars: await googleCalendar(cred, googleOAuthConfig(), s).listCalendars() });
});
