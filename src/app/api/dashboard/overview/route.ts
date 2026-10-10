import { NextResponse, type NextRequest } from "next/server";
import { handle } from "@/server/http";
import { requireRole } from "@/server/auth";
import { resolvePeriod } from "@/domain/metrics/period";
import { createDataClient } from "@/lib/supabase/server";
import { getOverview } from "@/server/dashboard";

export const GET = handle("dashboard.overview", async (req: NextRequest) => {
  await requireRole("founder", "operator");
  const period = resolvePeriod(Object.fromEntries(req.nextUrl.searchParams));
  return NextResponse.json({ period: { from: period.from, to: period.to, label: period.label }, ...(await getOverview(await createDataClient(), period)) });
});
