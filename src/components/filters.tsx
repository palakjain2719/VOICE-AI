"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

const PERIODS = [
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["90d", "Last 90 days"],
  ["mtd", "Month to date"],
  ["qtd", "Quarter to date"],
  ["ytd", "Year to date"],
] as const;

const selectCls = "h-9 rounded-xl border border-line bg-surface px-3 text-sm text-ink hover:border-line-strong disabled:opacity-60";

function useParamSetter() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(sp.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    start(() => router.replace(`${path}?${next.toString()}`, { scroll: false }));
  };
  return { sp, set, pending };
}

export function PeriodSelect() {
  const { sp, set, pending } = useParamSetter();
  return (
    <label className="flex items-center gap-2 text-sm text-ink-3">
      <span className="sr-only">Period</span>
      <select className={selectCls} value={sp.get("period") ?? "30d"} onChange={(e) => set("period", e.target.value)} disabled={pending} aria-busy={pending}>
        {PERIODS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ParamSelect({ name, label, options }: { name: string; label: string; options: { value: string; label: string }[] }) {
  const { sp, set, pending } = useParamSetter();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{label}</span>
      <select className={selectCls} value={sp.get(name) ?? ""} onChange={(e) => set(name, e.target.value)} disabled={pending}>
        <option value="">{label}: all</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
