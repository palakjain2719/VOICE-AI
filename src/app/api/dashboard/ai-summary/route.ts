import { NextResponse } from "next/server";
import { handle, rateLimit } from "@/server/http";
import { requireRole } from "@/server/auth";
import { refreshAiSummary } from "@/server/ai-summary";

/** Regenerates the AI summary now (it also refreshes nightly by cron). */
export const POST = handle("ai_summary.refresh", async () => {
  const user = await requireRole("founder", "operator");
  await rateLimit(`ai-summary:${user.id}`, 6, 3600);
  return NextResponse.json(await refreshAiSummary());
});
