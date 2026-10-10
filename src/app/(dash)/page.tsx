import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { ArrowUpRight } from "lucide-react";
import { PeriodSelect } from "@/components/filters";
import { FunnelChart } from "@/components/charts/charts";
import { Card, CardHeader, dateTime, ErrorNote, inr, Ledger, PageHeader, PageSkeleton, pctText } from "@/components/ui";
import { BarList, fmtDuration, Guardrails, OutcomePill } from "@/components/ops";
import { RefreshSummary } from "@/components/ops-client";
import { resolvePeriod } from "@/domain/metrics/period";
import { createDataClient } from "@/lib/supabase/server";
import { log, safeErrorMessage } from "@/lib/log";
import { requestNow } from "@/lib/time";
import { requirePageRole } from "@/server/auth";
import { getOverviewData } from "@/server/ops-dashboard";
import { latestAiSummary } from "@/server/ai-summary";

export default function OverviewPage({ searchParams }: PageProps<"/">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Overview searchParams={searchParams} />
    </Suspense>
  );
}

const DECLINE: Record<string, string> = { category: "Project type or size", area: "Outside Pune / PCMC", budget: "Budget clearly short", timeline: "Timeline too tight", engagement: "Advice only / not deciding" };

async function Overview({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  await requirePageRole("founder", "operator");
  const sp = (await searchParams) as Record<string, string>;
  const period = resolvePeriod(sp);
  const includeTest = sp.test === "1";
  const toggleHref = `/?${new URLSearchParams({ ...(sp.period ? { period: sp.period } : {}), ...(includeTest ? {} : { test: "1" }) }).toString()}`;
  const db = await createDataClient();
  let d: Awaited<ReturnType<typeof getOverviewData>>;
  let saved: Awaited<ReturnType<typeof latestAiSummary>>;
  try {
    [d, saved] = await Promise.all([getOverviewData(db, period, includeTest), latestAiSummary(db)]);
  } catch (e) {
    unstable_rethrow(e);
    log.error("overview.load_failed", { error: safeErrorMessage(e) });
    return <ErrorNote>The overview couldn&apos;t load. Check Integrations → Supabase, then refresh.</ErrorNote>;
  }
  const { funnel: f, kpis: k, pipeline: p, demand, backlog } = d;
  const useSaved = !includeTest && period.key === "7d" && saved && requestNow() - Date.parse(saved.created_at) < 36 * 3600_000;
  const bullets = useSaved ? saved!.bullets : d.bullets;
  const steps = [
    { label: "Calls", count: f.incoming, conversion: null },
    { label: "Answered", count: f.answered, conversion: f.incoming ? f.answered / f.incoming : null },
    { label: "Qualified", count: f.qualified, conversion: f.answered ? f.qualified / f.answered : null },
    { label: "Booked", count: f.booked, conversion: f.qualified ? f.booked / f.qualified : null },
    { label: "Consultation held", count: f.consultation_completed, conversion: f.booked ? f.consultation_completed / f.booked : null },
    { label: "Deal open", count: f.deal_opened, conversion: f.consultation_completed ? f.deal_opened / f.consultation_completed : null },
    { label: "Won", count: f.won, conversion: f.deal_opened ? f.won / f.deal_opened : null },
  ];

  return (
    <>
      <PageHeader eyebrow={`Overview · ${period.label}`} title="How the enquiry desk is doing" description={includeTest ? "Including test calls from the Test call console. Revenue figures come from HubSpot." : "Live calls only. Revenue figures come from HubSpot; nothing is estimated from the pricing guide."}>
        <Link href={toggleHref} className={includeTest ? "inline-flex h-9 items-center rounded-lg border border-warn bg-warn-soft px-3 text-[13px] font-medium text-warn-ink" : "inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-[13px] text-ink-2 hover:border-line-strong"}>
          {includeTest ? "✓ Including test calls" : "Include test calls"}
        </Link>
        <Suspense><PeriodSelect /></Suspense>
      </PageHeader>
      {includeTest ? <div role="note" className="mb-5 rounded-lg border border-dashed border-warn bg-warn-soft px-4 py-2 text-[13px] text-warn-ink">Test calls are included in every figure on this page. Switch off before reading the numbers as real business results.</div> : null}

      <section aria-label="Summary" className="mb-6 grid gap-x-8 gap-y-2 md:grid-cols-[180px_1fr]">
        <div>
          <div className="eyebrow">In short</div>
          <div className="mt-1 text-[12px] text-ink-3">{useSaved ? `Worded ${dateTime(saved!.created_at)}` : "From counted data"}</div>
          <div className="mt-2"><RefreshSummary /></div>
        </div>
        <ul className="space-y-1.5 text-[15px] leading-relaxed text-ink">
          {bullets.map((b) => (
            <li key={b.text}>{b.text} <Link href={b.href} className="inline-flex items-center text-[13px] font-medium text-accent hover:underline">see<ArrowUpRight aria-hidden className="size-3.5" /></Link></li>
          ))}
        </ul>
      </section>

      <Ledger
        items={[
          { label: "Calls answered", value: `${f.answered}`, note: `of ${f.incoming} · ${f.failed} failed`, href: "/calls" },
          { label: "Answered after hours", value: k.after_hours, note: `${pctText(k.calls ? k.after_hours / k.calls : null)} of calls came when the studio was closed` },
          { label: "Qualified", value: f.qualified, note: `${f.green} green · ${f.amber} amber · ${f.red} declined` },
          { label: "Consultations booked", value: f.booked, note: `booking rate ${pctText(f.qualified ? f.booked / f.qualified : null)} of qualified` },
          { label: "Designer handoff", value: fmtDuration(k.handoff_median_seconds), note: `median call end → brief in designer's inbox · ${k.handoffs} sent` },
          { label: "Weighted pipeline", value: inr(p.weighted, { compact: true }), note: `${inr(p.unweighted, { compact: true })} open · ${p.openCount} deals`, href: "/pipeline" },
        ]}
      />

      <div className="mt-6 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="From call to signed project" description="Distinct leads reaching each stage · later stages come from HubSpot" action={<Link href={`/funnel?period=${period.key}`} className="text-[13px] font-medium text-accent">Filter by designer or type</Link>} />
          <div className="px-3"><FunnelChart steps={steps} /></div>
          <dl className="grid grid-cols-3 gap-4 border-t border-line px-5 py-4 text-[13px]">
            <div><dt className="text-ink-3">Show-up rate</dt><dd className="display tabular text-[20px]">{pctText(k.consultations_due ? k.consultations_completed / k.consultations_due : null)}</dd></div>
            <div><dt className="text-ink-3">Won after a consultation</dt><dd className="display tabular text-[20px]">{pctText(k.consultations_completed ? k.won / k.consultations_completed : null)}</dd></div>
            <div><dt className="text-ink-3">Average call</dt><dd className="display tabular text-[20px]">{fmtDuration(k.avg_duration_seconds)}</dd></div>
          </dl>
        </Card>
        <Guardrails d={d.guardrails} windowLabel={period.label} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Demand" description="Where enquiries come from, what they're for, and why some aren't a fit" />
          <div className="grid gap-6 px-5 pb-5 md:grid-cols-3">
            <div><h3 className="eyebrow mb-3">Areas</h3><BarList rows={demand.localities} /></div>
            <div><h3 className="eyebrow mb-3">Not a fit because</h3><BarList tone="lavender" rows={demand.declines.map((r) => ({ label: DECLINE[r.label] ?? r.label, n: r.n }))} empty="Nobody turned away." /></div>
            <div><h3 className="eyebrow mb-3">Home or office</h3><BarList tone="mint" rows={demand.project_mix} /></div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Needs a person" description="Each line links to the records behind it" />
          <div className="grid grid-cols-3 border-y border-line text-center">
            {[["Designer", backlog.byLane.designer, "/exceptions?lane=designer"], ["Admin", backlog.byLane.admin, "/exceptions?lane=admin"], ["Call back", backlog.byLane.callback, "/desk"]].map(([l, n, h]) => (
              <Link key={l as string} href={h as string} className="border-line py-3 hover:bg-surface-2 [&:not(:last-child)]:border-r"><div className="display tabular text-[22px]">{n}</div><div className="text-[12px] text-ink-3">{l}</div></Link>
            ))}
          </div>
          {backlog.total ? <p className={backlog.oldestHours > 24 ? "px-4 pt-2 text-[12px] font-medium text-crit-ink" : "px-4 pt-2 text-[12px] text-ink-3"}>Oldest waiting {backlog.oldestHours} h · aim for under 24 h</p> : null}
          {d.attention.length === 0 ? <p className="px-4 py-4 text-[13px] text-ink-3">Nothing needs attention.</p> : (
            <ul className="divide-y divide-line">
              {d.attention.slice(0, 6).map((a) => (
                <li key={a.key}><Link href={a.href} className="flex gap-2 px-4 py-2.5 text-[13.5px] hover:bg-surface-2">
                  <span aria-hidden className={a.severity === "critical" ? "mt-1.5 size-2 shrink-0 rounded-full bg-crit" : a.severity === "warning" ? "mt-1.5 size-2 shrink-0 rounded-full bg-warn" : "mt-1.5 size-2 shrink-0 rounded-full bg-line-strong"} />
                  <span>{a.text}</span>
                </Link></li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader title="Latest calls" action={<Link href="/calls" className="text-[13px] font-medium text-accent">All calls</Link>} />
        {d.recent.length === 0 ? <p className="px-5 pb-5 text-[13px] text-ink-3">No live calls yet — they appear here as soon as the agent answers. Try a <Link href="/test-call" className="font-medium text-accent">test call</Link>.</p> : (
          <ul className="grid divide-y divide-line border-t border-line md:grid-cols-2 md:divide-y-0">
            {d.recent.map((c) => (
              <li key={c.id} className="md:border-b md:border-line md:odd:border-r"><Link href={`/calls/${c.id}`} className="flex items-center gap-3 px-5 py-2.5 text-[13.5px] hover:bg-surface-2">
                <span className="w-24 shrink-0 text-[12px] text-ink-3">{dateTime(c.started_at).split(",")[0]}</span>
                <span className="flex-1 truncate">{c.leads?.name ?? c.call_type.replace(/_/g, " ")}{c.is_test ? <span className="ml-2 rounded bg-warn-soft px-1.5 text-[11px] font-semibold text-warn-ink">TEST</span> : null}</span>
                {c.leads ? <OutcomePill status={c.leads.qualification_status} /> : null}
                <span className="tabular w-10 text-right text-[12.5px] text-ink-3">{fmtDuration(c.duration_seconds)}</span>
              </Link></li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
