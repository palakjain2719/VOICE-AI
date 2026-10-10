import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

export const TZ = "Asia/Kolkata";
export type PeriodKey = "7d" | "30d" | "90d" | "mtd" | "qtd" | "ytd" | "custom";

export interface Period {
  key: PeriodKey;
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
  label: string;
}

function localMidnight(d: Date): Date {
  return fromZonedTime(`${formatInTimeZone(d, TZ, "yyyy-MM-dd")}T00:00:00`, TZ);
}

/** Resolves a period from search params. `to` is exclusive; the previous period has equal length. */
export function resolvePeriod(sp: { period?: string; from?: string; to?: string }, now = new Date()): Period {
  const key = (["7d", "30d", "90d", "mtd", "qtd", "ytd", "custom"].includes(sp.period ?? "") ? sp.period : "90d") as PeriodKey;
  const tomorrow = new Date(localMidnight(now).getTime() + 86400_000);
  let from: Date;
  let to = tomorrow;
  const y = Number(formatInTimeZone(now, TZ, "yyyy"));
  const m = Number(formatInTimeZone(now, TZ, "M"));
  switch (key) {
    case "7d":
      from = new Date(tomorrow.getTime() - 7 * 86400_000);
      break;
    case "90d":
      from = new Date(tomorrow.getTime() - 90 * 86400_000);
      break;
    case "mtd":
      from = fromZonedTime(`${y}-${String(m).padStart(2, "0")}-01T00:00:00`, TZ);
      break;
    case "qtd": {
      const qm = Math.floor((m - 1) / 3) * 3 + 1;
      from = fromZonedTime(`${y}-${String(qm).padStart(2, "0")}-01T00:00:00`, TZ);
      break;
    }
    case "ytd":
      from = fromZonedTime(`${y}-01-01T00:00:00`, TZ);
      break;
    case "custom": {
      const f = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? fromZonedTime(`${sp.from}T00:00:00`, TZ) : null;
      const t = sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? new Date(fromZonedTime(`${sp.to}T00:00:00`, TZ).getTime() + 86400_000) : null;
      from = f ?? new Date(tomorrow.getTime() - 30 * 86400_000);
      to = t && t > from ? t : tomorrow;
      break;
    }
    default:
      from = new Date(tomorrow.getTime() - 30 * 86400_000);
  }
  const len = to.getTime() - from.getTime();
  const fmt = (d: Date) => formatInTimeZone(d, TZ, "d MMM yyyy");
  return {
    key,
    from,
    to,
    prevFrom: new Date(from.getTime() - len),
    prevTo: from,
    label: `${fmt(from)} – ${fmt(new Date(to.getTime() - 1))}`,
  };
}

export function pct(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}
