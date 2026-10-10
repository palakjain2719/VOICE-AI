import Link from "next/link";
import { Suspense } from "react";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { Phone } from "lucide-react";
import { Badge, Card, CardHeader, dateTime, EmptyState, PageHeader, PageSkeleton } from "@/components/ui";
import { fmtDuration } from "@/components/ops";
import { DecisionButtons, MessageDone } from "@/components/ops-client";
import { createDataClient } from "@/lib/supabase/server";
import { requestNow } from "@/lib/time";
import { requirePageRole } from "@/server/auth";
import { getUpcomingConsultations } from "@/server/ops-dashboard";

export default function CallbacksPage() {
  return (
    <>
      <PageHeader eyebrow="Front desk" title="Callbacks" description="One list of people to call, most urgent first. Call in their free window; never promise a time you can't keep." />
      <Suspense fallback={<PageSkeleton />}>
        <Desk />
      </Suspense>
    </>
  );
}

type Item = {
  key: string;
  kind: "complaint" | "callback" | "message";
  who: string;
  phone: string | null;
  what: string;
  when: string | null;
  createdAt: string;
  exceptionId?: string;
  messageId?: string;
  hasLead?: boolean;
  alertSeconds?: number | null;
};

const KIND = {
  complaint: { label: "Complaint", tone: "crit" as const },
  callback: { label: "Call back", tone: "accent" as const },
  message: { label: "Message", tone: "info" as const },
};

async function Desk() {
  await requirePageRole("operator");
  const db = await createDataClient();
  const now = requestNow();
  const dayStart = fromZonedTime(`${formatInTimeZone(new Date(now), "Asia/Kolkata", "yyyy-MM-dd")}T00:00:00`, "Asia/Kolkata");
  const [callbacks, complaints, messages, consults] = await Promise.all([
    db.from("exceptions").select("id, kind, title, detail, created_at, leads(name, phone_normalized, location, project_scope, timeline)").eq("lane", "callback").in("status", ["open", "in_review"]).eq("is_test", false).limit(60),
    db.from("exceptions").select("id, title, detail, created_at, notified_at, calls(caller_phone_normalized, intake)").eq("kind", "complaint").in("status", ["open", "in_review"]).eq("is_test", false).limit(30),
    db.from("team_messages").select("id, caller_name, caller_phone, message_type, for_name, about, callback_window, created_at, designers(name)").eq("status", "open").eq("is_test", false).limit(60),
    getUpcomingConsultations(db, { from: dayStart, to: new Date(dayStart.getTime() + 2 * 86400_000), limit: 40 }),
  ]);

  type CB = { id: string; kind: string; title: string; detail: string | null; created_at: string; leads: { name: string | null; phone_normalized: string | null; location: string | null; project_scope: string | null; timeline: string | null } | null };
  type CP = { id: string; title: string; detail: string | null; created_at: string; notified_at: string | null; calls: { caller_phone_normalized: string | null; intake: { escalation?: { name?: string; callback_phone?: string } } | null } | null };
  type MS = { id: string; caller_name: string | null; caller_phone: string | null; message_type: string; for_name: string | null; about: string; callback_window: string | null; created_at: string; designers: { name: string } | null };

  const items: Item[] = [
    ...((complaints.data ?? []) as unknown as CP[]).map((c) => ({
      key: `c-${c.id}`, kind: "complaint" as const, exceptionId: c.id,
      who: c.calls?.intake?.escalation?.name ?? c.title.replace(/^Complaint:\s*/, ""),
      phone: c.calls?.intake?.escalation?.callback_phone ?? c.calls?.caller_phone_normalized ?? null,
      what: c.detail ?? "Existing client complaint", when: null, createdAt: c.created_at,
      alertSeconds: c.notified_at ? (Date.parse(c.notified_at) - Date.parse(c.created_at)) / 1000 : null,
    })),
    ...((callbacks.data ?? []) as unknown as CB[]).map((c) => ({
      key: `b-${c.id}`, kind: "callback" as const, exceptionId: c.id, hasLead: !!c.leads,
      who: c.leads?.name ?? c.title, phone: c.leads?.phone_normalized ?? null,
      what: [c.leads?.project_scope, c.leads?.location].filter(Boolean).join(" · ") || c.detail || c.title,
      when: c.leads?.timeline ?? null, createdAt: c.created_at,
    })),
    ...((messages.data ?? []) as unknown as MS[]).map((m) => ({
      key: `m-${m.id}`, kind: "message" as const, messageId: m.id,
      who: `${m.caller_name ?? "Caller"}${m.designers?.name || m.for_name ? ` → ${m.designers?.name ?? m.for_name}` : ""}`,
      phone: m.caller_phone, what: m.about, when: m.callback_window, createdAt: m.created_at,
    })),
  ];
  const order = { complaint: 0, callback: 1, message: 2 };
  items.sort((a, b) => order[a.kind] - order[b.kind] || a.createdAt.localeCompare(b.createdAt));
  const counts = { complaint: items.filter((i) => i.kind === "complaint").length, callback: items.filter((i) => i.kind === "callback").length, message: items.filter((i) => i.kind === "message").length };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <Card>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-line px-5 py-4">
          <div className="display tabular text-[30px] leading-none">{items.length}</div>
          <div className="text-[13px] text-ink-3">{counts.complaint} complaints · {counts.callback} call-backs · {counts.message} messages</div>
        </div>
        {items.length === 0 ? <EmptyState title="Nobody to call back" icon={<Phone className="size-6" />}>Complaints, unfinished enquiries and messages for the team show up here.</EmptyState> : (
          <ol className="divide-y divide-line">
            {items.map((it) => {
              const ageH = Math.round((now - Date.parse(it.createdAt)) / 3600_000);
              return (
                <li key={it.key} className="grid gap-3 px-5 py-4 md:grid-cols-[110px_1fr]">
                  <div className="space-y-1">
                    <Badge tone={KIND[it.kind].tone}>{KIND[it.kind].label}</Badge>
                    <div className={ageH > 24 ? "text-[12px] font-medium text-crit-ink" : "text-[12px] text-ink-3"}>waiting {ageH} h</div>
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      {it.exceptionId ? <Link href={`/exceptions/${it.exceptionId}`} className="font-semibold text-ink hover:text-accent">{it.who}</Link> : <span className="font-semibold">{it.who}</span>}
                      {it.phone ? <a href={`tel:${it.phone}`} className="tabular text-[13px] text-accent hover:underline">{it.phone}</a> : <span className="text-[12.5px] text-ink-3">no number captured</span>}
                    </div>
                    <p className="mt-0.5 text-[13.5px] text-ink-2">{it.what}</p>
                    <p className="text-[12px] text-ink-3">
                      {it.when ? `Free: ${it.when}` : null}
                      {it.kind === "complaint" ? (it.alertSeconds != null ? ` Seniors were alerted ${fmtDuration(it.alertSeconds)} after the call.` : " No alert recorded — tell a senior now.") : null}
                    </p>
                    <div className="mt-2">
                      {it.kind === "callback" && it.hasLead && it.exceptionId ? <DecisionButtons id={it.exceptionId} actions={["approve", "reject", "route_designer", "route_admin"]} /> : null}
                      {it.kind === "message" && it.messageId ? <MessageDone id={it.messageId} /> : null}
                      {it.kind === "complaint" && it.exceptionId ? <Link href={`/exceptions/${it.exceptionId}`} className="text-[12.5px] font-medium text-accent">Record what happened →</Link> : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <Card className="self-start">
        <CardHeader title="Today & tomorrow" description="Consultations, for walk-ins and reschedule calls" />
        {consults.length === 0 ? <p className="px-5 pb-5 text-[13px] text-ink-3">No consultations booked.</p> : (
          <ol className="relative mx-5 mb-5 border-l border-line">
            {consults.map((a) => (
              <li key={a.id} className="relative pb-4 pl-4 last:pb-0">
                <span aria-hidden className="absolute top-1.5 -left-[4.5px] size-2 rounded-full bg-accent" />
                <div className="tabular text-[12px] text-ink-3">{dateTime(a.start_at)}</div>
                <div className="text-[13.5px] font-medium">{a.leads?.name ?? "Client"} <span className="font-normal text-ink-3">with {a.designers?.name ?? "designer"}</span></div>
                <div className="text-[12.5px] text-ink-3">{a.meeting_type.replace("_", " ")}{a.leads?.location ? ` · ${a.leads.location}` : ""}</div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
