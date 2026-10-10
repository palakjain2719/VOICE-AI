import Link from "next/link";
import { Suspense } from "react";
import { Card, CardHeader, Notice, PageHeader, PageSkeleton } from "@/components/ui";
import { isConfigured, PROVIDER_ENV } from "@/lib/env";
import { safeErrorMessage } from "@/lib/log";
import { cn } from "@/lib/utils";
import { createDataClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { hubspot } from "@/server/runtime";
import { SETTINGS, loadPipelineMapping } from "@/server/settings";
import { store } from "@/server/store/supabase-store";
import { AddDesigner, DesignerRow, JsonSettingForm, PipelineMappingForm, UserRoles } from "./settings-forms";

const TABS = [["designers", "Designers"], ["hubspot", "HubSpot pipeline"], ["rules", "Qualification & booking"], ["policies", "Policies & costs"], ["users", "Users & roles"]] as const;

export default function SettingsPage({ searchParams }: PageProps<"/settings">) {
  return (
    <>
      <PageHeader title="Settings" description="Every change is versioned and recorded in the audit log." />
      <Suspense fallback={<PageSkeleton />}>
        <Settings searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Settings({ searchParams }: { searchParams: PageProps<"/settings">["searchParams"] }) {
  await requirePageRole("admin");
  const sp = (await searchParams) as Record<string, string>;
  const tab = sp.tab ?? "designers";
  const db = await createDataClient();
  const s = store();

  let body: React.ReactNode = null;
  if (tab === "designers") {
    const [{ data: designers }, { data: designerUsers }] = await Promise.all([
      db.from("designers").select("*").order("name"),
      db.from("app_users").select("id, email, roles").eq("active", true),
    ]);
    const loginOptions = (designerUsers ?? []).filter((u) => (u.roles as string[]).includes("designer")).map((u) => ({ id: u.id, label: u.email }));
    let owners: { id: string; label: string }[] = [];
    let ownerError: string | null = null;
    if (isConfigured(PROVIDER_ENV.hubspot)) {
      try {
        owners = (await hubspot().owners()).map((o) => ({ id: o.id, label: `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim() || o.email }));
      } catch (e) {
        ownerError = safeErrorMessage(e);
      }
    }
    body = (
      <Card>
        <CardHeader title="Designers" description="Each designer connects their own Google Calendar. Booking uses only designers that are active, bookable and connected." />
        {sp.google ? <div className="px-5 pb-2"><Notice tone={sp.google === "connected" ? "info" : "warn"}>Google: {sp.google === "connected" ? "calendar connected." : `connection ${sp.google}. Try again.`}</Notice></div> : null}
        {ownerError ? <div className="px-5 pb-2"><Notice tone="warn">Couldn&apos;t load HubSpot owners: {ownerError}</Notice></div> : null}
        {(designers ?? []).map((d) => <DesignerRow key={d.id} d={d} owners={owners} logins={loginOptions} />)}
        <AddDesigner />
      </Card>
    );
  } else if (tab === "hubspot") {
    let pipelines: Awaited<ReturnType<ReturnType<typeof hubspot>["pipelines"]>> = [];
    let err: string | null = null;
    if (isConfigured(PROVIDER_ENV.hubspot)) {
      try { pipelines = await hubspot().pipelines(); } catch (e) { err = safeErrorMessage(e); }
    } else err = "HUBSPOT_SERVICE_KEY is not set.";
    const current = await loadPipelineMapping(s);
    body = (
      <Card className="p-5">
        <h2 className="mb-1 font-semibold">Deal pipeline mapping</h2>
        <p className="mb-4 text-[13px] text-ink-3">Stages come from your HubSpot account. The app only moves a deal forward to “qualified” or “consultation booked”; designers move it through later stages, and won/lost are always set in HubSpot.</p>
        {err ? <Notice tone="warn">{err}</Notice> : <PipelineMappingForm pipelines={pipelines} current={current} />}
      </Card>
    );
  } else if (tab === "rules") {
    const [q, b] = await Promise.all([s.getSetting(SETTINGS.qualification.key), s.getSetting(SETTINGS.booking.key)]);
    body = (
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-2 font-semibold">Qualification rules</h2>
          <JsonSettingForm settingKey={SETTINGS.qualification.key} initial={q ?? SETTINGS.qualification.fallback} help="Thresholds for qualified.md. Values marked DERIVED in the README are operational decisions — confirm them with the founder. Each evaluation records the config hash it ran with." />
        </Card>
        <Card className="p-5">
          <h2 className="mb-2 font-semibold">Consultation booking</h2>
          <JsonSettingForm settingKey={SETTINGS.booking.key} initial={b ?? SETTINGS.booking.fallback} help="Duration, buffer, working hours (index 0 = Sunday, null = closed), holidays (YYYY-MM-DD), notice and horizon." />
        </Card>
      </div>
    );
  } else if (tab === "policies") {
    const [esc, conf, cost, voice] = await Promise.all([s.getSetting(SETTINGS.escalation.key), s.getSetting(SETTINGS.confirmation.key), s.getSetting(SETTINGS.costRates.key), s.getSetting(SETTINGS.voiceBudget.key)]);
    body = (
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="p-5"><h2 className="mb-2 font-semibold">Escalation</h2><JsonSettingForm settingKey={SETTINGS.escalation.key} initial={esc ?? SETTINGS.escalation.fallback} help="The agent promises a callback time only when complaintCallbackMinutes is set. notifyEmails receive a link (no customer details) for each complaint." /></Card>
        <Card className="p-5"><h2 className="mb-2 font-semibold">Booking confirmation</h2><JsonSettingForm settingKey={SETTINGS.confirmation.key} initial={conf ?? SETTINGS.confirmation.fallback} help="What happens when no email is collected, and the reschedule line shown in confirmation emails." /></Card>
        <Card className="p-5"><h2 className="mb-2 font-semibold">Voice spend alert</h2><JsonSettingForm settingKey={SETTINGS.voiceBudget.key} initial={voice ?? SETTINGS.voiceBudget.fallback} help="Daily Vaani spend (INR) that turns the safety card red. Vaani's API offers no documented way to stop calls, so this alerts only." /></Card>
        <Card className="p-5"><h2 className="mb-2 font-semibold">Cost rates</h2><JsonSettingForm settingKey={SETTINGS.costRates.key} initial={cost ?? SETTINGS.costRates.fallback} help="Gemini list prices (USD per million tokens) and a USD→INR rate. Leave null to skip Gemini cost estimates." /></Card>
      </div>
    );
  } else {
    const { data: users } = await db.from("app_users").select("id, email, roles, active").order("email");
    body = (
      <Card>
        <CardHeader title="Users & roles" description="Founder: dashboards. Operator: call records, transcripts and the review queue. Admin: everything, including knowledge and settings. New sign-ups have no access until a role is granted." />
        {(users ?? []).map((u) => <UserRoles key={u.id} id={u.id} email={u.email} roles={u.roles} active={u.active} />)}
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <nav aria-label="Settings sections" className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`/settings?tab=${k}`} aria-current={tab === k ? "page" : undefined} className={cn("rounded-lg px-3 py-1.5 text-[13.5px] font-medium", tab === k ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink")}>{label}</Link>
        ))}
      </nav>
      {body}
    </div>
  );
}
