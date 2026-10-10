import "server-only";
import { after } from "next/server";
import { env, isConfigured, PROVIDER_ENV, requireEnv } from "@/lib/env";
import { log, safeErrorMessage } from "@/lib/log";
import { gemini } from "@/integrations/gemini/client";
import { articleSelector, extractCall } from "@/integrations/gemini/tasks";
import { GoogleAuthError, googleCalendar, type CalendarApi, type GoogleOAuthConfig } from "@/integrations/google/calendar";
import { hubspotClient } from "@/integrations/hubspot/client";
import { resendSender } from "@/integrations/resend/email";
import { store } from "@/server/store/supabase-store";
import type { DesignerRow } from "@/server/store/types";
import { loadEscalationPolicy, loadPipelineMapping } from "@/server/settings";
import type { LiveDeps } from "./services/live-call";
import type { PostCallDeps } from "./services/post-call";
import { processVaaniEvent } from "./services/post-call";
import { sendConsultationConfirmation } from "./services/confirmation";
import { syncDealsFromHubSpot, syncLeadToHubSpot } from "./services/hubspot-sync";
import { parseVaaniJob, runJobs, type JobHandler } from "./services/jobs";
import { deliverTeamMessage, handoffToDesigner, sendClosureEmail } from "./services/team";

export function googleOAuthConfig(): GoogleOAuthConfig {
  const e = requireEnv("google_calendar", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "TOKEN_ENCRYPTION_KEY"]);
  return { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, redirectUri: e.GOOGLE_REDIRECT_URI, encryptionKey: e.TOKEN_ENCRYPTION_KEY };
}

async function calendarFor(designer: DesignerRow): Promise<CalendarApi> {
  if (!designer.google_credential_id || !designer.calendar_id) throw new GoogleAuthError(`Designer ${designer.name} has no connected calendar`);
  const cred = await store().getGoogleCredential(designer.google_credential_id);
  if (!cred || cred.status === "revoked") throw new GoogleAuthError(`Calendar for ${designer.name} needs to be reconnected`);
  return googleCalendar(cred, googleOAuthConfig(), store());
}

export function hubspot() {
  return hubspotClient(requireEnv("hubspot", ["HUBSPOT_SERVICE_KEY"]).HUBSPOT_SERVICE_KEY);
}

export function liveDeps(): LiveDeps {
  const geminiReady = isConfigured(PROVIDER_ENV.gemini);
  return {
    store: store(),
    now: () => new Date(),
    selector: geminiReady ? articleSelector(gemini()) : undefined,
    calendarFor,
    kick: () => after(() => processJobs({ limit: 5 }).catch((e) => log.error("jobs.kick_failed", { error: safeErrorMessage(e) }))),
  };
}

export function postCallDeps(): PostCallDeps {
  const geminiReady = isConfigured(PROVIDER_ENV.gemini);
  return {
    store: store(),
    now: () => new Date(),
    extract: geminiReady ? (t, d) => extractCall(gemini(), t, d) : undefined,
  };
}

export function emailSender() {
  const e = env();
  return e.RESEND_API_KEY && e.EMAIL_FROM ? resendSender(e.RESEND_API_KEY, e.EMAIL_FROM) : null;
}

const handlers: Record<string, JobHandler> = {
  async process_vaani_event(job) {
    const { envelope, integrationEventId } = parseVaaniJob(job);
    const s = store();
    await s.updateIntegrationEvent(integrationEventId, { status: "processing", retry_count: job.attempts - 1 });
    try {
      const r = await processVaaniEvent(postCallDeps(), envelope, integrationEventId);
      await s.updateIntegrationEvent(integrationEventId, { status: "succeeded", processed_at: new Date().toISOString(), safe_error: null });
      await s.recordIntegrationHealth("vaani", true, `webhook:${envelope.type}`);
      log.info("vaani.event_processed", { type: envelope.type, outcome: r.outcome });
    } catch (e) {
      await s.updateIntegrationEvent(integrationEventId, { status: "failed", safe_error: safeErrorMessage(e), retry_count: job.attempts, requires_human: job.attempts >= job.max_attempts });
      throw e;
    }
  },
  async send_confirmation_email(job) {
    await sendConsultationConfirmation({ store: store(), sender: emailSender() }, String(job.payload.appointment_id));
  },
  async hubspot_sync_lead(job) {
    const s = store();
    const r = await syncLeadToHubSpot(String(job.payload.lead_id), { store: s, hs: hubspot(), mapping: await loadPipelineMapping(s), appBaseUrl: env().APP_BASE_URL ?? null });
    await s.recordIntegrationHealth("hubspot", true, r.dealCreated ? "deal.create" : "deal.update");
    // A deal with an owner reaches the designer's HubSpot queue: that counts as the handoff if no email went first.
    const lead = await s.getLead(String(job.payload.lead_id));
    if (lead && !lead.handoff_at && lead.assigned_designer_id) await s.updateLead(lead.id, { handoff_at: new Date().toISOString(), handoff_channel: "hubspot" });
    await s.recordIntegrationEvent({ provider: "hubspot", event_type: "sync_lead", external_event_id: `${job.idempotency_key}`, direction: "outbound", related_lead_id: String(job.payload.lead_id), payload: { contact_id: r.contactId, deal_id: r.dealId, stage: r.stage } })
      .then((ev) => s.updateIntegrationEvent(ev.id, { status: "succeeded", external_record_id: r.dealId, processed_at: new Date().toISOString() }));
  },
  async hubspot_sync_deals() {
    const s = store();
    try {
      const r = await syncDealsFromHubSpot({ store: s, hs: hubspot(), mapping: await loadPipelineMapping(s) });
      await s.recordIntegrationHealth("hubspot", true, "deals.sync", null, { fetched: r.fetched });
    } catch (e) {
      await s.setCursor("hubspot_deals", null, safeErrorMessage(e));
      throw e;
    }
  },
  async notify_escalation(job) {
    const s = store();
    const policy = await loadEscalationPolicy(s);
    const sender = emailSender();
    if (!sender || !policy.notifyEmails.length) throw new Error("No notification channel configured");
    const base = env().APP_BASE_URL ?? "";
    for (const to of policy.notifyEmails) {
      await sender.send({
        to,
        subject: "Priority: existing-client complaint received by the voice assistant",
        text: `A complaint was logged and needs a senior owner.\n\nOpen the review queue: ${base}/exceptions/${job.payload.exception_id}`,
        html: `<p>A complaint was logged and needs a senior owner.</p><p><a href="${base}/exceptions/${job.payload.exception_id}">Open it in the review queue</a></p>`,
        idempotencyKey: `notify-${job.payload.exception_id}-${to}`,
      });
    }
    await s.markExceptionNotified(String(job.payload.exception_id));
  },
  async designer_handoff(job) {
    await handoffToDesigner({ store: store(), sender: emailSender(), appBaseUrl: env().APP_BASE_URL ?? null }, String(job.payload.lead_id), job.payload.appointment_id ? String(job.payload.appointment_id) : null);
  },
  async notify_message(job) {
    await deliverTeamMessage({ store: store(), sender: emailSender(), appBaseUrl: env().APP_BASE_URL ?? null }, String(job.payload.message_id));
  },
  async send_closure_email(job) {
    await sendClosureEmail({ store: store(), sender: emailSender(), appBaseUrl: env().APP_BASE_URL ?? null }, String(job.payload.lead_id), String(job.payload.slug));
  },
};

export function processJobs(opts: { limit?: number; types?: string[] } = {}) {
  return runJobs(store(), handlers, opts);
}
