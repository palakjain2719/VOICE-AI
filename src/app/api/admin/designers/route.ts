import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { store } from "@/server/store/supabase-store";

const Fields = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().nullable().optional(),
  hubspot_owner_id: z.string().trim().regex(/^\d+$/).nullable().optional(),
  calendar_id: z.string().trim().max(300).nullable().optional(),
  active: z.boolean().optional(),
  booking_enabled: z.boolean().optional(),
  app_user_id: z.uuid().nullable().optional(),
});
const Body = z.union([z.object({ id: z.uuid() }).extend(Fields.partial().shape), Fields]);

export const POST = handle("admin.designers", async (req: Request) => {
  const user = await requireRole("admin");
  const body = await readJson(req, (v) => Body.parse(v));
  const db = createAdminClient();
  if ("id" in body && body.id) {
    const { id, ...patch } = body;
    const { data: before } = await db.from("designers").select("*").eq("id", id).maybeSingle();
    if (!before) throw new HttpError(404, "Designer not found", "not_found");
    if (patch.booking_enabled && !(patch.calendar_id ?? before.calendar_id) ) throw new HttpError(400, "Connect a calendar before enabling booking.", "calendar_required");
    const { error } = await db.from("designers").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
    await store().audit({ actor_id: actorId(user), action: "designer.update", entity_type: "designer", entity_id: id, before, after: patch });
    return NextResponse.json({ ok: true });
  }
  const { data, error } = await db.from("designers").insert({ ...body, booking_enabled: false }).select("id").single();
  if (error) throw new Error(error.message);
  await store().audit({ actor_id: actorId(user), action: "designer.create", entity_type: "designer", entity_id: data.id, after: body });
  return NextResponse.json({ ok: true, id: data.id });
});
