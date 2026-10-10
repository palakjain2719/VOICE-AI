import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, rateLimit, readJson } from "@/server/http";
import { requireRole } from "@/server/auth";
import { gemini } from "@/integrations/gemini/client";
import { extractCall } from "@/integrations/gemini/tasks";
import { evaluate } from "@/domain/qualification/engine";
import { loadQualificationConfig } from "@/server/settings";
import { store } from "@/server/store/supabase-store";

const Body = z.object({ transcript: z.string().trim().min(20).max(60_000), call_date: z.iso.date() });

/** Dry run: structured extraction + rules on a pasted transcript. Persists nothing (testing / QA). */
export const POST = handle("voice.extract", async (req: Request) => {
  const user = await requireRole("operator");
  await rateLimit(`extract:${user.id}`, 10);
  const body = await readJson(req, (v) => Body.parse(v), 80_000);
  const { data, usage } = await extractCall(gemini(), body.transcript, `${body.call_date}T12:00:00+05:30`);
  const config = await loadQualificationConfig(store());
  const result = evaluate({ facts: data.facts, config, clarificationsAsked: data.clarificationsAsked, now: new Date(`${body.call_date}T12:00:00+05:30`) });
  return NextResponse.json({ extraction: data, qualification: result, usage: { model: usage.model, tokens: usage.promptTokens + usage.outputTokens } });
});
