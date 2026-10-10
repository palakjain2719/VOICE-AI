import Link from "next/link";
import { Suspense } from "react";
import { Inbox } from "lucide-react";
import { Card, EmptyState, ErrorNote, PageHeader, PageSkeleton, SeverityBadge } from "@/components/ui";
import { DecisionButtons } from "@/components/ops-client";
import { createDataClient } from "@/lib/supabase/server";
import { requestNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { hasRole, requirePageRole } from "@/server/auth";
import { KIND_LABEL } from "./labels";

const LANES = [
  ["designer", "A designer's call", "Enquiries the rules couldn't settle — approve to book, or decline politely"],
  ["admin", "Admin", "Integration failures, unanswered questions, pricing-policy flags"],
  ["callback", "Call back", "Callers to ring: unfinished enquiries, dropped calls, missing details"],
] as const;

export default function DecisionsPage({ searchParams }: PageProps<"/exceptions">) {
  return (
    <>
      <PageHeader eyebrow="Decisions" title="Waiting on a person" description="Clearly qualified callers never wait here — they're booked and sent to HubSpot automatically." />
      <Suspense fallback={<PageSkeleton />}>
        <Queue searchParams={searchParams} />
      </Suspense>
    </>
  );
}

type Row = {
  id: string; kind: string; lane: string; status: string; severity: string; title: string; detail: string | null; created_at: string; call_id: string | null;
  leads: { name: string | null; project_scope: string | null; project_type: string | null; location: string | null; uncertainties: { detail?: string }[] | null } | null;
  calls: { intake: Record<string, unknown> | null } | null;
};

async function Queue({ searchParams }: { searchParams: PageProps<"/exceptions">["searchParams"] }) {
  const user = await requirePageRole("founder", "operator", "designer");
  const sp = (await searchParams) as Record<string, string>;
  const lane = (LANES.map((l) => l[0]) as string[]).includes(sp.lane) ? sp.lane : sp.kind ? null : "designer";
  const db = await createDataClient();
  const base = db
    .from("exceptions")
    .select("id, kind, lane, status, severity, title, detail, created_at, call_id, leads(name, project_scope, project_type, location, uncertainties), calls(intake)")
    .eq("is_test", false)
    .in("status", ["open", "in_review"])
    .order("created_at", { ascending: true })
    .limit(200);
  const [{ data, error }, counts, pricing] = await Promise.all([
    sp.kind ? base.eq("kind", sp.kind) : base.eq("lane", lane!),
    db.from("exceptions").select("lane").eq("is_test", false).in("status", ["open", "in_review"]),
    db.from("policy_events").select("call_id").eq("kind", "pricing_request_deflected").eq("is_test", false).limit(2000),
  ]);
  if (error) return <ErrorNote>The queue couldn&apos;t load. Please refresh.</ErrorNote>;
  const n = (l: string) => (counts.data ?? []).filter((c) => c.lane === l).length;
  const askedPrice = new Set((pricing.data ?? []).map((p) => p.call_id));
  const rows = (data ?? []) as unknown as Row[];
  const canDecide = hasRole(user, "operator") || hasRole(user, "designer");
  const now = requestNow();
  const current = LANES.find((l) => l[0] === lane);

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        {LANES.map(([key, label]) => (
          <Link key={key} href={`/exceptions?lane=${key}`} aria-current={lane === key ? "page" : undefined}
            className={cn("rounded-[10px] border px-4 py-3 transition-colors", lane === key ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong")}>
            <div className="display tabular text-[24px] leading-7">{n(key)}</div>
            <div className={cn("text-[13px] font-medium", lane === key ? "text-accent" : "text-ink-2")}>{label}</div>
          </Link>
        ))}
      </div>
      <p className="text-[13px] text-ink-3">{sp.kind ? `Showing: ${KIND_LABEL[sp.kind] ?? sp.kind}` : current?.[2]}{n("complaint") ? <> · <Link href="/desk" className="text-accent">{n("complaint")} complaints are on the Callbacks list</Link></> : null}</p>

      <Card>
        {rows.length === 0 ? <EmptyState title="Nothing waiting" icon={<Inbox className="size-6" />}>Items arrive here only when a call needs a human decision, a callback, or an integration needs attention.</EmptyState> : (
          <ul className="divide-y divide-line">
            {rows.map((r) => {
              const l = r.leads;
              const ageH = Math.round((now - Date.parse(r.created_at)) / 3600_000);
              const callback = (r.calls?.intake?.callback_window as string | undefined) ?? (r.calls?.intake?.timeline_text as string | undefined) ?? null;
              const notes = [...((l?.uncertainties ?? []).map((u) => u.detail).filter(Boolean) as string[]), r.call_id && askedPrice.has(r.call_id) ? "asked about price" : null].filter(Boolean) as string[];
              const actions = r.lane === "designer"
                ? (["approve", "reject", "route_admin", "route_callback"] as const)
                : r.lane === "callback" && l ? (["approve", "reject", "route_designer", "route_admin"] as const) : (["route_designer", "route_callback"] as const);
              return (
                <li key={r.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Link href={`/exceptions/${r.id}`} className="font-semibold text-ink hover:text-accent">{l?.name ?? r.title}</Link>
                      <span className="text-[12px] text-ink-3">{KIND_LABEL[r.kind] ?? r.kind}</span>
                      {r.severity === "high" || r.severity === "critical" ? <SeverityBadge severity={r.severity} /> : null}
                      <span className={cn("text-[12px]", ageH > 24 ? "font-medium text-crit-ink" : "text-ink-3")}>{ageH} h waiting</span>
                    </div>
                    {l ? <p className="mt-0.5 text-[13px] text-ink-2">{[l.project_scope ?? l.project_type, l.location].filter(Boolean).join(" · ")}</p> : null}
                    <p className="mt-0.5 text-[13px] text-ink"><span className="text-ink-3">Why: </span>{r.detail ?? r.title}</p>
                    {notes.length || callback ? <p className="text-[12px] text-ink-3">{[callback && `free ${callback}`, ...notes].filter(Boolean).join(" · ")}</p> : null}
                  </div>
                  <div>{canDecide ? <DecisionButtons id={r.id} actions={[...actions]} /> : <span className="text-[12px] text-ink-3">view only</span>}</div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
