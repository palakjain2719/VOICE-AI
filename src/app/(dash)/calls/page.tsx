import Link from "next/link";
import { Suspense } from "react";
import { PhoneCall } from "lucide-react";
import { ParamSelect, PeriodSelect } from "@/components/filters";
import { Badge, Card, dateTime, EmptyState, ErrorNote, PageHeader, PageSkeleton, QualificationBadge, Table, Td, Th } from "@/components/ui";
import { resolvePeriod } from "@/domain/metrics/period";
import { maskPhone } from "@/lib/phone";
import { createDataClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";

const TYPE_LABEL: Record<string, string> = {
  new_enquiry: "New enquiry",
  existing_project_complaint: "Complaint",
  existing_lead_follow_up: "Follow-up",
  callback_request: "Callback",
  general_question: "Question",
  unknown: "Unknown",
};

export default function CallsPage({ searchParams }: PageProps<"/calls">) {
  return (
    <>
      <PageHeader title="Call analytics" description="Operational view of individual live calls. Transcripts are visible to operators and admins only.">
        <Suspense>
          <PeriodSelect />
        </Suspense>
      </PageHeader>
      <Suspense fallback={<PageSkeleton />}>
        <Calls searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Calls({ searchParams }: { searchParams: PageProps<"/calls">["searchParams"] }) {
  await requirePageRole("operator");
  const sp = (await searchParams) as Record<string, string>;
  const period = resolvePeriod(sp);
  const db = await createDataClient();
  let q = db
    .from("calls")
    .select("id, provider_call_id, started_at, status, duration_seconds, call_type, processing_status, failure_reason, caller_phone, lead_id, leads(name, qualification_status), appointments(status, start_at)")
    .eq("production_call", true)
    .eq("is_test", false)
    .gte("started_at", period.from.toISOString())
    .lt("started_at", period.to.toISOString())
    .order("started_at", { ascending: false })
    .limit(300);
  if (sp.status) q = q.eq("status", sp.status);
  if (sp.type) q = q.eq("call_type", sp.type);
  const { data, error } = await q;
  if (error) return <ErrorNote>Calls couldn&apos;t load. Please refresh.</ErrorNote>;
  type Row = { id: string; started_at: string | null; status: string; duration_seconds: number | null; call_type: string; processing_status: string; failure_reason: string | null; caller_phone: string | null; leads: { name: string | null; qualification_status: string } | null; appointments: { status: string; start_at: string }[] };
  const rows = (data ?? []) as unknown as Row[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink-3">{period.label}</span>
        <Suspense>
          <ParamSelect name="status" label="Status" options={["completed", "failed", "missed", "disconnected", "in_progress"].map((s) => ({ value: s, label: s.replace("_", " ") }))} />
          <ParamSelect name="type" label="Type" options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        </Suspense>
      </div>
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No live calls in this period" icon={<PhoneCall className="size-6" />}>
            Calls appear here as Vaani delivers call events or the agent uses the live tools.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Caller</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th className="text-right">Duration</Th>
                <Th>Qualification</Th>
                <Th>Booking</Th>
                <Th>Processing</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const appt = c.appointments?.find((a) => a.status === "confirmed") ?? c.appointments?.[0];
                return (
                  <tr key={c.id} className="hover:bg-surface-2">
                    <Td className="whitespace-nowrap"><Link href={`/calls/${c.id}`} className="font-medium hover:text-accent">{dateTime(c.started_at)}</Link></Td>
                    <Td>{c.leads?.name ?? <span className="text-ink-3">{maskPhone(c.caller_phone)}</span>}</Td>
                    <Td>{TYPE_LABEL[c.call_type] ?? c.call_type}</Td>
                    <Td><Badge tone={c.status === "completed" ? "good" : c.status === "in_progress" ? "info" : "crit"}>{c.status.replace("_", " ")}</Badge></Td>
                    <Td className="tabular text-right">{c.duration_seconds == null ? "—" : `${Math.floor(c.duration_seconds / 60)}m ${c.duration_seconds % 60}s`}</Td>
                    <Td>{c.leads ? <QualificationBadge status={c.leads.qualification_status} /> : "—"}</Td>
                    <Td>{appt ? `${appt.status}${appt.status === "confirmed" ? ` · ${dateTime(appt.start_at)}` : ""}` : "—"}</Td>
                    <Td>{c.processing_status === "failed" ? <Badge tone="crit">failed</Badge> : c.processing_status}{c.failure_reason ? <div className="text-[12px] text-ink-3">{c.failure_reason}</div> : null}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
