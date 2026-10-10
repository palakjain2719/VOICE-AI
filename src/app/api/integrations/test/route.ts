import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, readJson, rateLimit } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { env } from "@/lib/env";
import { safeErrorMessage } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/server";
import { store } from "@/server/store/supabase-store";
import { gemini } from "@/integrations/gemini/client";
import { mintTestSession } from "@/integrations/vaani/client";
import { ensureProperties, probeScopes } from "@/integrations/hubspot/properties";
import { googleCalendar } from "@/integrations/google/calendar";
import { calcom, googleOAuthConfig, hubspot } from "@/server/runtime";

const Body = z.object({
  provider: z.enum(["supabase", "gemini", "hubspot", "hubspot_properties", "resend", "google_calendar", "calcom", "vaani_session"]),
  designer_id: z.uuid().optional(),
});

/**
 * Connection checks. All are read-only except two clearly labelled actions:
 * `hubspot_properties` creates Aangan's custom properties, and `vaani_session` mints a
 * short-lived session (Vaani has no free read-only endpoint; a 100-paise hold is reconciled on close).
 */
export const POST = handle("integrations.test", async (req: Request) => {
  const user = await requireRole("admin");
  await rateLimit(`integration-test:${user.id}`, 20);
  const { provider, designer_id } = await readJson(req, (v) => Body.parse(v));
  const s = store();
  const record = async (key: string, ok: boolean, op: string, err?: string, details?: Record<string, unknown>) => s.recordIntegrationHealth(key, ok, op, err ?? null, details);
  try {
    switch (provider) {
      case "supabase": {
        const { error } = await createAdminClient().from("integration_status").select("provider").limit(1);
        if (error) throw new Error(error.message);
        await record("supabase", true, "query");
        return NextResponse.json({ ok: true, message: "Database reachable with the server key." });
      }
      case "gemini": {
        const r = await gemini().generateJson({ system: "Reply with JSON only.", prompt: 'Return {"ok": true}.', schema: z.object({ ok: z.boolean() }), maxOutputTokens: 512 });
        await record("gemini", true, "generateContent", undefined, { model: r.usage.model });
        return NextResponse.json({ ok: r.data.ok, message: `Model ${r.usage.model} responded with valid structured output.` });
      }
      case "hubspot": {
        const checks = await probeScopes(hubspot());
        const failed = checks.filter((c) => !c.ok);
        const missing = [...new Set(failed.flatMap((c) => c.missingScopes ?? []))];
        await record("hubspot", failed.length === 0, "scope_probe", failed.length ? `Failed: ${failed.map((c) => c.check).join(", ")}` : undefined, { checks, missing_scopes: missing });
        return NextResponse.json({ ok: failed.length === 0, checks, missing_scopes: missing, message: failed.length ? "Some HubSpot checks failed — see details." : "All HubSpot checks passed." });
      }
      case "hubspot_properties": {
        const r = await ensureProperties(hubspot());
        await s.audit({ actor_id: actorId(user), action: "hubspot.ensure_properties", entity_type: "integration", entity_id: "hubspot", after: r });
        await record("hubspot", true, "ensure_properties");
        return NextResponse.json({ ok: true, ...r, message: `${r.created.length} properties created, ${r.existing.length} already existed.` });
      }
      case "resend": {
        const e = env();
        if (!e.RESEND_API_KEY || !e.EMAIL_FROM) return NextResponse.json({ ok: false, message: "RESEND_API_KEY and EMAIL_FROM are required." });
        const domain = e.EMAIL_FROM.match(/@([^>\s]+)/)?.[1]?.toLowerCase();
        const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${e.RESEND_API_KEY}` } });
        if (res.status === 401 || res.status === 403) {
          await record("resend", true, "key_present", undefined, { note: "sending-only key; domain status not readable" });
          return NextResponse.json({ ok: true, message: "Key accepted as a sending-only key; domain verification can't be read with it. Check the domain in the Resend dashboard." });
        }
        const body = (await res.json()) as { data?: { name: string; status: string }[] };
        const d = body.data?.find((x) => x.name.toLowerCase() === domain);
        const ok = d?.status === "verified";
        await record("resend", ok, "domains.list", ok ? undefined : `Sender domain ${domain ?? "?"} is ${d?.status ?? "not added"}`);
        return NextResponse.json({ ok, message: ok ? `Sender domain ${domain} is verified.` : `Sender domain ${domain ?? "(none)"} is ${d?.status ?? "not added to Resend"}.` });
      }
      case "google_calendar": {
        const db = createAdminClient();
        const { data: designers } = await db.from("designers").select("id, name, calendar_id, google_credential_id").eq("active", true).or(designer_id ? `id.eq.${designer_id}` : "id.not.is.null");
        const results = [];
        for (const d of designers ?? []) {
          if (!d.google_credential_id || !d.calendar_id) { results.push({ designer: d.name, ok: false, message: "Not connected" }); continue; }
          try {
            const cred = await s.getGoogleCredential(d.google_credential_id);
            const cal = googleCalendar(cred!, googleOAuthConfig(), s);
            const now = new Date();
            await cal.freeBusy([d.calendar_id], now.toISOString(), new Date(now.getTime() + 86400_000).toISOString());
            results.push({ designer: d.name, ok: true, message: "Free/busy readable" });
          } catch (e) {
            results.push({ designer: d.name, ok: false, message: safeErrorMessage(e) });
          }
        }
        const ok = results.length > 0 && results.every((r) => r.ok);
        await record("google_calendar", ok, "freeBusy", ok ? undefined : results.filter((r) => !r.ok).map((r) => `${r.designer}: ${r.message}`).join("; ") || "No designers");
        return NextResponse.json({ ok, results, message: results.length ? undefined : "No active designers yet." });
      }
      case "calcom": {
        try {
          const cal = calcom();
          const [me, types] = await Promise.all([cal.me(), cal.listCalendars()]);
          const now = new Date();
          await cal.freeBusy(["check"], now.toISOString(), new Date(now.getTime() + 86400_000).toISOString());
          const { data: designers } = await createAdminClient().from("designers").select("name, calendar_id").eq("active", true).eq("booking_enabled", true);
          const linked = (designers ?? []).filter((d) => types.some((t) => t.id === d.calendar_id));
          const ok = linked.length > 0;
          await record("calcom", ok, "me+event-types+busy-times", ok ? undefined : "No active designer is linked to a Cal.com event type");
          return NextResponse.json({ ok, message: `Signed in as ${me.email}. ${types.length} event types; ${linked.length} designer(s) linked: ${linked.map((d) => d.name).join(", ") || "none"}.` });
        } catch (e) {
          await record("calcom", false, "me", safeErrorMessage(e));
          return NextResponse.json({ ok: false, message: safeErrorMessage(e) });
        }
      }
      case "vaani_session": {
        const r = await mintTestSession();
        await record("vaani", r.ok, "textvoice.session", r.error);
        await s.audit({ actor_id: actorId(user), action: "vaani.test_session", entity_type: "integration", entity_id: "vaani", after: { ok: r.ok, status: r.status } });
        return NextResponse.json({ ok: r.ok, message: r.ok ? "API key accepted: a short-lived session was minted (not connected)." : `Vaani returned ${r.status}: ${r.error}` });
      }
    }
  } catch (e) {
    const msg = safeErrorMessage(e);
    const key = provider === "hubspot_properties" ? "hubspot" : provider === "vaani_session" ? "vaani" : provider;
    await record(key, false, "connection_test", msg);
    return NextResponse.json({ ok: false, message: msg }, { status: 200 });
  }
});
