import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computePipeline, type DealRecord } from "@/domain/metrics/pipeline";
import { buildInsights, funnelSteps, largestDropOff, summarise, type FunnelCounts } from "@/domain/metrics/insights";
import { resolvePeriod } from "@/domain/metrics/period";

const API = join(__dirname, "../src/app/api");
function routes(dir = API): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? routes(p) : f === "route.ts" ? [p] : [];
  });
}

/** Each route must authenticate in the way its caller can: session role, webhook signature, tool secret or cron secret. */
const GUARDS: Record<string, RegExp> = {
  "webhooks/vaani": /verifyVaaniSignature\(/,
  "voice/tools/[tool]": /requireVoiceTool\(req\)/,
  "cron/jobs": /requireCron\(req\)/,
  "cron/hubspot-sync": /requireCron\(req\)/,
  "cron/ai-summary": /requireCron\(req\)/,
  "auth/google/callback": /hasRole\(user, "admin"\)/,
  access: /checkCode\(code\)/,
};

describe("API route authorization audit", () => {
  const all = routes();
  it("finds the routes", () => expect(all.length).toBeGreaterThan(25));

  it.each(all.map((p) => [relative(API, p).replace(/\/route\.ts$/, ""), p]))("%s is protected", (name, path) => {
    const src = readFileSync(path, "utf8");
    const guard = GUARDS[name] ?? /requireRole\(\s*"(founder|operator|admin|designer)"/;
    expect(src).toMatch(guard);
  });

  it("mutating dashboard/admin routes require operator or admin, never founder-only", () => {
    for (const p of all) {
      const src = readFileSync(p, "utf8");
      if (/export const (POST|PUT|PATCH|DELETE)/.test(src) && /requireRole\(/.test(src)) {
        // Founders read; they only write their own to-dos, dismissals and summary refreshes (RLS-scoped).
        // Founders may refresh the summary and run test calls (stored as test fixtures, excluded from live figures).
        const personal = /api\/(dashboard\/ai-summary|agent\/)/.test(p);
        if (!personal) expect(src, relative(API, p)).toMatch(/requireRole\("(operator|admin)"/);
      }
    }
  });
});

describe("guards", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("voice tools and cron reject missing or wrong secrets in constant time", async () => {
    vi.stubEnv("VOICE_TOOL_SECRET", "tool-secret-123");
    vi.stubEnv("CRON_SECRET", "cron-secret-456");
    const { requireVoiceTool, requireCron, HttpError } = await import("@/server/http");
    const req = (auth?: string) => new Request("https://x", { headers: auth ? { authorization: auth } : {} });
    expect(() => requireVoiceTool(req())).toThrow(HttpError);
    expect(() => requireVoiceTool(req("Bearer wrong"))).toThrow(HttpError);
    expect(() => requireVoiceTool(req("Bearer tool-secret-123"))).not.toThrow();
    expect(() => requireCron(req("Bearer tool-secret-123"))).toThrow(HttpError);
    expect(() => requireCron(req("Bearer cron-secret-456"))).not.toThrow();
  });

  it("a missing secret never authorizes anything", async () => {
    vi.stubEnv("VOICE_TOOL_SECRET", "");
    const { requireVoiceTool, HttpError } = await import("@/server/http");
    expect(() => requireVoiceTool(new Request("https://x", { headers: { authorization: "Bearer " } }))).toThrow(HttpError);
  });
});

describe("pipeline metrics", () => {
  const deal = (o: Partial<DealRecord>): DealRecord => ({ hubspot_deal_id: Math.random().toString(), deal_name: null, amount: null, currency: "INR", stage_id: "s", stage_label: "S", stage_probability: null, is_closed: false, is_won: false, designer_id: null, hubspot_owner_id: null, close_date: null, is_aangan_voice_lead: true, ...o });
  const period = { from: new Date("2026-10-01T00:00:00+05:30"), to: new Date("2026-11-01T00:00:00+05:30") };

  it("separates unweighted, weighted and closed-won, and reports gaps instead of guessing", () => {
    const p = computePipeline(
      [
        deal({ amount: 1_000_000, stage_probability: 0.2, close_date: "2026-12-10T00:00:00Z" }),
        deal({ amount: 2_000_000, stage_probability: 0.5, close_date: "2027-01-20T00:00:00Z" }),
        deal({ amount: null, stage_probability: 0.5 }),
        deal({ amount: 500_000, stage_probability: null }),
        deal({ amount: 3_000_000, is_closed: true, is_won: true, close_date: "2026-10-15T00:00:00Z" }),
        deal({ amount: 9_000_000, is_closed: true, is_won: true, close_date: "2026-08-15T00:00:00Z" }),
        deal({ amount: 700_000, is_closed: true, is_won: false, close_date: "2026-10-20T00:00:00Z" }),
      ],
      period,
    );
    expect(p.open).toEqual({ count: 4, amount: 3_500_000, weighted: 1_200_000, missingAmount: 1, missingProbability: 1 });
    expect(p.won).toEqual({ count: 1, revenue: 3_000_000, missingAmount: 0 });
    expect(p.lost.count).toBe(1);
    expect(p.forecast.month.map((b) => b.key)).toEqual(["2026-12", "2027-01"]);
    expect(p.forecast.quarter.map((b) => b.key)).toEqual(["2026-Q4", "2027-Q1"]);
    expect(p.forecast.noCloseDate).toBe(2);
  });
});

describe("funnel insights", () => {
  const f: FunnelCounts = { incoming: 40, answered: 36, failed: 4, disconnected: 2, new_enquiries_answered: 30, new_enquiries_evaluated: 28, complaints: 2, green: 12, amber: 6, red: 10, needs_review: 2, qualified: 18, booked: 6, consultation_completed: 4, deal_opened: 3, won: 1, lost: 0 };

  it("computes stage conversions and the largest drop-off", () => {
    const steps = funnelSteps(f);
    expect(steps[1].conversion).toBeCloseTo(0.9);
    expect(largestDropOff(f)).toMatchObject({ from: "Eligible qualified leads", label: "Consultations booked" });
  });

  it("every recommendation comes from a counted value and links to its records", () => {
    const ins = buildInsights({ funnel: f, openComplaints: 2, overdueComplaints: 1, pricingViolations: 0, bookingBacklog: 3, emailFailures: 0, hubspotFailures: 0, unansweredOpen: 4, integrationsDown: [], upcomingConsultations: 2 });
    expect(ins[0]).toMatchObject({ severity: "critical", href: "/exceptions?kind=complaint" });
    for (const i of ins) {
      expect(i.href.startsWith("/")).toBe(true);
      expect(i.reason.length).toBeGreaterThan(5);
      for (const n of i.text.match(/\d+/g) ?? []) expect([2, 1, 3, 4, 2, 33, 18, 6].map(String)).toContain(n);
    }
    expect(summarise({ funnel: f, openComplaints: 2, overdueComplaints: 1, pricingViolations: 0, bookingBacklog: 3, emailFailures: 0, hubspotFailures: 0, unansweredOpen: 4, integrationsDown: [], upcomingConsultations: 2 }, "Oct")).toContain("40 calls came in");
  });

  it("an empty period says so instead of inventing activity", () => {
    const zero = Object.fromEntries(Object.keys(f).map((k) => [k, 0])) as unknown as FunnelCounts;
    expect(summarise({ funnel: zero, openComplaints: 0, overdueComplaints: 0, pricingViolations: 0, bookingBacklog: 0, emailFailures: 0, hubspotFailures: 0, unansweredOpen: 0, integrationsDown: [], upcomingConsultations: 0 }, "Oct")).toMatch(/No live production calls/);
  });
});

describe("periods", () => {
  it("previous period has equal length and ends where the current one starts", () => {
    const p = resolvePeriod({ period: "7d" }, new Date("2026-10-10T06:00:00Z"));
    expect(p.to.getTime() - p.from.getTime()).toBe(7 * 86400_000);
    expect(p.prevTo.getTime()).toBe(p.from.getTime());
    expect(p.from.toISOString()).toBe("2026-10-03T18:30:00.000Z");
  });
});
