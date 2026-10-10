import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { googleCalendar } from "@/integrations/google/calendar";
import { googleOAuthConfig } from "@/server/runtime";
import { store } from "@/server/store/supabase-store";

const Body = z.object({ appointment_id: z.uuid(), reason: z.string().trim().min(3).max(500) });

/** Cancels the calendar event first; the appointment is marked cancelled only if that succeeds. */
export const POST = handle("calendar.cancel", async (req: Request) => {
  const user = await requireRole("operator");
  const body = await readJson(req, (v) => Body.parse(v));
  const s = store();
  const appt = await s.getAppointment(body.appointment_id);
  if (!appt) throw new HttpError(404, "Appointment not found", "not_found");
  if (appt.status !== "confirmed" && appt.status !== "pending") throw new HttpError(409, `Appointment is ${appt.status}`, "invalid_state");
  const designer = appt.designer_id ? await s.getDesigner(appt.designer_id) : null;
  if (appt.provider_event_id && designer?.google_credential_id && appt.provider_calendar_id) {
    const cred = await s.getGoogleCredential(designer.google_credential_id);
    if (!cred) throw new HttpError(409, "Designer calendar is disconnected; reconnect before cancelling.", "calendar_unavailable");
    await googleCalendar(cred, googleOAuthConfig(), s).cancelEvent(appt.provider_calendar_id, appt.provider_event_id);
  }
  await s.updateAppointment(appt.id, { status: "cancelled", failure_reason: body.reason });
  await s.addLeadEvent({ lead_id: appt.lead_id, call_id: appt.call_id, event_type: "cancelled", dedupe_key: `appt:${appt.id}`, metadata: { reason: body.reason }, is_test: appt.is_test });
  await s.enqueueJob("hubspot_sync_lead", { lead_id: appt.lead_id, reason: "cancelled" }, `hubspot:${appt.lead_id}:cancel:${appt.id}`);
  await s.audit({ actor_id: actorId(user), action: "appointment.cancel", entity_type: "appointment", entity_id: appt.id, after: { reason: body.reason } });
  return NextResponse.json({ ok: true });
});
