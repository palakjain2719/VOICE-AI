import { NextResponse } from "next/server";
import { handle } from "@/server/http";
import { requireRole } from "@/server/auth";
import { createDataClient } from "@/lib/supabase/server";
import { integrationSummary, type IntegrationStatusRow } from "@/server/dashboard";

export const GET = handle("integrations.health", async () => {
  await requireRole("admin");
  const db = await createDataClient();
  const { data } = await db.from("integration_status").select("*");
  return NextResponse.json(integrationSummary((data ?? []) as IntegrationStatusRow[]).map(({ row, ...r }) => ({ ...r, last_success_at: row?.last_success_at ?? null, last_error_at: row?.last_error_at ?? null, last_error: row?.last_error ?? null })));
});
