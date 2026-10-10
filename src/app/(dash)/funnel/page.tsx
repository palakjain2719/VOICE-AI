import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { ParamSelect, PeriodSelect } from "@/components/filters";
import { FunnelChart } from "@/components/charts/charts";
import { Card, CardHeader, ErrorNote, PageHeader, PageSkeleton, pctText, Table, Td, Th } from "@/components/ui";
import { funnelSteps } from "@/domain/metrics/insights";
import { resolvePeriod } from "@/domain/metrics/period";
import { createDataClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { getFunnel, listDesigners, listProjectTypes } from "@/server/dashboard";

export default function FunnelPage({ searchParams }: PageProps<"/funnel">) {
  return (
    <>
      <PageHeader title="Sales funnel" description="Distinct leads reaching each stage within the period. Calls are counted by start time.">
        <Suspense>
          <PeriodSelect />
        </Suspense>
      </PageHeader>
      <Suspense fallback={<PageSkeleton />}>
        <Funnel searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Funnel({ searchParams }: { searchParams: PageProps<"/funnel">["searchParams"] }) {
  await requirePageRole("founder", "operator");
  const sp = (await searchParams) as Record<string, string>;
  const period = resolvePeriod(sp);
  const db = await createDataClient();
  const filters = { designer: sp.designer, projectType: sp.type, status: sp.status };
  let data;
  try {
    const [curr, prev, designers, types] = await Promise.all([
      getFunnel(db, period.from, period.to, filters),
      getFunnel(db, period.prevFrom, period.prevTo, filters),
      listDesigners(db),
      listProjectTypes(db),
    ]);
    data = { curr, prev, designers, types };
  } catch (e) {
    unstable_rethrow(e);
    return <ErrorNote>The funnel couldn&apos;t load. Please refresh.</ErrorNote>;
  }
  const steps = funnelSteps(data.curr);
  const prevSteps = funnelSteps(data.prev);
  const enoughPrev = data.prev.incoming >= 5;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink-3">{period.label}</span>
        <Suspense>
          <ParamSelect name="designer" label="Designer" options={data.designers.map((d) => ({ value: d.id, label: d.name }))} />
          <ParamSelect name="type" label="Project type" options={data.types.map((t) => ({ value: t, label: t }))} />
          <ParamSelect
            name="status"
            label="Lead status"
            options={[
              { value: "green", label: "Green" },
              { value: "amber", label: "Amber" },
              { value: "red", label: "Red" },
              { value: "needs_review", label: "Needs review" },
            ]}
          />
        </Suspense>
      </div>
      <Card>
        <CardHeader title="Incoming calls → Closed won" description="Bar label: count · conversion from the previous stage" />
        <div className="px-3 pb-3">
          <FunnelChart steps={steps} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Stage table" description={enoughPrev ? "Compared with the previous period of equal length" : "Previous-period comparison appears once there are at least 5 calls in it"} />
        <Table>
          <thead>
            <tr>
              <Th>Stage</Th>
              <Th className="text-right">Count</Th>
              <Th className="text-right">Step conversion</Th>
              {enoughPrev ? <Th className="text-right">Previous period</Th> : null}
              {enoughPrev ? <Th className="text-right">Change</Th> : null}
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={s.key}>
                <Td>{s.label}</Td>
                <Td className="tabular text-right">{s.count}</Td>
                <Td className="tabular text-right">{pctText(s.conversion)}</Td>
                {enoughPrev ? <Td className="tabular text-right">{prevSteps[i].count}</Td> : null}
                {enoughPrev ? <Td className="tabular text-right">{s.count - prevSteps[i].count >= 0 ? "+" : ""}{s.count - prevSteps[i].count}</Td> : null}
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="px-5 py-3 text-[12.5px] text-ink-3">
          Definitions: answered = provider-confirmed; eligible = Green or Amber by the rules engine; completed / open deal / won come from the lead&apos;s HubSpot deal stage. A booking is never counted as revenue.
        </p>
      </Card>
    </div>
  );
}
