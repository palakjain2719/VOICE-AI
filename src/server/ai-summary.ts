import "server-only";
import { z } from "zod";
import { resolvePeriod } from "@/domain/metrics/period";
import { numbersAreGrounded, summaryBullets, type SummaryBullet, type SummaryFacts } from "@/domain/metrics/summary";
import { detectPricingDisclosure } from "@/domain/pricing/guard";
import { isConfigured, PROVIDER_ENV } from "@/lib/env";
import { log, safeErrorMessage } from "@/lib/log";
import { createAdminClient, type Db } from "@/lib/supabase/server";
import { gemini } from "@/integrations/gemini/client";
import { getFunnel } from "./dashboard";
import { getBacklog, getDemand, getKpis, getPipelineHeadline } from "./ops-dashboard";

export async function collectSummaryFacts(db: Db): Promise<SummaryFacts> {
  const p = resolvePeriod({ period: "7d" });
  const [funnel, kpis, pipeline, demand, backlog] = await Promise.all([getFunnel(db, p.from, p.to), getKpis(db, p), getPipelineHeadline(db, p), getDemand(db, p), getBacklog(db)]);
  return {
    periodLabel: "the last 7 days",
    funnel,
    afterHours: kpis.after_hours,
    calls: kpis.calls,
    pipeline,
    topDecline: demand.declines[0] ? { label: demand.declines[0].label, n: demand.declines[0].n } : null,
    backlog: backlog.total,
    oldestHours: backlog.oldestHours,
  };
}

const Reworded = z.object({ bullets: z.array(z.string().max(300)) });

/**
 * Builds the AI summary: counted bullets, optionally reworded by Gemini. A reworded bullet is kept
 * only if every number in it already appears in the counted bullet and it contains no pricing
 * language; otherwise the counted wording is used. Stored for the Today page.
 */
export async function refreshAiSummary(db: Db = createAdminClient()) {
  const facts = await collectSummaryFacts(db);
  const base = summaryBullets(facts);
  let bullets: SummaryBullet[] = base;
  let by = "rules";
  if (isConfigured(PROVIDER_ENV.gemini) && facts.calls > 0) {
    try {
      const { data, usage } = await gemini().generateJson({
        system: "Rewrite each bullet for a busy studio founder: plain, specific, under 30 words. Keep every number exactly as given. Do not add facts, numbers, advice or prices. Return the same number of bullets in the same order.",
        prompt: base.map((b, i) => `${i + 1}. ${b.text}`).join("\n"),
        schema: Reworded,
        maxOutputTokens: 2048,
      });
      if (data.bullets.length === base.length) {
        bullets = base.map((b, i) => {
          const c = data.bullets[i];
          return numbersAreGrounded(b.text, c) && !detectPricingDisclosure(c.replace(/₹[\d.,]+\s*(lakh|Cr)/g, "")).violation ? { ...b, text: c } : b;
        });
        by = `gemini:${usage.model}`;
      }
    } catch (e) {
      log.warn("ai_summary.gemini_failed", { error: safeErrorMessage(e) });
    }
  }
  const { error } = await createAdminClient().from("ai_summaries").insert({ scope: "overview", period_label: facts.periodLabel, bullets, facts, generated_by: by });
  if (error) throw new Error(error.message);
  return { bullets, generated_by: by };
}

export async function latestAiSummary(db: Db) {
  const { data } = await db.from("ai_summaries").select("bullets, generated_by, created_at, period_label").eq("scope", "overview").order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data as { bullets: SummaryBullet[]; generated_by: string; created_at: string; period_label: string } | null;
}
