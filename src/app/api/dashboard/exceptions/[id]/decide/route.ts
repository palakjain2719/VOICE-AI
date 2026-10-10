import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handle, HttpError, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { store } from "@/server/store/supabase-store";
import { decideException } from "@/server/services/review";
import { processJobs } from "@/server/runtime";

const Body = z.object({
  decision: z.enum(["approve", "reject", "route_admin", "route_callback", "route_designer"]),
  note: z.string().trim().max(1000).nullish(),
});

/** Review-queue / front-desk decision: approve, decline, or route to another lane. */
export const POST = handle("exceptions.decide", async (req: NextRequest, ctx: RouteContext<"/api/dashboard/exceptions/[id]/decide">) => {
  const user = await requireRole("operator", "designer");
  const { id } = await ctx.params;
  const body = await readJson(req, (v) => Body.parse(v));
  try {
    const r = await decideException(store(), { exceptionId: id, decision: body.decision, actorId: actorId(user), note: body.note });
    await processJobs({ limit: 3, types: ["hubspot_sync_lead", "send_closure_email"] }).catch(() => undefined);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof Error && /not found|Already closed/.test(e.message)) throw new HttpError(409, e.message, "invalid_state");
    throw e;
  }
});
