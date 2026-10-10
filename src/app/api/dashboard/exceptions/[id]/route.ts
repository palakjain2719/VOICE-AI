import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handle, HttpError, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { store } from "@/server/store/supabase-store";

const Patch = z.object({
  status: z.enum(["open", "in_review"]).optional(),
  owner_id: z.uuid().nullable().optional(),
  note: z.string().trim().min(1).max(2000).optional(),
});

export const PATCH = handle("exceptions.patch", async (req: NextRequest, ctx: RouteContext<"/api/dashboard/exceptions/[id]">) => {
  const user = await requireRole("operator");
  const { id } = await ctx.params;
  const body = await readJson(req, (v) => Patch.parse(v));
  const db = createAdminClient();
  const { data: before } = await db.from("exceptions").select("id, status, owner_id").eq("id", id).maybeSingle();
  if (!before) throw new HttpError(404, "Not found", "not_found");
  const patch: Record<string, unknown> = {};
  if (body.status) patch.status = body.status;
  if (body.status === "open") Object.assign(patch, { resolution: null, resolved_at: null, resolved_by: null });
  if (body.status === "in_review") patch.acknowledged_at = new Date().toISOString();
  if (body.owner_id !== undefined) patch.owner_id = body.owner_id;
  if (Object.keys(patch).length) {
    const { error } = await db.from("exceptions").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
  }
  if (body.note) {
    const { error } = await db.from("exception_notes").insert({ exception_id: id, author_id: actorId(user), body: body.note });
    if (error) throw new Error(error.message);
  }
  await store().audit({ actor_id: actorId(user), action: "exception.update", entity_type: "exception", entity_id: id, before, after: { ...patch, note_added: !!body.note } });
  return NextResponse.json({ ok: true });
});
