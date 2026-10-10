import { NextResponse } from "next/server";
import { after } from "next/server";
import { requireEnv } from "@/lib/env";
import { log, safeErrorMessage } from "@/lib/log";
import { VaaniEnvelopeSchema, verifyVaaniSignature } from "@/integrations/vaani/webhook";
import { store } from "@/server/store/supabase-store";
import { clientIp, handle, HttpError, rateLimit } from "@/server/http";
import { processJobs } from "@/server/runtime";

/**
 * Receives signed Vaani events. Verifies the HMAC over the raw body, de-duplicates on the
 * stable `evt_` id, stores the event and queues processing. Acknowledges fast (Vaani times out
 * at 10s and retries up to 8 times); the work itself runs after the response.
 */
export const POST = handle("webhook.vaani", async (req: Request) => {
  const { VAANI_WEBHOOK_SECRET } = requireEnv("vaani", ["VAANI_WEBHOOK_SECRET"]);
  await rateLimit(`vaani-webhook:${clientIp(req)}`, 300);
  const raw = await req.text();
  if (raw.length > 1_000_000) throw new HttpError(413, "Payload too large", "payload_too_large");
  if (!verifyVaaniSignature(raw, req.headers.get("x-vaanivoice-signature"), VAANI_WEBHOOK_SECRET)) {
    log.warn("webhook.vaani.bad_signature", { ip: clientIp(req) });
    throw new HttpError(401, "Invalid signature", "invalid_signature");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON", "invalid_json");
  }
  const envelope = VaaniEnvelopeSchema.parse(json);
  const s = store();
  const ev = await s.recordIntegrationEvent({
    provider: "vaani",
    event_type: envelope.type,
    external_event_id: envelope.id,
    payload: { type: envelope.type, created: envelope.created, delivery: req.headers.get("x-vaanivoice-delivery"), data_keys: Object.keys(envelope.data) },
  });
  if (ev.duplicate) return NextResponse.json({ ok: true, duplicate: true });

  await s.enqueueJob("process_vaani_event", { envelope, integration_event_id: ev.id }, `vaani:${envelope.id}`);
  after(() => processJobs({ limit: 3, types: ["process_vaani_event", "hubspot_sync_lead"] }).catch((e) => log.error("webhook.vaani.process_failed", { error: safeErrorMessage(e) })));
  return NextResponse.json({ ok: true });
});
