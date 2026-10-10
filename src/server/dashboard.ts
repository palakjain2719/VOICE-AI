import "server-only";
import type { Db as SupabaseClient } from "@/lib/supabase/server";
import type { Period } from "@/domain/metrics/period";
import { buildInsights, summarise, type FunnelCounts, type InsightInput } from "@/domain/metrics/insights";
import { computePipeline, type DealRecord } from "@/domain/metrics/pipeline";
import { isConfigured, PROVIDER_ENV } from "@/lib/env";

/**
 * Dashboard reads. All queries run through the signed-in user's Supabase client, so RLS
 * decides what each role sees. Aggregation happens in Postgres (dashboard_funnel /
 * dashboard_costs) or on the server; the browser only receives results.
 */
export interface FunnelFilters {
  designer?: string | null;
  projectType?: string | null;
  status?: string | null;
}

function iso(d: Date) {
  return d.toISOString();
}

async function count(q: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> {
  const r = await q;
  if (r.error) throw new Error(r.error.message);
  return r.count ?? 0;
}

export async function getFunnel(db: SupabaseClient, from: Date, to: Date, f: FunnelFilters = {}, includeTest = false): Promise<FunnelCounts> {
  const { data, error } = await db.rpc("dashboard_funnel", {
    p_from: iso(from),
    p_to: iso(to),
    p_designer: f.designer || null,
    p_project_type: f.projectType || null,
    p_status: f.status || null,
    p_include_test: includeTest,
  });
  if (error) throw new Error(error.message);
  return data as FunnelCounts;
}

const head = { count: "exact" as const, head: true };

export async function getSafety(db: SupabaseClient, p: Period, includeTest = false) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const notTest = (q: any) => (includeTest ? q : q.eq("is_test", false));
  const policy = (kind: string) =>
    count(notTest(db.from("policy_events").select("id", head).eq("kind", kind)).gte("created_at", iso(p.from)).lt("created_at", iso(p.to)));
  const openEx = (kinds: string[]) => count(notTest(db.from("exceptions").select("id", head).in("kind", kinds).in("status", ["open", "in_review"])));
  const [deflected, detected, blocked, complaints, overdue, failedCalls, statusRows, vaaniCost] = await Promise.all([
    policy("pricing_request_deflected"),
    policy("pricing_disclosure_detected"),
    policy("pricing_disclosure_blocked"),
    openEx(["complaint"]),
    count(db.from("exceptions").select("id", head).eq("kind", "complaint").in("status", ["open", "in_review"]).lt("due_at", new Date().toISOString())),
    openEx(["failed_call"]),
    db.from("integration_status").select("*"),
    db.from("cost_events").select("cost_amount, is_estimate, currency").eq("provider", "vaani").eq("is_test", false).gte("usage_at", iso(p.from)).lt("usage_at", iso(p.to)),
  ]);
  const vaaniRows = (vaaniCost.data ?? []) as { cost_amount: number; is_estimate: boolean }[];
  return {
    pricingDeflected: deflected,
    pricingViolations: detected,
    pricingBlocked: blocked,
    openComplaints: complaints,
    overdueComplaints: overdue,
    failedCallsOpen: failedCalls,
    integrations: integrationSummary((statusRows.data ?? []) as IntegrationStatusRow[]),
    vaaniSpend: vaaniRows.reduce((s, r) => s + Number(r.cost_amount), 0),
    vaaniSpendEvents: vaaniRows.length,
  };
}

export interface IntegrationStatusRow {
  provider: string;
  configured: boolean;
  last_success_at: string | null;
  last_success_operation: string | null;
  last_error_at: string | null;
  last_error: string | null;
  last_checked_at: string | null;
  details: Record<string, unknown>;
}

export const PROVIDERS: { key: string; label: string; env: keyof typeof PROVIDER_ENV }[] = [
  { key: "vaani", label: "Vaani Labs", env: "vaani" },
  { key: "gemini", label: "Gemini", env: "gemini" },
  { key: "supabase", label: "Supabase", env: "supabase" },
  { key: "hubspot", label: "HubSpot", env: "hubspot" },
  { key: "calcom", label: "Cal.com (booking)", env: "calcom" },
  { key: "google_calendar", label: "Google Calendar (fallback)", env: "google_calendar" },
  { key: "resend", label: "Resend", env: "resend" },
];

export function integrationSummary(rows: IntegrationStatusRow[]) {
  return PROVIDERS.map((p) => {
    const r = rows.find((x) => x.provider === p.key);
    const configured = isConfigured(PROVIDER_ENV[p.env]);
    const erroring = !!(r?.last_error_at && (!r.last_success_at || r.last_error_at > r.last_success_at));
    const state: "not_configured" | "unverified" | "healthy" | "error" = !configured ? "not_configured" : erroring ? "error" : r?.last_success_at ? "healthy" : "unverified";
    return { ...p, configured, state, row: r ?? null };
  });
}

export async function getOperational(db: SupabaseClient) {
  const now = new Date().toISOString();
  const openEx = (kinds: string[]) => count(db.from("exceptions").select("id", head).in("kind", kinds).in("status", ["open", "in_review"]).eq("is_test", false));
  const [upcoming, backlog, emailFail, hubspotFail, unanswered, interventions, cursor] = await Promise.all([
    count(db.from("appointments").select("id", head).eq("status", "confirmed").gte("start_at", now).eq("is_test", false)),
    openEx(["booking_not_completed", "follow_up_required"]),
    openEx(["email_failure"]),
    openEx(["hubspot_failure"]),
    count(db.from("unanswered_questions").select("id", head).eq("status", "unresolved").eq("is_test", false)),
    count(db.from("exceptions").select("id", head).in("status", ["open", "in_review"]).in("severity", ["high", "critical"]).eq("is_test", false)),
    db.from("sync_cursors").select("last_success_at, last_error, last_error_at").eq("name", "hubspot_deals").maybeSingle(),
  ]);
  return { upcoming, backlog, emailFail, hubspotFail, unanswered, interventions, hubspotSync: cursor.data as { last_success_at: string | null; last_error: string | null; last_error_at: string | null } | null };
}

export async function getDeals(db: SupabaseClient): Promise<DealRecord[]> {
  const { data, error } = await db
    .from("hubspot_deals")
    .select("hubspot_deal_id, deal_name, amount, currency, stage_id, stage_label, stage_probability, is_closed, is_won, designer_id, hubspot_owner_id, close_date, is_aangan_voice_lead")
    .limit(5000);
  if (error) throw new Error(error.message);
  return (data ?? []).map((d) => ({ ...d, amount: d.amount == null ? null : Number(d.amount), stage_probability: d.stage_probability == null ? null : Number(d.stage_probability) })) as DealRecord[];
}

export async function getPipeline(db: SupabaseClient, p: Period) {
  return computePipeline(await getDeals(db), p);
}

export async function getCosts(db: SupabaseClient, p: Period, includeTest = false) {
  const { data, error } = await db.rpc("dashboard_costs", { p_from: iso(p.from), p_to: iso(p.to), p_include_test: includeTest });
  if (error) throw new Error(error.message);
  return (data ?? []) as { provider: string; usage_type: string; currency: string; is_estimate: boolean; cost_amount: number; units: number | null; events: number }[];
}

export async function getOverview(db: SupabaseClient, p: Period) {
  const [funnel, prevFunnel, safety, ops, pipeline, costs] = await Promise.all([
    getFunnel(db, p.from, p.to),
    getFunnel(db, p.prevFrom, p.prevTo),
    getSafety(db, p),
    getOperational(db),
    getPipeline(db, p),
    getCosts(db, p),
  ]);
  const input: InsightInput = {
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
  };
  const totalCost = costs.filter((c) => c.currency === "INR").reduce((s, c) => s + Number(c.cost_amount), 0);
  return { funnel, prevFunnel, safety, ops, pipeline, costs, totalCost, insights: buildInsights(input), summary: summarise(input, p.label) };
}

export async function listDesigners(db: SupabaseClient) {
  const { data } = await db.from("designers").select("id, name, hubspot_owner_id, active, booking_enabled, calendar_id, google_credential_id, email").order("name");
  return (data ?? []) as { id: string; name: string; hubspot_owner_id: string | null; active: boolean; booking_enabled: boolean; calendar_id: string | null; google_credential_id: string | null; email: string | null }[];
}

export async function listProjectTypes(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from("leads").select("project_type").eq("is_test", false).not("project_type", "is", null).limit(1000);
  return [...new Set((data ?? []).map((r) => r.project_type as string))].sort();
}
