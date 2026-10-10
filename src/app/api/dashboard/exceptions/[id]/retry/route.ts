import { NextResponse, type NextRequest } from "next/server";
import { handle, HttpError } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { store } from "@/server/store/supabase-store";
import { processJobs } from "@/server/runtime";

/**
 * Retries the integration behind an exception. Retries go through the same idempotent job
 * (keyed per appointment / lead), so a retry can't send a second email or create a second deal.
 */
export const POST = handle("exceptions.retry", async (_req: NextRequest, ctx: RouteContext<"/api/dashboard/exceptions/[id]/retry">) => {
  const user = await requireRole("operator");
  const { id } = await ctx.params;
  const db = createAdminClient();
  const { data: ex } = await db.from("exceptions").select("id, kind, retryable, job_id, lead_id, appointment_id").eq("id", id).maybeSingle();
  if (!ex) throw new HttpError(404, "Not found", "not_found");
  if (!ex.retryable) throw new HttpError(400, "This item can't be retried automatically.", "not_retryable");
  const s = store();
  let key: string | null = null;
  if (ex.job_id) {
    const { data: job } = await db.from("jobs").select("idempotency_key").eq("id", ex.job_id).maybeSingle();
    key = job?.idempotency_key ?? null;
  } else if (ex.kind === "email_failure" && ex.appointment_id) {
    key = `email:${ex.appointment_id}`;
  } else if (ex.kind === "hubspot_failure" && ex.lead_id) {
    key = `hubspot:${ex.lead_id}:manual`;
    await s.enqueueJob("hubspot_sync_lead", { lead_id: ex.lead_id, reason: "manual_retry" }, key);
  }
  if (!key) throw new HttpError(400, "Nothing to retry for this item.", "not_retryable");
  const existing = await s.getJobByKey(key);
  if (!existing && ex.kind === "email_failure" && ex.appointment_id) await s.enqueueJob("send_confirmation_email", { appointment_id: ex.appointment_id }, key);
  else await s.resetJob(key);
  await db.from("exceptions").update({ status: "in_review", acknowledged_at: new Date().toISOString() }).eq("id", id);
  await s.audit({ actor_id: actorId(user), action: "exception.retry", entity_type: "exception", entity_id: id, after: { job_key: key } });
  const results = await processJobs({ limit: 3 });
  return NextResponse.json({ ok: true, ran: results.length, failed: results.filter((r) => !r.ok).length });
});
