import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handle, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { store } from "@/server/store/supabase-store";

const Body = z.object({ status: z.enum(["open", "done"]) });

export const PATCH = handle("messages.update", async (req: NextRequest, ctx: RouteContext<"/api/messages/[id]">) => {
  const user = await requireRole("operator", "designer");
  const { id } = await ctx.params;
  const { status } = await readJson(req, (v) => Body.parse(v));
  const { error } = await createAdminClient().from("team_messages").update({ status, done_by: status === "done" ? actorId(user) : null, done_at: status === "done" ? new Date().toISOString() : null }).eq("id", id);
  if (error) throw new Error(error.message);
  await store().audit({ actor_id: actorId(user), action: `message.${status}`, entity_type: "team_message", entity_id: id });
  return NextResponse.json({ ok: true });
});
