import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError, rateLimit, readJson } from "@/server/http";
import { requireRole } from "@/server/auth";
import { testCallTurn } from "@/server/test-call";
import { inputSummary } from "@/server/services/conversation";

const Body = z.object({ callId: z.string().regex(/^test-[0-9a-f-]{36}$/), text: z.string().trim().min(1).max(1000) });

/** One caller turn in a test call: understand → answer/collect → evaluate → decide → act. */
export const POST = handle("agent.turn", async (req: Request) => {
  const user = await requireRole("founder", "operator");
  const { callId, text } = await readJson(req, (v) => Body.parse(v));
  await rateLimit(`agent-turn:${user.id}`, 120, 3600);
  try {
    const r = await testCallTurn(callId, text);
    return NextResponse.json({ say: r.say, done: r.done, state: r.state, inputs: inputSummary(r.state) });
  } catch (e) {
    if (e instanceof Error && e.message === "Unknown test call") throw new HttpError(404, "Test call not found", "not_found");
    throw e;
  }
});
