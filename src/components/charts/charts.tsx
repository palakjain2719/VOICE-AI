"use client";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const axis = { fill: "var(--ink-3)", fontSize: 12 };
const tooltipStyle = {
  contentStyle: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 13, color: "var(--ink)" },
  labelStyle: { color: "var(--ink)", fontWeight: 600 },
  itemStyle: { color: "var(--ink-2)" },
  cursor: { fill: "var(--grid)", opacity: 0.6 },
};
const inrFmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", notation: "compact", maximumFractionDigits: 1 }).format(n);

/** Funnel: one series, so no legend; each bar is labelled with count and step conversion. */
export function FunnelChart({ steps }: { steps: { label: string; count: number; conversion: number | null }[] }) {
  const data = steps.map((s) => ({ ...s, tag: `${s.count}${s.conversion != null ? ` · ${Math.round(s.conversion * 100)}%` : ""}` }));
  return (
    <div className="h-[300px] w-full" role="img" aria-label={`Funnel: ${steps.map((s) => `${s.label} ${s.count}`).join(", ")}`}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 72, bottom: 4, left: 8 }} barCategoryGap={6}>
          <CartesianGrid horizontal={false} stroke="var(--grid)" />
          <XAxis type="number" allowDecimals={false} tick={axis} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" width={170} tick={axis} axisLine={false} tickLine={false} />
          <Tooltip {...tooltipStyle} formatter={(v) => [String(v), "Count"]} />
          <Bar dataKey="count" fill="var(--series-1)" radius={[0, 4, 4, 0]} maxBarSize={26} isAnimationActive={false}>
            <LabelList dataKey="tag" position="right" style={{ fill: "var(--ink-2)", fontSize: 12 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AmountBars({ data, valueLabel }: { data: { label: string; value: number }[]; valueLabel: string }) {
  return (
    <div className="w-full" style={{ height: Math.max(160, data.length * 40 + 40) }} role="img" aria-label={`${valueLabel} by category`}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 72, bottom: 4, left: 8 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke="var(--grid)" />
          <XAxis type="number" tick={axis} axisLine={false} tickLine={false} tickFormatter={inrFmt} />
          <YAxis type="category" dataKey="label" width={160} tick={axis} axisLine={false} tickLine={false} />
          <Tooltip {...tooltipStyle} formatter={(v) => [inrFmt(Number(v)), valueLabel]} />
          <Bar dataKey="value" fill="var(--series-1)" radius={[0, 4, 4, 0]} maxBarSize={24} isAnimationActive={false}>
            <LabelList dataKey="value" position="right" formatter={(v) => inrFmt(Number(v))} style={{ fill: "var(--ink-2)", fontSize: 12 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

type Bucket = { key: string; unweighted: number; weighted: number; deals: number };

/** Two series (unweighted vs probability-weighted): legend present, fixed slot order. */
export function ForecastChart({ month, quarter, year }: { month: Bucket[]; quarter: Bucket[]; year: Bucket[] }) {
  const [grain, setGrain] = useState<"month" | "quarter" | "year">("month");
  const data = { month, quarter, year }[grain];
  return (
    <div>
      <div role="tablist" aria-label="Forecast grain" className="mb-3 inline-flex rounded-xl border border-line p-0.5">
        {(["month", "quarter", "year"] as const).map((g) => (
          <button
            key={g}
            role="tab"
            aria-selected={grain === g}
            onClick={() => setGrain(g)}
            className={`rounded-lg px-3 py-1 text-[13px] font-medium capitalize ${grain === g ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink"}`}
          >
            {g}
          </button>
        ))}
      </div>
      {data.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-ink-3">No open deals with an expected close date.</p>
      ) : (
        <div className="h-[260px] w-full" role="img" aria-label="Expected close forecast, unweighted and weighted">
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 8 }} barGap={2}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="key" tick={axis} axisLine={false} tickLine={false} />
              <YAxis tick={axis} axisLine={false} tickLine={false} tickFormatter={inrFmt} width={64} />
              <Tooltip {...tooltipStyle} formatter={(v, n) => [inrFmt(Number(v)), n === "unweighted" ? "Unweighted" : "Weighted"]} />
              <Legend formatter={(v) => <span style={{ color: "var(--ink-2)", fontSize: 12 }}>{v === "unweighted" ? "Unweighted amount" : "Probability-weighted"}</span>} />
              <Bar dataKey="unweighted" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
              <Bar dataKey="weighted" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
