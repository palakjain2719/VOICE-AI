import Link from "next/link";
import { AlertTriangle, CheckCircle2, CircleDashed, CircleHelp, Info, OctagonAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-[10px] border border-line bg-surface", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, action }: { title: string; description?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
      <div className="min-w-0">
        <h2 className="text-[14.5px] font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-[13px] text-ink-3">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, eyebrow, children }: { title: string; description?: string; eyebrow?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-7 flex flex-col gap-3 border-b border-line pb-5 md:flex-row md:items-end md:justify-between">
      <div>
        {eyebrow ? <div className="eyebrow mb-1.5">{eyebrow}</div> : null}
        <h1 className="display text-[30px] leading-9 font-medium text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-ink-3">{description}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

export function Kpi({
  label,
  value,
  sub,
  tone = "plain",
  href,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "plain" | "lavender" | "sky" | "mint";
  href?: string;
}) {
  const bg = { plain: "bg-surface", lavender: "bg-surface", sky: "bg-surface", mint: "bg-surface" }[tone];
  const bar = { plain: "bg-line-strong", lavender: "bg-[#b9b0ee]", sky: "bg-[#a9c8ee]", mint: "bg-[#9fd6bf]" }[tone];
  const body = (
    <div className={cn("relative h-full overflow-hidden rounded-[10px] border border-line p-4 pl-5 transition-colors", bg, href && "hover:border-line-strong")}>
      <span aria-hidden className={cn("absolute inset-y-3 left-0 w-[3px] rounded-r", bar)} />
      <div className="text-[12.5px] font-medium text-ink-2">{label}</div>
      <div className="display tabular mt-1 text-[28px] leading-9 text-ink">{value}</div>
      {sub ? <div className="mt-1 text-[12.5px] text-ink-3">{sub}</div> : null}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full rounded-[10px]">
      {body}
    </Link>
  ) : (
    body
  );
}

type Tone = "neutral" | "good" | "warn" | "crit" | "accent" | "info";
const toneClass: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-2 border-line",
  good: "bg-good-soft text-good-ink border-transparent",
  warn: "bg-warn-soft text-warn-ink border-transparent",
  crit: "bg-crit-soft text-crit-ink border-transparent",
  accent: "bg-accent-soft text-accent border-transparent",
  info: "bg-sky text-ink-2 border-transparent",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] font-medium whitespace-nowrap", toneClass[tone], className)}>
      {children}
    </span>
  );
}

/** Qualification status always carries an icon and a word, never colour alone. */
export function QualificationBadge({ status }: { status: string }) {
  const map: Record<string, { tone: Tone; label: string; Icon: typeof CheckCircle2 }> = {
    green: { tone: "good", label: "Green", Icon: CheckCircle2 },
    amber: { tone: "warn", label: "Amber", Icon: AlertTriangle },
    red: { tone: "crit", label: "Red", Icon: XCircle },
    needs_review: { tone: "accent", label: "Review", Icon: CircleHelp },
    needs_clarification: { tone: "accent", label: "Clarifying", Icon: CircleHelp },
    not_evaluated: { tone: "neutral", label: "Not evaluated", Icon: CircleDashed },
  };
  const m = map[status] ?? map.not_evaluated;
  return (
    <Badge tone={m.tone}>
      <m.Icon aria-hidden className="size-3.5" />
      {m.label}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  if (severity === "critical")
    return (
      <Badge tone="crit">
        <OctagonAlert aria-hidden className="size-3.5" /> Critical
      </Badge>
    );
  if (severity === "high")
    return (
      <Badge tone="warn">
        <AlertTriangle aria-hidden className="size-3.5" /> High
      </Badge>
    );
  if (severity === "low") return <Badge>Low</Badge>;
  return (
    <Badge tone="info">
      <Info aria-hidden className="size-3.5" /> Normal
    </Badge>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon ? <div className="text-ink-3">{icon}</div> : null}
      <div className="text-sm font-medium text-ink-2">{title}</div>
      {children ? <div className="max-w-md text-[13px] text-ink-3">{children}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-line/60", className)} />;
}

export function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
      <Skeleton className="h-48" />
    </div>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-transparent bg-crit-soft px-4 py-3 text-sm text-crit-ink">
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-xl px-4 py-3 text-[13px]", tone === "warn" ? "bg-warn-soft text-warn-ink" : "bg-sky text-ink-2")}>
      <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full min-w-[640px] border-collapse text-left text-[13.5px]">{children}</table>
    </div>
  );
}
export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cn("border-b border-line px-4 py-2.5 text-[12px] font-medium tracking-wide text-ink-3 uppercase", className)}>{children}</th>;
}
export function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={cn("border-b border-line/70 px-4 py-2.5 align-top text-ink", className)}>{children}</td>;
}

export function ButtonLink({ href, children, variant = "secondary" }: { href: string; children: React.ReactNode; variant?: "primary" | "secondary" }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-sm font-medium transition-colors",
        variant === "primary" ? "bg-accent text-accent-ink hover:opacity-90" : "border border-line bg-surface text-ink hover:border-line-strong",
      )}
    >
      {children}
    </Link>
  );
}

export const inr = (n: number | null | undefined, opts: { compact?: boolean } = {}) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: opts.compact ? 1 : 0, notation: opts.compact ? "compact" : "standard" }).format(n);

export const pctText = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export function delta(curr: number, prev: number): React.ReactNode {
  if (prev === 0 && curr === 0) return "no change vs previous period";
  if (prev === 0) return "no data in previous period";
  const d = (curr - prev) / prev;
  return `${d >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(d * 100))}% vs previous period`;
}

export function dateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

/** A row of figures separated by hairlines — the overview's headline numbers. */
export function Ledger({ items }: { items: { label: string; value: React.ReactNode; note?: React.ReactNode; href?: string }[] }) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-[10px] border border-line bg-surface md:grid-cols-3 xl:grid-cols-6">
      {items.map((it) => {
        const inner = (
          <div className="h-full border-line p-4 [border-right-width:1px] [border-bottom-width:1px]">
            <div className="text-[12.5px] text-ink-2">{it.label}</div>
            <div className="display tabular mt-1 text-[26px] leading-8 text-ink">{it.value}</div>
            {it.note ? <div className="mt-1 text-[12px] leading-snug text-ink-3">{it.note}</div> : null}
          </div>
        );
        return it.href ? <Link key={it.label} href={it.href} className="block hover:bg-surface-2">{inner}</Link> : <div key={it.label}>{inner}</div>;
      })}
    </div>
  );
}
