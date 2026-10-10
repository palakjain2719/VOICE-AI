import { formatInTimeZone } from "date-fns-tz";
import { TZ } from "./period";

export interface DealRecord {
  hubspot_deal_id: string;
  deal_name: string | null;
  amount: number | null;
  currency: string | null;
  stage_id: string | null;
  stage_label: string | null;
  stage_probability: number | null;
  is_closed: boolean;
  is_won: boolean;
  designer_id: string | null;
  hubspot_owner_id: string | null;
  close_date: string | null;
  is_aangan_voice_lead: boolean;
}

export interface Bucket {
  key: string;
  unweighted: number;
  weighted: number;
  deals: number;
}

export interface PipelineMetrics {
  open: { count: number; amount: number; weighted: number; missingAmount: number; missingProbability: number };
  won: { count: number; revenue: number; missingAmount: number };
  lost: { count: number };
  byStage: { stageId: string; label: string; count: number; amount: number; weighted: number; probability: number | null }[];
  byOwner: { ownerKey: string; count: number; amount: number; weighted: number }[];
  forecast: { month: Bucket[]; quarter: Bucket[]; year: Bucket[]; noCloseDate: number };
  currencies: string[];
}

/**
 * Pipeline maths from HubSpot deal records:
 *  - Open pipeline = Σ amount of open deals with an amount (deals without one are counted, not valued).
 *  - Weighted = Σ amount × stage probability, for open deals with both values.
 *  - Closed-won revenue = Σ amount of won deals whose close date falls in the period.
 * No values are inferred: missing amounts or probabilities are reported as gaps.
 */
export function computePipeline(deals: DealRecord[], period: { from: Date; to: Date }): PipelineMetrics {
  const open = deals.filter((d) => !d.is_closed);
  const inPeriod = (d: DealRecord) => d.close_date && Date.parse(d.close_date) >= period.from.getTime() && Date.parse(d.close_date) < period.to.getTime();
  const won = deals.filter((d) => d.is_won && inPeriod(d));
  const lost = deals.filter((d) => d.is_closed && !d.is_won && inPeriod(d));
  const w = (d: DealRecord) => (d.amount != null && d.stage_probability != null ? d.amount * d.stage_probability : 0);

  const stageMap = new Map<string, PipelineMetrics["byStage"][number]>();
  const ownerMap = new Map<string, PipelineMetrics["byOwner"][number]>();
  for (const d of open) {
    const sk = d.stage_id ?? "unknown";
    const s = stageMap.get(sk) ?? { stageId: sk, label: d.stage_label ?? "Unknown stage", count: 0, amount: 0, weighted: 0, probability: d.stage_probability };
    s.count++;
    s.amount += d.amount ?? 0;
    s.weighted += w(d);
    stageMap.set(sk, s);
    const ok = d.designer_id ?? (d.hubspot_owner_id ? `owner:${d.hubspot_owner_id}` : "unassigned");
    const o = ownerMap.get(ok) ?? { ownerKey: ok, count: 0, amount: 0, weighted: 0 };
    o.count++;
    o.amount += d.amount ?? 0;
    o.weighted += w(d);
    ownerMap.set(ok, o);
  }

  const bucket = (fmt: (d: Date) => string) => {
    const m = new Map<string, Bucket>();
    for (const d of open) {
      if (!d.close_date) continue;
      const k = fmt(new Date(d.close_date));
      const b = m.get(k) ?? { key: k, unweighted: 0, weighted: 0, deals: 0 };
      b.unweighted += d.amount ?? 0;
      b.weighted += w(d);
      b.deals++;
      m.set(k, b);
    }
    return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
  };

  return {
    open: {
      count: open.length,
      amount: open.reduce((s, d) => s + (d.amount ?? 0), 0),
      weighted: open.reduce((s, d) => s + w(d), 0),
      missingAmount: open.filter((d) => d.amount == null).length,
      missingProbability: open.filter((d) => d.amount != null && d.stage_probability == null).length,
    },
    won: { count: won.length, revenue: won.reduce((s, d) => s + (d.amount ?? 0), 0), missingAmount: won.filter((d) => d.amount == null).length },
    lost: { count: lost.length },
    byStage: [...stageMap.values()].sort((a, b) => (a.probability ?? 0) - (b.probability ?? 0)),
    byOwner: [...ownerMap.values()].sort((a, b) => b.amount - a.amount),
    forecast: {
      month: bucket((d) => formatInTimeZone(d, TZ, "yyyy-MM")),
      quarter: bucket((d) => `${formatInTimeZone(d, TZ, "yyyy")}-Q${Math.floor((Number(formatInTimeZone(d, TZ, "M")) - 1) / 3) + 1}`),
      year: bucket((d) => formatInTimeZone(d, TZ, "yyyy")),
      noCloseDate: open.filter((d) => !d.close_date).length,
    },
    currencies: [...new Set(deals.map((d) => d.currency).filter((c): c is string => !!c))],
  };
}
