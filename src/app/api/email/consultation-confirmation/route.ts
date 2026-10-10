import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { processJobs } from "@/server/runtime";
import { store } from "@/server/store/supabase-store";

const Body = z.object({ appointment_id: z.uuid() });

/** (Re)sends the confirmation for an existing confirmed booking through the idempotent email job. */
export const POST = handle("email.confirmation", async (req: Request) => {
  const user = await requireRole("operator");
  const { appointment_id } = await readJson(req, (v) => Body.parse(v));
  const s = store();
  const key = `email:${appointment_id}`;
  if (await s.getJobByKey(key)) await s.resetJob(key);
  else await s.enqueueJob("send_confirmation_email", { appointment_id }, key);
  await s.audit({ actor_id: actorId(user), action: "email.confirmation_retry", entity_type: "appointment", entity_id: appointment_id });
  const r = await processJobs({ limit: 1, types: ["send_confirmation_email"] });
  return NextResponse.json({ ok: r.every((x) => x.ok), results: r.map((x) => ({ ok: x.ok })) });
});
