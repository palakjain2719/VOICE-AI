import { NextResponse } from "next/server";
import { handle, requireCron } from "@/server/http";
import { processJobs } from "@/server/runtime";
import { store } from "@/server/store/supabase-store";

/**
 * Service keys can't subscribe to HubSpot webhooks (those belong to apps), so deal changes are
 * pulled on a schedule with a hs_lastmodifieddate cursor.
 */
export const GET = handle("cron.hubspot_sync", async (req: Request) => {
  requireCron(req);
  const bucket = new Date().toISOString().slice(0, 16);
  await store().enqueueJob("hubspot_sync_deals", {}, `hubspot-deals:${bucket}`);
  const results = await processJobs({ limit: 1, types: ["hubspot_sync_deals"] });
  return NextResponse.json({ ok: results.every((r) => r.ok), results: results.map((r) => ({ ok: r.ok })) });
});
