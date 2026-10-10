/**
 * LIVE: imports the studio's September 2026 enquiries (business-source/enquiries-sept-2026.txt,
 * extracted from "Aangan_Sep 2026_Enquiries.pdf") through the same post-call pipeline a Vaani call
 * uses: Gemini extraction → rules engine (Green/Amber/Red) → leads, decisions, callbacks, HubSpot jobs.
 * Rows keep their original September dates. Safe to re-run: already-processed records are skipped
 * (pass --force to reprocess).
 *   npm run import:enquiries
 */
import { readFileSync } from "node:fs";
import { gemini } from "../src/integrations/gemini/client";
import { extractCall } from "../src/integrations/gemini/tasks";
import { createAdminClient } from "../src/lib/supabase/server";
import { store } from "../src/server/store/supabase-store";
import { applyExtraction, recordGeminiCost } from "../src/server/services/post-call";

const PROVIDER = "sept_import";
const CHANNEL = { T: "phone", W: "whatsapp", F: "web_form" } as const;
const SOURCE = { T: "phone_front_desk", W: "whatsapp", F: "web_form" } as const;

interface Enquiry {
  id: string;
  kind: keyof typeof CHANNEL;
  startedAt: string;
  durationSeconds: number | null;
  missed: boolean;
  text: string;
}

function parse(raw: string): Enquiry[] {
  const lines = raw.split("\n").filter((l) => !/^=== PAGE \d+/.test(l));
  const out: { header: string; body: string[] }[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^[TWF]\d{2} · /.test(line)) {
      out.push({ header: line, body: [] });
      skipping = false;
    } else if (/^SECTION \d/.test(line)) {
      skipping = true;
    } else if (!skipping && out.length) {
      out[out.length - 1].body.push(line);
    }
  }
  return out.map(({ header, body }) => {
    const id = header.slice(0, 3);
    const kind = id[0] as Enquiry["kind"];
    const text = body.join("\n").trim();
    const day = Number(header.match(/(\d{1,2})(?:–\d{1,2})? September/)?.[1]);
    const t = (header.match(/(\d{1,2}):(\d{2})\s?(am|pm)/i) ?? text.match(/(\d{1,2}):(\d{2})\s?(am|pm)/i))!;
    const hour = (Number(t[1]) % 12) + (t[3].toLowerCase() === "pm" ? 12 : 0);
    const durations = [...header.concat(" ", text).matchAll(/(\d+) min (\d+) sec/g)];
    const last = durations.at(-1);
    return {
      id, kind, text,
      startedAt: `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${t[2]}:00+05:30`,
      durationSeconds: last ? Number(last[1]) * 60 + Number(last[2]) : null,
      missed: /MISSED CALL/.test(header),
    };
  });
}

/** Pipeline rows are stamped "now"; move them back to when the enquiry actually arrived. */
async function backdate(callId: string, leadId: string | null, at: string) {
  const db = createAdminClient();
  for (const table of ["exceptions", "lead_events", "call_qualifications", "policy_events", "unanswered_questions", "team_messages", "cost_events"]) {
    const { error } = await db.from(table).update(table === "cost_events" ? { usage_at: at } : { created_at: at }).eq("call_id", callId);
    if (error && !/column/.test(error.message)) console.warn(`  backdate ${table}: ${error.message}`);
  }
  await db.from("calls").update({ created_at: at }).eq("id", callId);
  if (leadId) await db.from("leads").update({ created_at: at }).eq("id", leadId).eq("first_call_id", callId);
}

async function main() {
  const force = process.argv.includes("--force");
  const records = parse(readFileSync("business-source/enquiries-sept-2026.txt", "utf8"));
  console.log(`Parsed ${records.length} enquiries`);
  const s = store();
  const model = gemini();
  const tally: Record<string, number> = {};

  for (const r of records) {
    const { call: existing } = await s.ensureCall(PROVIDER, r.id, {
      status: "in_progress", started_at: r.startedAt, production_call: true, is_test: false,
      provider_metadata: { channel: CHANNEL[r.kind], source_doc: "Aangan_Sep 2026_Enquiries.pdf", record: r.id },
    });
    if (existing.processing_status === "processed" && !force) {
      console.log(`${r.id} already imported`);
      continue;
    }
    const ended = r.durationSeconds ? new Date(Date.parse(r.startedAt) + r.durationSeconds * 1000).toISOString() : r.startedAt;
    let call = await s.updateCall(existing.id, {
      status: r.missed ? "missed" : "completed", answered: !r.missed, ended_at: ended, duration_seconds: r.durationSeconds,
      processing_status: "processing",
    });
    await s.saveTranscript(call.id, r.text, null, `import:${CHANNEL[r.kind]}`);

    if (r.missed) {
      await s.upsertException({
        kind: "failed_call", severity: "high", call_id: call.id, dedupe_key: `failed-call:${call.id}`, is_test: false,
        title: "Missed call after hours (Nanded City area)", detail: r.text,
      });
      call = await s.updateCall(call.id, { summary: "Missed call at 10:47pm, no voicemail. Call-back next morning went unanswered.", processing_status: "processed" });
      await backdate(call.id, null, r.startedAt);
      tally.missed = (tally.missed ?? 0) + 1;
      console.log(`${r.id} missed call`);
      continue;
    }

    try {
      const { data, usage } = await extractCall(model, r.text, r.startedAt);
      await recordGeminiCost({ store: s, now: () => new Date() }, call, usage);
      await applyExtraction({ store: s, now: () => new Date(r.startedAt) }, call, data);
      call = (await s.getCall(call.id))!;
      await s.updateCall(call.id, { processing_status: "processed", processing_error: null });
      if (call.lead_id) await createAdminClient().from("leads").update({ source: SOURCE[r.kind] }).eq("id", call.lead_id);
      await backdate(call.id, call.lead_id, r.startedAt);
      const lead = call.lead_id ? await s.getLead(call.lead_id) : null;
      const outcome = lead?.qualification_status ?? data.callType;
      tally[outcome] = (tally[outcome] ?? 0) + 1;
      console.log(`${r.id} ${CHANNEL[r.kind].padEnd(8)} ${outcome.padEnd(22)} ${data.contact.name ?? ""}`);
    } catch (e) {
      await s.updateCall(call.id, { processing_status: "failed", processing_error: String(e) });
      tally.failed = (tally.failed ?? 0) + 1;
      console.log(`${r.id} FAILED ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log("\n", tally);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
