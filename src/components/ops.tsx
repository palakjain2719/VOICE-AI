import Link from "next/link";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { Badge, Card, inr } from "./ui";
import { cn } from "@/lib/utils";

export function fmtDuration(s: number | null | undefined) {
  if (s == null) return "—";
  if (s < 120) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  return `${(s / 3600).toFixed(1)} h`;
}

export interface GuardrailData {
  pricesSpoken: number;
  caughtBeforeSpeaking: number;
  complaints: number;
  complaintAlertSeconds: number | null;
  failedCallsOpen: number;
  integrationsHealthy: number;
  integrationsTotal: number;
  callsOver5Min: number;
  voiceToday: number;
  voiceCap: number | null;
}

type Level = "ok" | "watch" | "act";

function Row({ level, label, value, note, href }: { level: Level; label: string; value: React.ReactNode; note: string; href?: string }) {
  const Icon = level === "act" ? CircleAlert : level === "watch" ? TriangleAlert : CircleCheck;
  const body = (
    <div className="flex items-start gap-3 px-4 py-3">
      <Icon aria-label={level === "act" ? "Act now" : level === "watch" ? "Watch" : "OK"} className={cn("mt-0.5 size-[18px] shrink-0", level === "act" ? "text-crit" : level === "watch" ? "text-warn-ink" : "text-good")} />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-ink">{label}</div>
        <div className="text-[12px] text-ink-3">{note}</div>
      </div>
      <div className="display tabular text-[20px] leading-6 text-ink">{value}</div>
    </div>
  );
  return href ? <Link href={href} className="block hover:bg-surface-2">{body}</Link> : body;
}

/** The brief's safety panel, as a status list: each row says whether it needs action. */
export function Guardrails({ d, windowLabel }: { d: GuardrailData; windowLabel: string }) {
  const overCap = !!d.voiceCap && d.voiceToday >= d.voiceCap;
  const rows: { level: Level; label: string; value: React.ReactNode; note: string; href?: string }[] = [
    { level: d.pricesSpoken ? "act" : "ok", label: "Prices spoken by the agent", value: d.pricesSpoken, note: d.pricesSpoken ? "review the transcript and agent setup" : "no figure from the pricing guide reached a caller", href: d.pricesSpoken ? "/exceptions?kind=pricing_violation" : undefined },
    { level: "ok", label: "Answers the price guard rewrote", value: d.caughtBeforeSpeaking, note: "replaced with the approved reply before speaking" },
    { level: d.complaints ? "watch" : "ok", label: "Complaints from existing clients", value: d.complaints, note: d.complaints ? (d.complaintAlertSeconds != null ? `seniors alerted in ${fmtDuration(d.complaintAlertSeconds)} (median) — confirm the callback` : "confirm a senior called back") : "none", href: d.complaints ? "/desk" : undefined },
    { level: d.failedCallsOpen ? "watch" : "ok", label: "Dropped or failed calls to follow up", value: d.failedCallsOpen, note: "callers we may have lost mid-call", href: d.failedCallsOpen ? "/exceptions?kind=failed_call" : undefined },
    { level: d.callsOver5Min ? "watch" : "ok", label: "Calls longer than 5 minutes", value: d.callsOver5Min, note: "longer calls cost more and tire callers" },
    { level: overCap ? "act" : "ok", label: "Voice spend today", value: inr(d.voiceToday), note: d.voiceCap ? `daily alert at ${inr(d.voiceCap)}` : "set a daily alert in Settings" },
    { level: d.integrationsHealthy < d.integrationsTotal ? "watch" : "ok", label: "Integrations healthy", value: `${d.integrationsHealthy}/${d.integrationsTotal}`, note: "last operation per provider", href: "/integrations" },
  ];
  const act = rows.filter((r) => r.level === "act").length;
  return (
    <Card>
      <div className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <div><h2 className="text-[14.5px] font-semibold">Guardrails</h2><p className="text-[12px] text-ink-3">{windowLabel}</p></div>
        {act ? <Badge tone="crit">{act} to act on</Badge> : <Badge tone="good">Within limits</Badge>}
      </div>
      <div className="divide-y divide-line">{rows.map((r) => <Row key={r.label} {...r} />)}</div>
    </Card>
  );
}

/** Horizontal single-hue bars with a table view for exact values. */
export function BarList({ rows, format = (n) => String(n), empty = "No data yet.", tone = "series" }: { rows: { label: string; n: number }[]; format?: (n: number) => string; empty?: string; tone?: "series" | "lavender" | "mint" }) {
  if (!rows.length) return <p className="py-2 text-[13px] text-ink-3">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.n), 1);
  const fill = tone === "lavender" ? "bg-[#8f84d9]" : tone === "mint" ? "bg-[#4fae8b]" : "bg-[var(--series-1)]";
  return (
    <div>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.label} className="text-[13px]" title={`${r.label}: ${format(r.n)}`}>
            <div className="flex justify-between"><span className="text-ink-2 capitalize">{r.label}</span><span className="tabular text-ink">{format(r.n)}</span></div>
            <div className="mt-1 h-1.5 rounded-full bg-line/70" aria-hidden><div className={cn("h-1.5 rounded-full", fill)} style={{ width: `${Math.max(3, (r.n / max) * 100)}%` }} /></div>
          </li>
        ))}
      </ul>
      <details className="mt-2 text-[12px] text-ink-3">
        <summary className="cursor-pointer">Table view</summary>
        <table className="mt-1 w-full"><tbody>{rows.map((r) => <tr key={r.label}><td className="py-0.5 capitalize">{r.label}</td><td className="tabular text-right">{format(r.n)}</td></tr>)}</tbody></table>
      </details>
    </div>
  );
}

const OUTCOME: Record<string, { tone: "good" | "warn" | "crit" | "accent" | "neutral"; label: string }> = {
  green: { tone: "good", label: "Green" },
  amber: { tone: "warn", label: "Amber" },
  red: { tone: "crit", label: "Red" },
  needs_review: { tone: "accent", label: "Decision" },
  needs_clarification: { tone: "accent", label: "Decision" },
  not_evaluated: { tone: "neutral", label: "Open" },
};
export function OutcomePill({ status }: { status: string }) {
  const o = OUTCOME[status] ?? OUTCOME.not_evaluated;
  return <Badge tone={o.tone}>{o.label}</Badge>;
}
