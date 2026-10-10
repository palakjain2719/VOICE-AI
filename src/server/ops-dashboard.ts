import "server-only";
import type { Db } from "@/lib/supabase/server";
import { TZ, type Period } from "@/domain/metrics/period";
import { getFunnel, getOperational, getSafety } from "./dashboard";
import { buildInsights } from "@/domain/metrics/insights";
import { summaryBullets } from "@/domain/metrics/summary";
import type { GuardrailData } from "@/components/ops";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { DEFAULT_BOOKING_CONFIG, BookingConfigSchema } from "@/domain/booking/slots";
import { VoiceBudgetSchema } from "@/server/settings";

/** Reads for Today, KPIs, front desk, designer, leads and messages. RLS applies (user-scoped client). */

const iso = (d: Date) => d.toISOString();

export interface Kpis {
  calls: number;
  after_hours: number;
  avg_duration_seconds: number | null;
  over_5_min: number;
  handoff_median_seconds: number | null;
  handoffs: number;
  backlog: Record<string, { count: number; oldest_hours: number }>;
  complaint_alert_median_seconds: number | null;
  complaints: number;
  consultations_due: number;
  consultations_completed: number;
  won: number;
  reviews_created: number;
  reviews_decided: number;
}

async function setting<T>(db: Db, key: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, fallback: T): Promise<T> {
  const { data } = await db.from("app_settings").select("value").eq("key", key).maybeSingle();
  const parsed = data ? schema.safeParse(data.value) : null;
  return parsed?.success ? (parsed.data as T) : fallback;
}

export async function getKpis(db: Db, p: Period, includeTest = false): Promise<Kpis> {
  const booking = await setting(db, "booking_config", BookingConfigSchema, DEFAULT_BOOKING_CONFIG);
  const open = booking.workingHours.map((h, dow) => (h ? dow : -1)).filter((d) => d >= 0);
  const monday = booking.workingHours.find((h) => h) ?? { start: "10:00", end: "19:00" };
  const toMin = (t: string) => Number(t.split(":")[0]) * 60 + Number(t.split(":")[1] ?? 0);
  const { data, error } = await db.rpc("dashboard_kpis", {
    p_from: iso(p.from), p_to: iso(p.to), p_tz: booking.timezone, p_open_minute: toMin(monday.start), p_close_minute: toMin(monday.end), p_open_dows: open, p_include_test: includeTest,
  });
  if (error) throw new Error(error.message);
  return data as Kpis;
}

export interface DemandRow { label: string; n: number }
export async function getDemand(db: Db, p: Period, includeTest = false): Promise<{ localities: DemandRow[]; declines: DemandRow[]; project_mix: DemandRow[] }> {
  const { data, error } = await db.rpc("dashboard_demand", { p_from: iso(p.from), p_to: iso(p.to), p_include_test: includeTest });
  if (error) throw new Error(error.message);
  return data;
}

export async function getVoiceSpend(db: Db) {
  const budget = await setting(db, "voice_budget", VoiceBudgetSchema, { dailyCapInr: null });
  const start = fromZonedTime(`${formatInTimeZone(new Date(), TZ, "yyyy-MM-dd")}T00:00:00`, TZ); // today, IST
  const { data } = await db.from("cost_events").select("cost_amount").eq("provider", "vaani").eq("is_test", false).gte("usage_at", iso(start));
  return { today: (data ?? []).reduce((s, r) => s + Number(r.cost_amount), 0), dailyCap: budget.dailyCapInr };
}

export async function getRecentCalls(db: Db, limit = 8, includeTest = false) {
  let q = db.from("calls").select("id, started_at, duration_seconds, status, call_type, is_test, leads!calls_lead_fk(name, qualification_status)");
  if (!includeTest) q = q.eq("production_call", true).eq("is_test", false);
  const { data } = await q.order("started_at", { ascending: false }).limit(limit);
  return (data ?? []) as unknown as { id: string; started_at: string | null; duration_seconds: number | null; status: string; call_type: string; is_test?: boolean; leads: { name: string | null; qualification_status: string } | null }[];
}

export async function getPipelineHeadline(db: Db, p: Period) {
  const { data } = await db.from("hubspot_deals").select("amount, stage_probability, is_closed, is_won, created_in_hubspot_at, close_date").limit(5000);
  const rows = (data ?? []).map((d) => ({ ...d, amount: d.amount == null ? null : Number(d.amount), prob: d.stage_probability == null ? null : Number(d.stage_probability) }));
  const open = rows.filter((r) => !r.is_closed);
  const inP = (t: string | null) => !!t && Date.parse(t) >= p.from.getTime() && Date.parse(t) < p.to.getTime();
  return {
    weighted: open.reduce((s, r) => s + (r.amount != null && r.prob != null ? r.amount * r.prob : 0), 0),
    unweighted: open.reduce((s, r) => s + (r.amount ?? 0), 0),
    openCount: open.length,
    missingAmount: open.filter((r) => r.amount == null).length,
    addedInPeriod: rows.filter((r) => inP(r.created_in_hubspot_at)).reduce((s, r) => s + (r.amount ?? 0), 0),
    wonInPeriod: rows.filter((r) => r.is_won && inP(r.close_date)).reduce((s, r) => s + (r.amount ?? 0), 0),
  };
}

export async function getBacklog(db: Db, includeTest = false) {
  let q = db.from("exceptions").select("lane, created_at").in("status", ["open", "in_review"]).in("lane", ["designer", "admin", "callback"]);
  if (!includeTest) q = q.eq("is_test", false);
  const { data } = await q;
  const rows = data ?? [];
  const oldest = rows.reduce((m, r) => Math.min(m, Date.parse(r.created_at)), Date.now());
  return {
    total: rows.length,
    byLane: { designer: rows.filter((r) => r.lane === "designer").length, admin: rows.filter((r) => r.lane === "admin").length, callback: rows.filter((r) => r.lane === "callback").length },
    oldestHours: rows.length ? Math.round((Date.now() - oldest) / 3600_000) : 0,
    over24h: rows.filter((r) => Date.now() - Date.parse(r.created_at) > 24 * 3600_000).length,
  };
}

export async function getOpenMessagesCount(db: Db, designerId?: string) {
  let q = db.from("team_messages").select("id", { count: "exact", head: true }).eq("status", "open").eq("is_test", false);
  if (designerId) q = q.eq("for_designer_id", designerId);
  const { count } = await q;
  return count ?? 0;
}

export async function getUpcomingConsultations(db: Db, opts: { designerId?: string; from?: Date; to?: Date; limit?: number } = {}) {
  let q = db
    .from("appointments")
    .select("id, start_at, meeting_type, status, designer_id, designers(name), leads(id, name, locality, location, project_type)")
    .eq("status", "confirmed").eq("is_test", false)
    .gte("start_at", iso(opts.from ?? new Date()))
    .order("start_at").limit(opts.limit ?? 30);
  if (opts.to) q = q.lt("start_at", iso(opts.to));
  if (opts.designerId) q = q.eq("designer_id", opts.designerId);
  const { data } = await q;
  return (data ?? []) as unknown as { id: string; start_at: string; meeting_type: string; designers: { name: string } | null; leads: { id: string; name: string | null; locality: string | null; location: string | null; project_type: string | null } | null }[];
}


export async function getGuardrails(db: Db, p: Period, includeTest = false): Promise<GuardrailData> {
  const [s, k, v] = await Promise.all([getSafety(db, p, includeTest), getKpis(db, p, includeTest), getVoiceSpend(db)]);
  return {
    pricesSpoken: s.pricingViolations,
    caughtBeforeSpeaking: s.pricingBlocked,
    complaints: k.complaints,
    complaintAlertSeconds: k.complaint_alert_median_seconds,
    failedCallsOpen: s.failedCallsOpen,
    integrationsHealthy: s.integrations.filter((i) => i.state === "healthy").length,
    integrationsTotal: s.integrations.length,
    callsOver5Min: k.over_5_min,
    voiceToday: v.today,
    voiceCap: v.dailyCap,
  };
}

/** Everything the overview needs for one period, aggregated server-side. */
export async function getOverviewData(db: Db, p: Period, includeTest = false) {
  const [guardrails, safety, funnel, kpis, pipeline, demand, backlog, ops, openMessages, recent] = await Promise.all([
    getGuardrails(db, p, includeTest),
    getSafety(db, p, includeTest),
    getFunnel(db, p.from, p.to, {}, includeTest),
    getKpis(db, p, includeTest),
    getPipelineHeadline(db, p),
    getDemand(db, p, includeTest),
    getBacklog(db, includeTest),
    getOperational(db),
    getOpenMessagesCount(db),
    getRecentCalls(db, 6, includeTest),
  ]);
  const attention = buildInsights({
    funnel,
    openComplaints: safety.openComplaints,
    overdueComplaints: safety.overdueComplaints,
    pricingViolations: safety.pricingViolations,
    bookingBacklog: ops.backlog,
    emailFailures: ops.emailFail,
    hubspotFailures: ops.hubspotFail,
    unansweredOpen: ops.unanswered,
    integrationsDown: safety.integrations.filter((i) => i.state === "error").map((i) => i.label),
    upcomingConsultations: ops.upcoming,
    reviewOver24h: backlog.over24h,
    reviewTotal: backlog.total,
    openMessages,
  });
  const bullets = summaryBullets({
    periodLabel: p.label, funnel, afterHours: kpis.after_hours, calls: kpis.calls, pipeline,
    topDecline: demand.declines[0] ? { label: demand.declines[0].label, n: demand.declines[0].n } : null,
    backlog: backlog.total, oldestHours: backlog.oldestHours,
  });
  return { guardrails, funnel, kpis, pipeline, demand, backlog, ops, attention, bullets, recent };
}
