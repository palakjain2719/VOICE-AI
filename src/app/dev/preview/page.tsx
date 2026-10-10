import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Card, CardHeader, Ledger, PageHeader } from "@/components/ui";
import { BarList, Guardrails, OutcomePill } from "@/components/ops";
import { DecisionButtons } from "@/components/ops-client";
import { FunnelChart } from "@/components/charts/charts";
import { TestCallConsole } from "@/app/(dash)/test-call/console";

/**
 * DEVELOPMENT-ONLY visual preview with invented DEMO figures. 404 in production builds; never
 * reads or writes the database; not Aangan data.
 */
export default function DemoPreview() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <Preview />
    </Suspense>
  );
}

async function Preview() {
  await connection();
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-[60px] max-w-[1240px] items-center gap-6 px-6">
          <span className="display text-[21px] font-semibold">Aangan</span><span className="eyebrow">Enquiry desk</span>
          <nav className="hidden gap-1 text-[14px] font-medium text-ink-3 md:flex">{["Overview", "Pipeline", "Callbacks", "Decisions", "Calls", "Knowledge", "Integrations", "Settings"].map((l, i) => <span key={l} className={i === 0 ? "relative px-3 py-2 text-ink after:absolute after:inset-x-3 after:-bottom-[13px] after:h-[2px] after:bg-accent" : "px-3 py-2"}>{l}</span>)}</nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1240px] px-6 py-8">
        <div role="note" className="mb-6 rounded-lg border border-dashed border-warn bg-warn-soft px-4 py-2 text-[13px] font-semibold text-warn-ink">DEMO — invented sample figures for visual review only. Not Aangan data.</div>
        <PageHeader eyebrow="Overview · last 30 days (DEMO)" title="How the enquiry desk is doing" description="Live calls only. Revenue figures come from HubSpot; nothing is estimated from the pricing guide." />
        <section className="mb-6 grid gap-x-8 gap-y-2 md:grid-cols-[180px_1fr]">
          <div><div className="eyebrow">In short</div><div className="mt-1 text-[12px] text-ink-3">From counted data</div></div>
          <ul className="space-y-1.5 text-[15px] leading-relaxed">
            <li>48 of 61 calls came outside staff hours — the assistant answered them. <span className="text-[13px] font-medium text-accent">see ↗</span></li>
            <li>The biggest funnel drop is booked → consultation held (40% convert). <span className="text-[13px] font-medium text-accent">see ↗</span></li>
            <li>9 items wait for a person; the oldest is 30 hours old (target under 24). <span className="text-[13px] font-medium text-accent">see ↗</span></li>
          </ul>
        </section>
        <Ledger items={[
          { label: "Calls answered", value: "58", note: "of 61 · 3 failed" },
          { label: "Answered after hours", value: "48", note: "79% of calls came when the studio was closed" },
          { label: "Qualified", value: "35", note: "29 green · 6 amber · 14 declined" },
          { label: "Consultations booked", value: "30", note: "booking rate 86% of qualified" },
          { label: "Designer handoff", value: "41 s", note: "median call end → brief in designer's inbox · 30 sent" },
          { label: "Weighted pipeline", value: "₹54.1L", note: "₹97.2L open · 35 deals" },
        ]} />
        <div className="mt-6 grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2"><CardHeader title="From call to signed project" description="Distinct leads reaching each stage · later stages come from HubSpot" /><div className="px-3 pb-3"><FunnelChart steps={[{ label: "Calls", count: 61, conversion: null }, { label: "Answered", count: 58, conversion: 0.95 }, { label: "Qualified", count: 35, conversion: 0.6 }, { label: "Booked", count: 30, conversion: 0.86 }, { label: "Consultation held", count: 12, conversion: 0.4 }, { label: "Deal open", count: 7, conversion: 0.58 }, { label: "Won", count: 2, conversion: 0.29 }]} /></div></Card>
          <Guardrails windowLabel="last 30 days (DEMO)" d={{ pricesSpoken: 0, caughtBeforeSpeaking: 1, complaints: 2, complaintAlertSeconds: 9, failedCallsOpen: 1, integrationsHealthy: 5, integrationsTotal: 6, callsOver5Min: 0, voiceToday: 13.02, voiceCap: 20 }} />
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2"><CardHeader title="Demand" description="Where enquiries come from, what they're for, and why some aren't a fit" />
            <div className="grid gap-6 px-5 pb-5 md:grid-cols-3">
              <div><h3 className="eyebrow mb-3">Areas</h3><BarList rows={[{ label: "Kothrud", n: 16 }, { label: "Baner", n: 12 }, { label: "Koregaon Park", n: 5 }, { label: "Pimple Nilakh", n: 3 }]} /></div>
              <div><h3 className="eyebrow mb-3">Not a fit because</h3><BarList tone="lavender" rows={[{ label: "Project type or size", n: 4 }, { label: "Outside Pune / PCMC", n: 3 }, { label: "Timeline too tight", n: 2 }]} /></div>
              <div><h3 className="eyebrow mb-3">Home or office</h3><BarList tone="mint" rows={[{ label: "residential", n: 44 }, { label: "commercial", n: 10 }]} /></div>
            </div>
          </Card>
          <Card><CardHeader title="Needs a person" />
            <div className="grid grid-cols-3 border-y border-line text-center">{[["Designer", 5], ["Admin", 1], ["Call back", 3]].map(([l, n]) => <div key={l} className="border-line py-3 [&:not(:last-child)]:border-r"><div className="display text-[22px]">{n}</div><div className="text-[12px] text-ink-3">{l}</div></div>)}</div>
            <ul className="divide-y divide-line">{["Clear 5 enquiries waiting over 24 hours before they go cold.", "Call back 3 qualified callers who didn't get a consultation booked."].map((t) => <li key={t} className="flex gap-2 px-4 py-2.5 text-[13.5px]"><span className="mt-1.5 size-2 shrink-0 rounded-full bg-warn" />{t}</li>)}</ul>
          </Card>
        </div>
        <h2 className="display mt-10 mb-3 text-[22px]">Decisions row (DEMO)</h2>
        <Card><div className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div><div className="flex gap-3"><span className="font-semibold">Sameer</span><span className="text-[12px] text-ink-3">Qualification review</span><span className="text-[12px] font-medium text-crit-ink">30 h waiting</span></div>
            <p className="text-[13px] text-ink-2">small coworking pod · Baner</p><p className="text-[13px]"><span className="text-ink-3">Why: </span>180 sq ft is below the 500 sq ft commercial minimum</p><p className="text-[12px] text-ink-3">asked about price</p></div>
          <div className="flex items-center gap-3"><OutcomePill status="needs_review" /><DecisionButtons id="demo" actions={["approve", "reject", "route_admin", "route_callback"]} /></div>
        </div></Card>
        <h2 className="display mt-10 mb-1 text-[22px]">Test call screen</h2>
        <p className="mb-4 text-[13px] text-ink-3">Layout preview. Starting a call needs a signed-in user, because the conversation runs on the protected server.</p>
        <TestCallConsole />
      </main>
    </div>
  );
}
