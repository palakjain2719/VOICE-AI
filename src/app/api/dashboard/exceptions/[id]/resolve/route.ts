import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handle, HttpError, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { store } from "@/server/store/supabase-store";

const Body = z.object({ status: z.enum(["resolved", "dismissed"]), resolution: z.string().trim().min(1).max(2000) });

export const POST = handle("exceptions.resolve", async (req: NextRequest, ctx: RouteContext<"/api/dashboard/exceptions/[id]/resolve">) => {
  const user = await requireRole("operator");
  const { id } = await ctx.params;
  const body = await readJson(req, (v) => Body.parse(v));
  const db = createAdminClient();
  const { data: before } = await db.from("exceptions").select("id, status, kind").eq("id", id).maybeSingle();
  if (!before) throw new HttpError(404, "Not found", "not_found");
  const { error } = await db
    .from("exceptions")
    .update({ status: body.status, resolution: body.resolution, resolved_by: actorId(user), resolved_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
  await store().audit({ actor_id: actorId(user), action: `exception.${body.status}`, entity_type: "exception", entity_id: id, before, after: body });
  return NextResponse.json({ ok: true });
});
