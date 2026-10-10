import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { liveDeps } from "@/server/runtime";
import { bookLive, BookingRefused } from "@/server/services/live-call";
import { store } from "@/server/store/supabase-store";

const Body = z.object({ lead_id: z.uuid(), slot_start: z.iso.datetime({ offset: true }), designer_id: z.uuid(), email: z.email().nullish() });

/** Operator booking for a qualified lead (e.g. after the caller couldn't book on the call). Same revalidation and idempotency as live booking. */
export const POST = handle("calendar.book", async (req: Request) => {
  const user = await requireRole("operator");
  const body = await readJson(req, (v) => Body.parse(v));
  const s = store();
  const lead = await s.getLead(body.lead_id);
  const call = lead?.last_call_id ? await s.getCall(lead.last_call_id) : null;
  if (!lead || !call?.provider_call_id) throw new HttpError(404, "Lead not found", "not_found");
  try {
    const r = await bookLive(liveDeps(), { call_id: call.provider_call_id, caller_phone: null, slot_start: body.slot_start, designer_id: body.designer_id, email: body.email ?? lead.email, idempotency_key: `manual:${lead.id}:${body.slot_start}:${body.designer_id}` });
    await s.audit({ actor_id: actorId(user), action: "appointment.book_manual", entity_type: "lead", entity_id: lead.id, after: { status: r.status } });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof BookingRefused) throw new HttpError(409, e.message, e.code);
    throw e;
  }
});
