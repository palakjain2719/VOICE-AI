import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handle, HttpError, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { store } from "@/server/store/supabase-store";

const Body = z.object({ roles: z.array(z.enum(["founder", "operator", "designer", "admin"])).max(4).optional(), active: z.boolean().optional(), display_name: z.string().trim().max(80).nullable().optional() });

export const PATCH = handle("admin.users", async (req: NextRequest, ctx: RouteContext<"/api/admin/users/[id]">) => {
  const user = await requireRole("admin");
  const { id } = await ctx.params;
  const body = await readJson(req, (v) => Body.parse(v));
  if (id === user.id && (body.active === false || (body.roles && !body.roles.includes("admin")))) throw new HttpError(400, "You can't remove your own admin access.", "self_lockout");
  const db = createAdminClient();
  const { data: before } = await db.from("app_users").select("roles, active, display_name").eq("id", id).maybeSingle();
  if (!before) throw new HttpError(404, "User not found", "not_found");
  const { error } = await db.from("app_users").update(body).eq("id", id);
  if (error) throw new Error(error.message);
  await store().audit({ actor_id: actorId(user), action: "user.update", entity_type: "app_user", entity_id: id, before, after: body });
  return NextResponse.json({ ok: true });
});
