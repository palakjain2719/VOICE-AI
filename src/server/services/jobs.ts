import { VaaniEnvelopeSchema } from "@/integrations/vaani/webhook";
import { HubSpotError } from "@/integrations/hubspot/client";
import { log, safeErrorMessage } from "@/lib/log";
import type { JobRow, Store } from "@/server/store/types";
import { HubSpotSetupError } from "./hubspot-sync";

export type JobHandler = (job: JobRow) => Promise<void>;

/** Exponential backoff: 1, 2, 4, 8 … minutes, capped at 6 hours. */
export function nextRetryAt(attempts: number, now = new Date()): string {
  const minutes = Math.min(2 ** Math.max(0, attempts - 1), 360);
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

/** Errors that will not fix themselves on retry: configuration and permission problems. */
function isPermanent(e: unknown): boolean {
  if (e instanceof HubSpotSetupError) return true;
  if (e instanceof HubSpotError) return !e.retryable;
  return false;
}

const EXCEPTION_FOR: Record<string, { kind: "hubspot_failure" | "email_failure" | "missing_information" | "failed_call"; title: string }> = {
  hubspot_sync_lead: { kind: "hubspot_failure", title: "HubSpot sync failed" },
  send_confirmation_email: { kind: "email_failure", title: "Confirmation email failed" },
  process_vaani_event: { kind: "failed_call", title: "Call record could not be processed" },
  notify_escalation: { kind: "missing_information", title: "Escalation notification failed" },
  designer_handoff: { kind: "email_failure", title: "Designer handoff email failed" },
  notify_message: { kind: "email_failure", title: "Message delivery to designer failed" },
  send_closure_email: { kind: "email_failure", title: "Closing email failed" },
};

export async function runJobs(store: Store, handlers: Record<string, JobHandler>, opts: { limit?: number; types?: string[] } = {}) {
  const jobs = await store.claimJobs(opts.limit ?? 10, opts.types);
  const results: { id: string; type: string; ok: boolean; error?: string }[] = [];
  for (const job of jobs) {
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job);
      await store.completeJob(job.id);
      results.push({ id: job.id, type: job.type, ok: true });
    } catch (e) {
      const msg = safeErrorMessage(e);
      const permanent = isPermanent(e);
      const exhausted = job.attempts >= job.max_attempts;
      await store.failJob(job.id, msg, permanent || exhausted ? null : nextRetryAt(job.attempts));
      if (job.type === "hubspot_sync_lead" && typeof job.payload.lead_id === "string") {
        await store.updateLead(job.payload.lead_id, { hubspot_sync_status: "failed" }).catch(() => undefined);
        await store.recordIntegrationHealth("hubspot", false, "sync_lead", msg, e instanceof HubSpotError && e.missingScopes.length ? { missing_scopes: e.missingScopes } : undefined);
      }
      if (permanent || exhausted || job.attempts >= 3) {
        const meta = EXCEPTION_FOR[job.type] ?? { kind: "missing_information" as const, title: `Background job failed: ${job.type}` };
        await store.upsertException({
          kind: meta.kind,
          title: meta.title,
          detail: `${permanent ? "Needs setup or permission changes" : exhausted ? "Retries exhausted" : `Attempt ${job.attempts} failed; still retrying`}: ${msg}`,
          severity: permanent || exhausted ? "high" : "normal",
          lead_id: typeof job.payload.lead_id === "string" ? job.payload.lead_id : null,
          appointment_id: typeof job.payload.appointment_id === "string" ? job.payload.appointment_id : null,
          job_id: job.id,
          retryable: true,
          dedupe_key: `job:${job.idempotency_key}`,
        });
      }
      log.warn("job.failed", { type: job.type, attempts: job.attempts, permanent, error: msg });
      results.push({ id: job.id, type: job.type, ok: false, error: msg });
    }
  }
  return results;
}

export function parseVaaniJob(job: JobRow) {
  return { envelope: VaaniEnvelopeSchema.parse(job.payload.envelope), integrationEventId: String(job.payload.integration_event_id) };
}
