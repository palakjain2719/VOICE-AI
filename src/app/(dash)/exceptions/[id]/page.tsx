import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Badge, Card, CardHeader, dateTime, PageSkeleton, SeverityBadge } from "@/components/ui";
import { createDataClient } from "@/lib/supabase/server";
import { hasRole, requirePageRole } from "@/server/auth";
import { KIND_LABEL } from "../labels";
import { ExceptionActions } from "../exception-actions";

export default function ExceptionPage({ params }: PageProps<"/exceptions/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail params={params} />
    </Suspense>
  );
}

async function Detail({ params }: { params: PageProps<"/exceptions/[id]">["params"] }) {
  const user = await requirePageRole("founder", "operator");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const db = await createDataClient();
  const { data: ex } = await db.from("exceptions").select("*").eq("id", id).maybeSingle();
  if (!ex) notFound();
  const [{ data: notes }, { data: users }, { data: lead }] = await Promise.all([
    db.from("exception_notes").select("id, body, created_at, author_id").eq("exception_id", id).order("created_at"),
    db.from("app_users").select("id, email, display_name").eq("active", true),
    ex.lead_id ? db.from("leads").select("id, name, qualification_status, hubspot_deal_id, location, project_type").eq("id", ex.lead_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const userLabel = (uid: string | null) => (users ?? []).find((u) => u.id === uid)?.display_name ?? (users ?? []).find((u) => u.id === uid)?.email ?? "—";
  const canAct = hasRole(user, "operator");

  return (
    <div className="space-y-4">
      <Link href="/exceptions" className="text-[13px] font-medium text-accent">← Review queue</Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold">{ex.title}</h1>
        <SeverityBadge severity={ex.severity} />
        <Badge>{KIND_LABEL[ex.kind] ?? ex.kind}</Badge>
        <Badge tone={ex.status === "open" ? "accent" : "neutral"}>{ex.status.replace("_", " ")}</Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Details" />
          <div className="space-y-3 px-5 pb-5 text-[14px]">
            <p className="whitespace-pre-wrap text-ink">{ex.detail ?? "No further detail."}</p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
              <dt className="text-ink-3">Raised</dt><dd>{dateTime(ex.created_at)}</dd>
              <dt className="text-ink-3">Due</dt><dd>{ex.due_at ? dateTime(ex.due_at) : "No commitment made"}</dd>
              <dt className="text-ink-3">Owner</dt><dd>{userLabel(ex.owner_id)}</dd>
              {ex.call_id ? (<><dt className="text-ink-3">Source call</dt><dd><Link className="text-accent" href={`/calls/${ex.call_id}`}>Open call record</Link></dd></>) : null}
              {lead ? (<><dt className="text-ink-3">Lead</dt><dd>{lead.name ?? "Unnamed"} · {lead.project_type ?? "—"} · {lead.location ?? "—"}{lead.hubspot_deal_id ? ` · HubSpot deal ${lead.hubspot_deal_id}` : ""}</dd></>) : null}
              {ex.unanswered_question_id ? (<><dt className="text-ink-3">Question</dt><dd><Link className="text-accent" href={`/knowledge?tab=unanswered#q-${ex.unanswered_question_id}`}>Review in knowledge base</Link></dd></>) : null}
              {ex.resolution ? (<><dt className="text-ink-3">Resolution</dt><dd>{ex.resolution} ({userLabel(ex.resolved_by)}, {dateTime(ex.resolved_at)})</dd></>) : null}
            </dl>
          </div>
        </Card>
        <Card>
          <CardHeader title="Actions" />
          <div className="px-5 pb-5">
            {canAct ? (
              <ExceptionActions id={ex.id} status={ex.status} ownerId={ex.owner_id} retryable={ex.retryable} users={(users ?? []).map((u) => ({ id: u.id, label: u.display_name ?? u.email }))} />
            ) : (
              <p className="text-[13px] text-ink-3">An operator works this queue. You can view it.</p>
            )}
          </div>
        </Card>
      </div>
      <Card>
        <CardHeader title="Notes" />
        <ul className="divide-y divide-line px-5 pb-3">
          {(notes ?? []).length === 0 ? <li className="py-3 text-[13px] text-ink-3">No notes yet.</li> : null}
          {(notes ?? []).map((n) => (
            <li key={n.id} className="py-3 text-[14px]">
              <div className="text-[12px] text-ink-3">{userLabel(n.author_id)} · {dateTime(n.created_at)}</div>
              <p className="mt-0.5 whitespace-pre-wrap">{n.body}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
