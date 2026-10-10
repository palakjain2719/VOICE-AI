import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { PeriodSelect } from "@/components/filters";
import { Badge, Card, CardHeader, ErrorNote, inr, Kpi, Notice, PageHeader, PageSkeleton, Table, Td, Th } from "@/components/ui";
import { resolvePeriod } from "@/domain/metrics/period";
import { createDataClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { getCosts, getFunnel } from "@/server/dashboard";

export default function CostsPage({ searchParams }: PageProps<"/costs">) {
  return (
    <>
      <PageHeader title="Automation cost" description="Provider-reported costs and clearly labelled estimates.">
        <Suspense>
          <PeriodSelect />
        </Suspense>
      </PageHeader>
      <Suspense fallback={<PageSkeleton />}>
        <Costs searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Costs({ searchParams }: { searchParams: PageProps<"/costs">["searchParams"] }) {
  await requirePageRole("founder", "operator");
  const period = resolvePeriod((await searchParams) as Record<string, string>);
  const db = await createDataClient();
  let rows, f;
  try {
    [rows, f] = await Promise.all([getCosts(db, period), getFunnel(db, period.from, period.to)]);
  } catch (e) {
    unstable_rethrow(e);
    return <ErrorNote>Cost data couldn&apos;t load. Please refresh.</ErrorNote>;
  }
  const inrRows = rows.filter((r) => r.currency === "INR");
  const total = inrRows.reduce((s, r) => s + Number(r.cost_amount), 0);
  const actual = inrRows.filter((r) => !r.is_estimate).reduce((s, r) => s + Number(r.cost_amount), 0);
  const hasVaani = inrRows.some((r) => r.provider === "vaani");
  const per = (n: number) => (n > 0 && hasVaani ? inr(total / n) : "—");

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-3">{period.label}</p>
      {!hasVaani ? <Notice>No Vaani charges have been reported for this period, so per-call costs are not shown. Vaani reports charges through the <code>usage.charged</code> webhook.</Notice> : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Total recorded cost" value={inr(total)} sub={`${inr(actual)} provider-reported`} tone="sky" />
        <Kpi label="Cost per call" value={per(f.incoming)} sub={`${f.incoming} calls`} />
        <Kpi label="Cost per qualified lead" value={per(f.qualified)} sub={`${f.qualified} qualified`} />
        <Kpi label="Cost per booked consultation" value={per(f.booked)} sub={`${f.booked} booked`} />
        <Kpi label="Estimated share" value={inr(total - actual)} sub="Gemini token estimates" />
      </div>
      <Card>
        <CardHeader title="Breakdown" />
        {rows.length === 0 ? (
          <p className="px-5 pb-5 text-[13px] text-ink-3">No cost events recorded in this period.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Provider</Th>
                <Th>Usage</Th>
                <Th>Basis</Th>
                <Th className="text-right">Units</Th>
                <Th className="text-right">Events</Th>
                <Th className="text-right">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.provider}-${r.usage_type}-${r.is_estimate}-${r.currency}`}>
                  <Td className="capitalize">{r.provider}</Td>
                  <Td>{r.usage_type}</Td>
                  <Td>{r.is_estimate ? <Badge tone="warn">Estimate</Badge> : <Badge tone="good">Provider-reported</Badge>}</Td>
                  <Td className="tabular text-right">{r.units == null ? "—" : Number(r.units).toFixed(1)}</Td>
                  <Td className="tabular text-right">{r.events}</Td>
                  <Td className="tabular text-right">{r.currency === "INR" ? inr(Number(r.cost_amount)) : `${r.currency} ${Number(r.cost_amount).toFixed(2)}`}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="px-5 py-3 text-[12.5px] text-ink-3">Gemini costs are recorded only after an admin enters token rates and an exchange rate in Settings, and are always marked as estimates.</p>
      </Card>
    </div>
  );
}
