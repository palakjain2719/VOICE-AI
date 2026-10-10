import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Badge, Card, CardHeader, dateTime, PageSkeleton, QualificationBadge, Table, Td, Th } from "@/components/ui";
import { maskPhone } from "@/lib/phone";
import { createDataClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";

export default function CallPage({ params }: PageProps<"/calls/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <CallDetail params={params} />
    </Suspense>
  );
}

async function CallDetail({ params }: { params: PageProps<"/calls/[id]">["params"] }) {
  await requirePageRole("operator");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const db = await createDataClient();
  const { data: call } = await db.from("calls").select("*").eq("id", id).maybeSingle();
  if (!call) notFound();
  const [{ data: transcript }, { data: quals }, { data: lead }, { data: appts }] = await Promise.all([
    db.from("call_transcripts").select("transcript, turns").eq("call_id", id).maybeSingle(),
    db.from("call_qualifications").select("status, criteria, uncertainties, rules_version, config_hash, evaluated_by, created_at").eq("call_id", id).order("created_at", { ascending: false }),
    call.lead_id ? db.from("leads").select("*").eq("id", call.lead_id).maybeSingle() : Promise.resolve({ data: null }),
    call.lead_id ? db.from("appointments").select("id, status, start_at, confirmation_email_status, provider_event_id").eq("lead_id", call.lead_id).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
  ]);
  const q = quals?.[0];
  const turns = (transcript?.turns as { role: string; text: string }[] | null) ?? null;

  return (
    <div className="space-y-4">
      <Link href="/calls" className="text-[13px] font-medium text-accent">← Calls</Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold">Call · {dateTime(call.started_at)}</h1>
        <Badge>{call.call_type.replace(/_/g, " ")}</Badge>
        <Badge tone={call.status === "completed" ? "good" : "crit"}>{call.status}</Badge>
        {lead ? <QualificationBadge status={lead.qualification_status} /> : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Call" />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-5 pb-5 text-[13.5px]">
            <dt className="text-ink-3">Caller</dt><dd>{maskPhone(call.caller_phone_normalized ?? call.caller_phone)}</dd>
            <dt className="text-ink-3">Duration</dt><dd>{call.duration_seconds == null ? "—" : `${call.duration_seconds}s`}</dd>
            <dt className="text-ink-3">Provider id</dt><dd className="truncate font-mono text-[12px]">{call.provider_call_id}</dd>
            <dt className="text-ink-3">Processing</dt><dd>{call.processing_status}</dd>
            {call.failure_reason ? (<><dt className="text-ink-3">Failure</dt><dd>{call.failure_reason}</dd></>) : null}
            {call.related_call_id ? (<><dt className="text-ink-3">Reconnect of</dt><dd><Link className="text-accent" href={`/calls/${call.related_call_id}`}>earlier call</Link></dd></>) : null}
          </dl>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Summary" />
          <p className="px-5 pb-5 text-[14px] whitespace-pre-wrap">{call.summary ?? "No summary yet."}</p>
        </Card>
      </div>
      {lead ? (
        <Card>
          <CardHeader title="Lead" description={lead.hubspot_deal_id ? `HubSpot deal ${lead.hubspot_deal_id} · sync ${lead.hubspot_sync_status}` : `HubSpot sync: ${lead.hubspot_sync_status}`} />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 px-5 pb-5 text-[13.5px] md:grid-cols-4">
            {[
              ["Name", lead.name], ["Email", lead.email ? "on file" : "not collected"], ["Location", lead.location], ["Zone", lead.service_zone],
              ["Project", lead.project_type], ["Scope", lead.project_scope], ["Area", lead.property_area_sqft ? `${lead.property_area_sqft} sq ft` : null], ["Timeline", lead.timeline],
              ["Decision-maker", lead.decision_maker_status?.replace(/_/g, " ")], ["Rented", lead.is_rented == null ? null : lead.is_rented ? "yes" : "no"], ["Budget volunteered", lead.budget_volunteered ? lead.budget_notes ?? "yes" : "no"],
            ].map(([k, v]) => (
              <div key={k as string}><dt className="text-ink-3">{k}</dt><dd>{(v as string) ?? "—"}</dd></div>
            ))}
          </dl>
        </Card>
      ) : null}
      {q ? (
        <Card>
          <CardHeader title="Qualification" description={`Rules ${q.rules_version} · config ${q.config_hash} · ${q.evaluated_by} · ${dateTime(q.created_at)}`} />
          <Table>
            <thead><tr><Th>Criterion</Th><Th>Result</Th><Th>Reason</Th></tr></thead>
            <tbody>
              {Object.entries(q.criteria as Record<string, { result: string; detail: string }>).map(([k, c]) => (
                <tr key={k}>
                  <Td className="capitalize">{k.replace(/_/g, " ")}</Td>
                  <Td><Badge tone={c.result === "pass" ? "good" : c.result === "fail" ? "crit" : "warn"}>{c.result}</Badge></Td>
                  <Td>{c.detail}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
      {appts && appts.length ? (
        <Card>
          <CardHeader title="Consultations" />
          <Table>
            <thead><tr><Th>When</Th><Th>Status</Th><Th>Email</Th><Th>Calendar event</Th></tr></thead>
            <tbody>
              {appts.map((a) => (
                <tr key={a.id}><Td>{dateTime(a.start_at)}</Td><Td>{a.status}</Td><Td>{a.confirmation_email_status.replace("_", " ")}</Td><Td className="font-mono text-[12px]">{a.provider_event_id ?? "—"}</Td></tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
      <Card>
        <CardHeader title="Transcript" description="As delivered by the voice provider" />
        <div className="max-h-[520px] overflow-y-auto px-5 pb-5 text-[14px]">
          {turns ? (
            <ol className="space-y-2">
              {turns.map((t, i) => (
                <li key={i} className={t.role === "agent" ? "text-ink-2" : "text-ink"}>
                  <span className="mr-2 text-[12px] font-semibold tracking-wide uppercase text-ink-3">{t.role === "agent" ? "Agent" : t.role === "caller" ? "Caller" : "Speaker"}</span>
                  {t.text}
                </li>
              ))}
            </ol>
          ) : transcript?.transcript ? (
            <pre className="font-sans whitespace-pre-wrap">{transcript.transcript}</pre>
          ) : (
            <p className="text-ink-3">No transcript was provided for this call.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
