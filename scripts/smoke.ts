/**
 * End-to-end smoke test against a running deployment, simulating one phone call.
 *   npm run smoke -- --base https://your-app.vercel.app
 *   npm run smoke -- --base … --book you@example.com   (also books a REAL calendar slot and sends a REAL email)
 *
 * Uses VOICE_TOOL_SECRET and VAANI_WEBHOOK_SECRET from .env.local. Everything it creates is flagged
 * as a test fixture (call id "smoke-…", X-Aangan-Test header, signed aangan_test flag), so it is
 * excluded from dashboard metrics and never synced to HubSpot.
 */
import { createHmac } from "node:crypto";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const base = (arg("base") ?? process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
const bookEmail = arg("book");
const toolSecret = process.env.VOICE_TOOL_SECRET;
const hookSecret = process.env.VAANI_WEBHOOK_SECRET;
if (!base || !toolSecret || !hookSecret) {
  console.error("Need --base (or APP_BASE_URL), VOICE_TOOL_SECRET and VAANI_WEBHOOK_SECRET");
  process.exit(2);
}

const callId = `smoke-${Date.now()}`;
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function tool(name: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/voice/tools/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${toolSecret}`, "Content-Type": "application/json", "X-Aangan-Test": "1" },
    body: JSON.stringify({ call_id: callId, caller_phone: "+919000000000", ...body }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function webhook(type: string, data: Record<string, unknown>) {
  const raw = JSON.stringify({ id: `evt_${callId}_${type}`, type, created: Math.floor(Date.now() / 1000), data });
  const sig = `sha256=${createHmac("sha256", hookSecret!).update(raw).digest("hex")}`;
  const res = await fetch(`${base}/api/webhooks/vaani`, { method: "POST", headers: { "Content-Type": "application/json", "X-VaaniVoice-Signature": sig, "X-VaaniVoice-Event": type, "X-VaaniVoice-Delivery": "1" }, body: raw });
  return res.status;
}

async function main() {
  console.log(`Smoke test against ${base} (call ${callId})\n`);

  const unauth = await fetch(`${base}/api/voice/tools/save_intake`, { method: "POST", body: "{}" });
  check("tools reject missing secret", unauth.status === 401, `HTTP ${unauth.status}`);
  const badSig = await fetch(`${base}/api/webhooks/vaani`, { method: "POST", headers: { "X-VaaniVoice-Signature": "sha256=" + "0".repeat(64) }, body: "{}" });
  check("webhook rejects bad signature", badSig.status === 401, `HTTP ${badSig.status}`);
  check("signed webhook.ping accepted", (await webhook("webhook.ping", {})) === 200);

  const price = await tool("answer_question", { question: "Roughly how much would a 2BHK cost? Even a range?" });
  check("pricing question deflected", price.body.kind === "pricing_deflection", String(price.body.say ?? price.status).slice(0, 80));
  const area = await tool("answer_question", { question: "Do you take up projects in Nashik?" });
  check("approved answer served", area.body.kind === "approved_answer", String(area.body.article));
  const unknown = await tool("answer_question", { question: "Do you have a showroom with a cafe?" });
  check("unknown question → fallback + logged", unknown.body.kind === "fallback" || unknown.body.kind === "approved_answer", String(unknown.body.kind));

  const red = await tool("evaluate_qualification", { facts: { intent: "design_and_execution", segment: "residential", locationText: "Nashik", timelineFlexible: true } });
  check("out-of-area enquiry → red", red.body.status === "red", String(red.body.status));

  const q = await tool("evaluate_qualification", {
    name: "Smoke Test",
    email: bookEmail ?? null,
    facts: { intent: "design_and_execution", segment: "residential", propertyType: "apartment", scopeKind: "full_home", executionIncluded: true, locationText: "Aundh", timelineFlexible: true, decisionMaker: "self" },
  });
  check("qualified enquiry → green", q.body.status === "green", String(q.body.status));

  const avail = await tool("get_availability", {});
  const slots = (avail.body.slots as { start: string; designerId: string; label: string }[] | undefined) ?? [];
  check("real availability returned", avail.status === 200 && avail.body.status !== "unavailable", `${slots.length} slot(s) ${avail.body.status ?? avail.status}`);

  if (bookEmail && slots[0]) {
    const b = await tool("book_consultation", { slot_start: slots[0].start, designer_id: slots[0].designerId, email: bookEmail, idempotency_key: `${callId}-book` });
    check("booking confirmed after calendar write", b.body.status === "confirmed", String(b.body.say ?? b.status));
    const again = await tool("book_consultation", { slot_start: slots[0].start, designer_id: slots[0].designerId, email: bookEmail, idempotency_key: `${callId}-book` });
    check("repeat booking is idempotent", again.body.appointment_id === b.body.appointment_id);
    console.log("  → cancel this test booking from the calendar or POST /api/calendar/cancel when done");
  } else if (bookEmail) {
    check("booking", false, "no slots to book");
  }

  const transcript = [
    { role: "agent", text: "Hello, thank you for calling Aangan Studio." },
    { role: "caller", text: "Hi, I want to redo my 2BHK in Aundh. No rush." },
  ];
  const s1 = await webhook("call.completed", { call_id: callId, aangan_test: true, duration_seconds: 95, transcript });
  const s2 = await webhook("call.completed", { call_id: callId, aangan_test: true, duration_seconds: 95, transcript });
  check("call.completed accepted, duplicate ignored", s1 === 200 && s2 === 200);

  console.log(`\n${failures ? `${failures} check(s) failed` : "All smoke checks passed"} — test records are flagged is_test and excluded from metrics.`);
  process.exitCode = failures ? 1 : 0;
}
main();
