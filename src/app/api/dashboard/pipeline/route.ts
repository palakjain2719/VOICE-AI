import { NextResponse, type NextRequest } from "next/server";
import { handle } from "@/server/http";
import { requireRole } from "@/server/auth";
import { resolvePeriod } from "@/domain/metrics/period";
import { createDataClient } from "@/lib/supabase/server";
import { getOperational, getPipeline } from "@/server/dashboard";

export const GET = handle("dashboard.pipeline", async (req: NextRequest) => {
  await requireRole("founder", "operator");
  const period = resolvePeriod(Object.fromEntries(req.nextUrl.searchParams));
  const db = await createDataClient();
  const [pipeline, ops] = await Promise.all([getPipeline(db, period), getOperational(db)]);
  return NextResponse.json({ period: { from: period.from, to: period.to }, pipeline, last_hubspot_sync: ops.hubspotSync?.last_success_at ?? null });
});
