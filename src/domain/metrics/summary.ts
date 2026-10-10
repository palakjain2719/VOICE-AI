import type { FunnelCounts } from "./insights";
import { largestDropOff } from "./insights";

export interface SummaryFacts {
  periodLabel: string;
  funnel: FunnelCounts;
  afterHours: number;
  calls: number;
  pipeline: { weighted: number; unweighted: number; addedInPeriod: number; openCount: number };
  topDecline: { label: string; n: number } | null;
  backlog: number;
  oldestHours: number;
}

export interface SummaryBullet {
  text: string;
  href: string;
}

const DECLINE: Record<string, string> = { category: "project type or size", area: "location outside Pune / PCMC", budget: "a clearly short budget", timeline: "a timeline that's too tight", engagement: "advice-only requests" };

const lakh = (n: number) => (n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : `₹${(n / 1e5).toFixed(1)} lakh`);

/** Bullets built only from counted values. Each carries the page that shows the records behind it. */
export function summaryBullets(f: SummaryFacts): SummaryBullet[] {
  const out: SummaryBullet[] = [];
  if (f.calls === 0) return [{ text: `No live calls yet for ${f.periodLabel}. This summary fills in as calls arrive.`, href: "/calls" }];
  if (f.pipeline.openCount > 0)
    out.push({ text: `Open pipeline is ${lakh(f.pipeline.unweighted)} across ${f.pipeline.openCount} deals, ${lakh(f.pipeline.weighted)} weighted by stage; ${lakh(f.pipeline.addedInPeriod)} was added this period.`, href: "/pipeline" });
  if (f.afterHours > 0) out.push({ text: `${f.afterHours} of ${f.calls} calls came outside staff hours — the assistant answered them.`, href: "/calls" });
  const drop = largestDropOff(f.funnel);
  if (drop) out.push({ text: `The biggest funnel drop is ${drop.from.toLowerCase()} → ${drop.label.toLowerCase()} (${Math.round((drop.conversion ?? 0) * 100)}% convert).`, href: "/funnel" });
  if (f.topDecline) out.push({ text: `Most enquiries that weren't a fit fell on ${DECLINE[f.topDecline.label] ?? f.topDecline.label} (${f.topDecline.n}).`, href: "/funnel?status=red" });
  if (f.backlog > 0) out.push({ text: `${f.backlog} items wait for a person; the oldest is ${f.oldestHours} hours old (target under 24).`, href: "/exceptions" });
  return out;
}

/** Numbers in model output must already appear in the counted bullets (₹ amounts, counts, %). */
export function numbersAreGrounded(source: string, candidate: string): boolean {
  const nums = (s: string) => (s.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, ""));
  const allowed = new Set(nums(source));
  return nums(candidate).every((n) => allowed.has(n));
}
