import { Suspense } from "react";
import { CheckCircle2, CircleDashed, OctagonAlert, TriangleAlert } from "lucide-react";
import { Badge, Card, CardHeader, dateTime, Notice, PageHeader, PageSkeleton, Table, Td, Th } from "@/components/ui";
import { env, PROVIDER_ENV } from "@/lib/env";
import { createDataClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { integrationSummary, type IntegrationStatusRow } from "@/server/dashboard";
import { TestButton } from "./test-button";

export default function IntegrationsPage() {
  return (
    <>
      <PageHeader title="Integrations & system health" description="Connection state, last successful operation and last error for each provider. Secret values are never shown." />
      <Suspense fallback={<PageSkeleton />}>
        <Integrations />
      </Suspense>
    </>
  );
}

const STATE = {
  healthy: { tone: "good" as const, label: "Healthy", Icon: CheckCircle2 },
  error: { tone: "crit" as const, label: "Error", Icon: OctagonAlert },
  unverified: { tone: "warn" as const, label: "Configured, not yet verified", Icon: TriangleAlert },
  not_configured: { tone: "neutral" as const, label: "Not configured", Icon: CircleDashed },
};

async function Integrations() {
  await requirePageRole("admin");
  const db = await createDataClient();
  const e = env();
  const [{ data: rows }, { data: jobs }, { data: cursor }, { data: vaaniEvents }] = await Promise.all([
    db.from("integration_status").select("*"),
    db.from("jobs").select("type, status").in("status", ["pending", "running", "failed", "dead"]).limit(1000),
    db.from("sync_cursors").select("*").eq("name", "hubspot_deals").maybeSingle(),
    db.from("integration_events").select("event_type, status, received_at, safe_error").eq("provider", "vaani").order("received_at", { ascending: false }).limit(8),
  ]);
  const summary = integrationSummary((rows ?? []) as IntegrationStatusRow[]);
  const jobCounts = (jobs ?? []).reduce<Record<string, number>>((acc, j) => ((acc[`${j.type}:${j.status}`] = (acc[`${j.type}:${j.status}`] ?? 0) + 1), acc), {});
  const tests: Record<string, { provider: string; label?: string; confirm?: string }[]> = {
    vaani: [{ provider: "vaani_session", label: "Verify API key (mints a session)", confirm: "This mints a short-lived Vaani session. Vaani holds a 100-paise reservation that is reconciled when it closes. Continue?" }],
    gemini: [{ provider: "gemini" }],
    supabase: [{ provider: "supabase" }],
    hubspot: [{ provider: "hubspot", label: "Check scopes" }, { provider: "hubspot_properties", label: "Create custom properties", confirm: "This creates the Aangan property group and custom contact/deal properties in HubSpot (skips any that exist). Continue?" }],
    google_calendar: [{ provider: "google_calendar", label: "Check designer calendars" }],
    resend: [{ provider: "resend", label: "Check sender domain" }],
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {summary.map((p) => {
          const st = STATE[p.state];
          return (
            <Card key={p.key} className="flex flex-col p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold">{p.label}</h2>
                <Badge tone={st.tone}><st.Icon aria-hidden className="size-3.5" />{st.label}</Badge>
              </div>
              <ul className="mt-3 space-y-0.5 text-[12.5px]">
                {PROVIDER_ENV[p.env].map((k) => (
                  <li key={k} className={e[k] ? "text-ink-2" : "text-crit-ink"}>{e[k] ? "✓" : "✗"} <code>{k}</code></li>
                ))}
              </ul>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]">
                <dt className="text-ink-3">Last success</dt><dd>{p.row?.last_success_at ? `${dateTime(p.row.last_success_at)} · ${p.row.last_success_operation}` : "—"}</dd>
                <dt className="text-ink-3">Last error</dt><dd className={p.state === "error" ? "text-crit-ink" : ""}>{p.row?.last_error_at ? `${dateTime(p.row.last_error_at)} · ${p.row.last_error}` : "—"}</dd>
              </dl>
              <div className="mt-4 flex flex-col gap-2">{p.configured ? tests[p.key]?.map((t) => <TestButton key={t.provider} {...t} />) : null}</div>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader title="Vaani voice agent" description="Phone calls reach the agent through the number configured in the Vaani dashboard." />
        <div className="space-y-3 px-5 pb-5 text-[13.5px]">
          <Notice tone="warn">
            Vaani&apos;s public API documents signed webhooks (<code>call.completed</code>, <code>call.failed</code>, <code>usage.charged</code>) and session minting, but does not document live tool calls from a flow to an external URL. Booking during the call needs the flow to call <code>/api/voice/tools/*</code>. Until that is confirmed in the Vaani Flow Builder, qualified callers are routed to the review queue for a human to book — the app never books after the call from a webhook.
          </Notice>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-ink-3">Webhook URL</dt><dd><code>{e.APP_BASE_URL ? `${e.APP_BASE_URL}/api/webhooks/vaani` : "set APP_BASE_URL"}</code></dd>
            <dt className="text-ink-3">Tools base URL</dt><dd><code>{e.APP_BASE_URL ? `${e.APP_BASE_URL}/api/voice/tools/<tool>` : "set APP_BASE_URL"}</code></dd>
          </dl>
          <Table>
            <thead><tr><Th>Recent event</Th><Th>Status</Th><Th>Received</Th><Th>Error</Th></tr></thead>
            <tbody>
              {(vaaniEvents ?? []).length === 0 ? <tr><Td className="text-ink-3">No webhook deliveries received yet.</Td><Td /><Td /><Td /></tr> : null}
              {(vaaniEvents ?? []).map((v, i) => (
                <tr key={i}><Td>{v.event_type}</Td><Td>{v.status}</Td><Td>{dateTime(v.received_at)}</Td><Td>{v.safe_error ?? "—"}</Td></tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Background jobs" description="Retry queue processed by Vercel Cron and right after each event" />
          <Table>
            <thead><tr><Th>Job</Th><Th>Status</Th><Th className="text-right">Count</Th></tr></thead>
            <tbody>
              {Object.keys(jobCounts).length === 0 ? <tr><Td className="text-ink-3">Queue is empty.</Td><Td /><Td /></tr> : null}
              {Object.entries(jobCounts).map(([k, n]) => {
                const [type, status] = k.split(":");
                return <tr key={k}><Td>{type}</Td><Td><Badge tone={status === "dead" ? "crit" : status === "failed" ? "warn" : "info"}>{status}</Badge></Td><Td className="tabular text-right">{n}</Td></tr>;
              })}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Scheduled HubSpot sync" description="Deal changes are pulled every 15 minutes (service keys can't receive HubSpot webhooks)" />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-5 pb-5 text-[13.5px]">
            <dt className="text-ink-3">Last success</dt><dd>{cursor?.last_success_at ? dateTime(cursor.last_success_at) : "never"}</dd>
            <dt className="text-ink-3">Cursor</dt><dd>{cursor?.cursor ? dateTime(new Date(Number(cursor.cursor)).toISOString()) : "—"}</dd>
            <dt className="text-ink-3">Last error</dt><dd>{cursor?.last_error ? `${dateTime(cursor.last_error_at)} · ${cursor.last_error}` : "—"}</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}
