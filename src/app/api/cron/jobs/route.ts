import { NextResponse } from "next/server";
import { handle, requireCron } from "@/server/http";
import { processJobs } from "@/server/runtime";

/** Vercel Cron: drains the retry queue (emails, HubSpot syncs, unprocessed webhooks). */
export const GET = handle("cron.jobs", async (req: Request) => {
  requireCron(req);
  const results = await processJobs({ limit: 25 });
  return NextResponse.json({ processed: results.length, failed: results.filter((r) => !r.ok).length });
});
