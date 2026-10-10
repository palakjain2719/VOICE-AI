import { NextResponse, type NextRequest } from "next/server";
import { handle, HttpError } from "@/server/http";
import { requireRole } from "@/server/auth";
import { liveDeps } from "@/server/runtime";
import { availabilityLive, BookingRefused } from "@/server/services/live-call";
import { store } from "@/server/store/supabase-store";

/** Real free slots for an eligible lead (operator follow-up booking). */
export const GET = handle("calendar.availability", async (req: NextRequest) => {
  await requireRole("operator");
  const leadId = req.nextUrl.searchParams.get("lead_id") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(leadId)) throw new HttpError(400, "lead_id required", "invalid_request");
  const s = store();
  const lead = await s.getLead(leadId);
  const call = lead?.last_call_id ? await s.getCall(lead.last_call_id) : null;
  if (!lead || !call?.provider_call_id) throw new HttpError(404, "Lead not found", "not_found");
  const dates = req.nextUrl.searchParams.getAll("date").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  try {
    return NextResponse.json(await availabilityLive(liveDeps(), { call_id: call.provider_call_id, caller_phone: null, preferred_dates: dates.length ? dates : undefined }));
  } catch (e) {
    if (e instanceof BookingRefused) throw new HttpError(409, e.message, e.code);
    throw e;
  }
});
