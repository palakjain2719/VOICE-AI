/**
 * Read-only configuration and connection check for every provider.
 *   npm run doctor            (reads .env.local)
 *   npm run doctor -- --vaani (also mints one short Vaani session; Vaani holds ₹1, reconciled on close)
 * Never prints secret values and never writes to any provider.
 */
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { hubspotClient } from "../src/integrations/hubspot/client";
import { probeScopes } from "../src/integrations/hubspot/properties";

type Result = { area: string; ok: boolean | null; detail: string; fix?: string };
const results: Result[] = [];
const e = process.env;
const add = (r: Result) => results.push(r);
const has = (...k: string[]) => k.every((x) => !!e[x]?.trim());
const missing = (...k: string[]) => k.filter((x) => !e[x]?.trim());

async function supabase() {
  if (!has("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"))
    return add({ area: "Supabase", ok: false, detail: `missing ${missing("NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY").join(", ")}`, fix: "Project Settings → API Keys" });
  const db = createClient(e.NEXT_PUBLIC_SUPABASE_URL!, e.SUPABASE_SECRET_KEY!, { auth: { persistSession: false }, db: { schema: process.env.SUPABASE_DB_SCHEMA || "aangan" } });
  const { count, error } = await db.from("knowledge_articles").select("id", { count: "exact", head: true }).eq("status", "published");
  if (error) return add({ area: "Supabase", ok: false, detail: error.message, fix: /does not exist|schema cache/.test(error.message) ? "Apply supabase/migrations/*.sql in order" : "Check the secret key" });
  add({ area: "Supabase", ok: true, detail: `connected; ${count} published knowledge articles` });
  const { data: admins } = await db.from("app_users").select("id").contains("roles", ["admin"]);
  add({ area: "Supabase admin user", ok: (admins?.length ?? 0) > 0, detail: `${admins?.length ?? 0} admin(s)`, fix: "update app_users set roles = '{admin}' where email = '…';" });
  const { data: designers } = await db.from("designers").select("name, booking_enabled, calendar_id, google_credential_id, hubspot_owner_id").eq("active", true);
  const bookable = (designers ?? []).filter((d) => d.booking_enabled && d.calendar_id && d.google_credential_id);
  add({ area: "Bookable designers", ok: bookable.length > 0, detail: `${bookable.length} of ${designers?.length ?? 0} active designers can be booked`, fix: "Settings → Designers: connect Google, choose calendar, tick Bookable" });
  const { data: mapping } = await db.from("app_settings").select("value").eq("key", "hubspot_pipeline").maybeSingle();
  add({ area: "HubSpot stage mapping", ok: !!mapping, detail: mapping ? "configured" : "not configured", fix: "Settings → HubSpot pipeline" });
}

async function gemini() {
  if (!has("GEMINI_API_KEY", "GEMINI_MODEL")) return add({ area: "Gemini", ok: false, detail: `missing ${missing("GEMINI_API_KEY", "GEMINI_MODEL").join(", ")}`, fix: "aistudio.google.com → API keys" });
  try {
    const r = await new GoogleGenAI({ apiKey: e.GEMINI_API_KEY! }).models.generateContent({ model: e.GEMINI_MODEL!, contents: 'Return {"ok":true}', config: { responseMimeType: "application/json", maxOutputTokens: 512, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } });
    add({ area: "Gemini", ok: !!r.text?.includes("ok"), detail: `model ${e.GEMINI_MODEL} responded` });
  } catch (err) {
    add({ area: "Gemini", ok: false, detail: String((err as Error).message).slice(0, 160), fix: "Check the key and that GEMINI_MODEL is a current Flash model id" });
  }
}

async function hubspot() {
  if (!has("HUBSPOT_SERVICE_KEY")) return add({ area: "HubSpot", ok: false, detail: "missing HUBSPOT_SERVICE_KEY", fix: "Development → Keys → Service Keys" });
  const checks = await probeScopes(hubspotClient(e.HUBSPOT_SERVICE_KEY!));
  for (const c of checks)
    add({ area: `HubSpot ${c.check}`, ok: c.ok, detail: c.ok ? "ok" : `HTTP ${c.status}${c.missingScopes?.length ? `, missing ${c.missingScopes.join(", ")}` : ""}`, fix: c.check.includes("properties") ? "Integrations → HubSpot → Create custom properties" : "Add the scope to the service key" });
}

async function resend() {
  if (!has("RESEND_API_KEY", "EMAIL_FROM")) return add({ area: "Resend", ok: false, detail: `missing ${missing("RESEND_API_KEY", "EMAIL_FROM").join(", ")}`, fix: "resend.com → API keys; verify your domain" });
  const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${e.RESEND_API_KEY}` } });
  if (res.status === 401 || res.status === 403) return add({ area: "Resend", ok: null, detail: "sending-only key: domain status not readable", fix: "Check the domain in the Resend dashboard" });
  const body = (await res.json()) as { data?: { name: string; status: string }[] };
  const domain = e.EMAIL_FROM!.match(/@([^>\s]+)/)?.[1]?.toLowerCase();
  const d = body.data?.find((x) => x.name.toLowerCase() === domain);
  add({ area: "Resend", ok: d?.status === "verified", detail: `sender domain ${domain}: ${d?.status ?? "not added"}`, fix: "Verify the domain's DNS records in Resend" });
}

function google() {
  const k = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "TOKEN_ENCRYPTION_KEY"];
  if (!has(...k)) return add({ area: "Google Calendar", ok: false, detail: `missing ${missing(...k).join(", ")}`, fix: "Google Cloud → APIs & Services → Credentials (OAuth client, Web)" });
  const keyOk = Buffer.from(e.TOKEN_ENCRYPTION_KEY!, "base64").length === 32;
  add({ area: "Google Calendar", ok: keyOk && e.GOOGLE_REDIRECT_URI!.endsWith("/api/auth/google/callback"), detail: keyOk ? `redirect ${e.GOOGLE_REDIRECT_URI}` : "TOKEN_ENCRYPTION_KEY is not 32 bytes base64", fix: "Redirect URI must be <APP_BASE_URL>/api/auth/google/callback and registered in Google Cloud" });
}

async function vaani(mint: boolean) {
  const k = ["VAANI_API_KEY", "VAANI_WEBHOOK_SECRET", "VOICE_TOOL_SECRET"];
  if (!has(...k)) return add({ area: "Vaani", ok: false, detail: `missing ${missing(...k).join(", ")}`, fix: "vaanilabs.in → /api-keys; Dashboard → Webhooks for the vv_whk_ secret" });
  if (!e.VAANI_API_KEY!.startsWith("vv_live_")) add({ area: "Vaani key format", ok: null, detail: "not the documented vv_live_ format — verify with --vaani" });
  if (!e.VAANI_WEBHOOK_SECRET!.startsWith("vv_whk_")) add({ area: "Vaani webhook secret", ok: null, detail: "expected a vv_whk_ prefix" });
  if (!mint) return add({ area: "Vaani", ok: null, detail: "key format ok (run with --vaani to verify it live)" });
  const res = await fetch("https://www.vaanilabs.in/api/public/v1/textvoice/session", { method: "POST", headers: { Authorization: `Bearer ${e.VAANI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(e.VAANI_FLOW_ID ? { flow_id: e.VAANI_FLOW_ID } : {}) });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  add({ area: "Vaani", ok: res.ok, detail: res.ok ? "API key accepted" : `HTTP ${res.status} ${body.error ?? ""}`, fix: res.status === 402 ? "Top up the Vaani wallet" : res.status === 403 ? "Check key scopes / flow id" : undefined });
}

function app() {
  for (const k of ["APP_BASE_URL", "CRON_SECRET", "VOICE_TOOL_SECRET"]) add({ area: k, ok: has(k), detail: has(k) ? "set" : "missing" });
}

async function main() {
  app();
  await Promise.allSettled([supabase(), gemini(), hubspot(), resend(), vaani(process.argv.includes("--vaani"))]);
  google();
  const icon = (ok: boolean | null) => (ok === true ? "✓" : ok === false ? "✗" : "•");
  for (const r of results) console.log(`${icon(r.ok)} ${r.area.padEnd(28)} ${r.detail}${r.ok === false && r.fix ? `\n    → ${r.fix}` : ""}`);
  const failed = results.filter((r) => r.ok === false).length;
  console.log(`\n${failed ? `${failed} item(s) need attention` : "All checks passed"}`);
  process.exitCode = failed ? 1 : 0;
}
main();
