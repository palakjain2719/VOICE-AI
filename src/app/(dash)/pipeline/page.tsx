import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { PeriodSelect } from "@/components/filters";
import { AmountBars, ForecastChart } from "@/components/charts/charts";
import { Card, CardHeader, dateTime, ErrorNote, inr, Kpi, Notice, PageHeader, PageSkeleton, Table, Td, Th } from "@/components/ui";
import { resolvePeriod } from "@/domain/metrics/period";
import { computePipeline } from "@/domain/metrics/pipeline";
import { createDataClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { getDeals, getOperational, listDesigners } from "@/server/dashboard";

export default function PipelinePage({ searchParams }: PageProps<"/pipeline">) {
  return (
    <>
      <PageHeader title="Pipeline & revenue" description="Read from HubSpot. Unweighted and probability-weighted values are shown separately; revenue counts only closed-won deals.">
        <Suspense>
          <PeriodSelect />
        </Suspense>
      </PageHeader>
      <Suspense fallback={<PageSkeleton />}>
        <Pipeline searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Pipeline({ searchParams }: { searchParams: PageProps<"/pipeline">["searchParams"] }) {
  await requirePageRole("founder", "operator");
  const period = resolvePeriod((await searchParams) as Record<string, string>);
  const db = await createDataClient();
  let deals, ops, designers;
  try {
    [deals, ops, designers] = await Promise.all([getDeals(db), getOperational(db), listDesigners(db)]);
  } catch (e) {
    unstable_rethrow(e);
    return <ErrorNote>Pipeline data couldn&apos;t load. Please refresh.</ErrorNote>;
  }
  const p = computePipeline(deals, period);
  const name = (key: string) => designers.find((d) => d.id === key)?.name ?? (key.startsWith("owner:") ? `HubSpot owner ${key.slice(6)}` : "Unassigned");
  const sync = ops.hubspotSync;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-ink-3">
        <span>Revenue period: {period.label}</span>
        <span aria-hidden>·</span>
        <span>Last HubSpot sync: {sync?.last_success_at ? dateTime(sync.last_success_at) : "never"}</span>
        {sync?.last_error_at && (!sync.last_success_at || sync.last_error_at > sync.last_success_at) ? <span className="text-crit-ink">Last sync failed</span> : null}
      </div>
      {deals.length === 0 ? (
        <Notice>No HubSpot deals have been synced yet. Once HubSpot is connected and the pipeline mapping is set, deals appear here within one sync cycle.</Notice>
      ) : null}
      {p.currencies.length > 1 ? <Notice tone="warn">Deals use more than one currency ({p.currencies.join(", ")}). Totals add raw amounts; convert in HubSpot for accurate sums.</Notice> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Open pipeline (unweighted)" value={inr(p.open.amount, { compact: true })} sub={`${p.open.count} open deals`} tone="sky" />
        <Kpi label="Weighted pipeline" value={inr(p.open.weighted, { compact: true })} sub="Σ amount × stage probability" tone="sky" />
        <Kpi label="Closed-won revenue" value={inr(p.won.revenue, { compact: true })} sub={`${p.won.count} deals won in period`} tone="mint" />
        <Kpi label="Lost deals" value={p.lost.count} sub="Closed lost in period" />
        <Kpi label="Missing amount" value={p.open.missingAmount} sub="Open deals excluded from value" />
        <Kpi label="Missing probability" value={p.open.missingProbability} sub="Excluded from weighted value" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Open pipeline by stage" description="Unweighted amount" />
          <div className="px-3 pb-3">
            {p.byStage.length ? <AmountBars data={p.byStage.map((s) => ({ label: s.label, value: s.amount }))} valueLabel="Amount" /> : <p className="px-2 py-8 text-center text-[13px] text-ink-3">No open deals.</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title="Forecast by expected close" description={p.forecast.noCloseDate ? `${p.forecast.noCloseDate} open deals have no close date and are excluded` : "Open deals by expected close date"} />
          <div className="px-4 pb-4">
            <ForecastChart month={p.forecast.month} quarter={p.forecast.quarter} year={p.forecast.year} />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Deals by stage" />
          <Table>
            <thead>
              <tr>
                <Th>Stage</Th>
                <Th className="text-right">Deals</Th>
                <Th className="text-right">Probability</Th>
                <Th className="text-right">Unweighted</Th>
                <Th className="text-right">Weighted</Th>
              </tr>
            </thead>
            <tbody>
              {p.byStage.map((s) => (
                <tr key={s.stageId}>
                  <Td>{s.label}</Td>
                  <Td className="tabular text-right">{s.count}</Td>
                  <Td className="tabular text-right">{s.probability == null ? "—" : `${Math.round(s.probability * 100)}%`}</Td>
                  <Td className="tabular text-right">{inr(s.amount)}</Td>
                  <Td className="tabular text-right">{inr(s.weighted)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="By designer" description="Assigned through HubSpot deal owner" />
          <Table>
            <thead>
              <tr>
                <Th>Designer</Th>
                <Th className="text-right">Open deals</Th>
                <Th className="text-right">Unweighted</Th>
                <Th className="text-right">Weighted</Th>
              </tr>
            </thead>
            <tbody>
              {p.byOwner.map((o) => (
                <tr key={o.ownerKey}>
                  <Td>{name(o.ownerKey)}</Td>
                  <Td className="tabular text-right">{o.count}</Td>
                  <Td className="tabular text-right">{inr(o.amount)}</Td>
                  <Td className="tabular text-right">{inr(o.weighted)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
      <Card>
        <CardHeader title="Open deals" description="Closest expected close first" />
        <Table>
          <thead>
            <tr>
              <Th>Deal</Th>
              <Th>Stage</Th>
              <Th>Designer</Th>
              <Th>Expected close</Th>
              <Th className="text-right">Amount</Th>
            </tr>
          </thead>
          <tbody>
            {deals
              .filter((d) => !d.is_closed)
              .sort((a, b) => (a.close_date ?? "9999").localeCompare(b.close_date ?? "9999"))
              .slice(0, 50)
              .map((d) => (
                <tr key={d.hubspot_deal_id}>
                  <Td>{d.deal_name ?? d.hubspot_deal_id}</Td>
                  <Td>{d.stage_label ?? "—"}</Td>
                  <Td>{name(d.designer_id ?? (d.hubspot_owner_id ? `owner:${d.hubspot_owner_id}` : "unassigned"))}</Td>
                  <Td>{d.close_date ? dateTime(d.close_date).split(",")[0] : "—"}</Td>
                  <Td className="tabular text-right">{d.amount == null ? <span className="text-ink-3">not set</span> : inr(d.amount)}</Td>
                </tr>
              ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
