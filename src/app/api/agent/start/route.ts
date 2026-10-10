import { NextResponse } from "next/server";
import { handle, rateLimit } from "@/server/http";
import { requireRole } from "@/server/auth";
import { requireEnv } from "@/lib/env";
import { startTestCall } from "@/server/test-call";
import { inputSummary } from "@/server/services/conversation";

/** Starts a test call in the console (stored as a test fixture). */
export const POST = handle("agent.start", async () => {
  const user = await requireRole("founder", "operator");
  requireEnv("gemini", ["GEMINI_API_KEY", "GEMINI_MODEL"]);
  await rateLimit(`agent-start:${user.id}`, 20, 3600);
  const { callId, state } = await startTestCall();
  return NextResponse.json({ callId, say: state.turns[0].text, state, inputs: inputSummary(state) });
});
