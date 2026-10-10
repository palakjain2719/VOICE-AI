import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { processJobs } from "@/server/runtime";
import { store } from "@/server/store/supabase-store";

const Body = z.object({ lead_id: z.uuid() });

/** Queues and runs an idempotent contact/deal sync for one eligible lead. */
export const POST = handle("hubspot.sync_lead", async (req: Request) => {
  const user = await requireRole("operator");
  const { lead_id } = await readJson(req, (v) => Body.parse(v));
  const s = store();
  const key = `hubspot:${lead_id}:manual`;
  if (await s.getJobByKey(key)) await s.resetJob(key);
  else await s.enqueueJob("hubspot_sync_lead", { lead_id, reason: "manual" }, key);
  await s.audit({ actor_id: actorId(user), action: "hubspot.sync_lead", entity_type: "lead", entity_id: lead_id });
  const r = await processJobs({ limit: 1, types: ["hubspot_sync_lead"] });
  return NextResponse.json({ ok: r.every((x) => x.ok), error: r.find((x) => !x.ok)?.error });
});
