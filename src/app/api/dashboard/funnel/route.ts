import { NextResponse, type NextRequest } from "next/server";
import { handle } from "@/server/http";
import { requireRole } from "@/server/auth";
import { funnelSteps } from "@/domain/metrics/insights";
import { resolvePeriod } from "@/domain/metrics/period";
import { createDataClient } from "@/lib/supabase/server";
import { getFunnel } from "@/server/dashboard";

export const GET = handle("dashboard.funnel", async (req: NextRequest) => {
  await requireRole("founder", "operator");
  const sp = req.nextUrl.searchParams;
  const period = resolvePeriod(Object.fromEntries(sp));
  const db = await createDataClient();
  const filters = { designer: sp.get("designer"), projectType: sp.get("type"), status: sp.get("status") };
  const [curr, prev] = await Promise.all([getFunnel(db, period.from, period.to, filters), getFunnel(db, period.prevFrom, period.prevTo, filters)]);
  return NextResponse.json({ period: { from: period.from, to: period.to }, counts: curr, steps: funnelSteps(curr), previous: { counts: prev, steps: funnelSteps(prev) } });
});
