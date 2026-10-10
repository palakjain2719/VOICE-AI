import { NextResponse } from "next/server";
import { handle, requireCron } from "@/server/http";
import { refreshAiSummary } from "@/server/ai-summary";

/** Nightly at 22:00 IST (16:30 UTC). */
export const GET = handle("cron.ai_summary", async (req: Request) => {
  requireCron(req);
  const r = await refreshAiSummary();
  return NextResponse.json({ ok: true, bullets: r.bullets.length, by: r.generated_by });
});
