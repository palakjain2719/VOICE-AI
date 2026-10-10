import { NextResponse, type NextRequest } from "next/server";
import { handle, HttpError, rateLimit, readJson, requireVoiceTool } from "@/server/http";
import { liveDeps } from "@/server/runtime";
import { VOICE_TOOLS, type VoiceToolName } from "@/server/services/voice-tool-schemas";
import {
  answerLive,
  availabilityLive,
  bookLive,
  BookingRefused,
  escalateLive,
  evaluateLive,
  logUnansweredLive,
  saveIntake,
  takeMessageLive,
} from "@/server/services/live-call";

/**
 * Live tools for the voice agent, called during the conversation.
 * Auth: `Authorization: Bearer $VOICE_TOOL_SECRET`. Each body is validated against its schema.
 */
export const POST = handle("voice.tool", async (req: NextRequest, ctx: RouteContext<"/api/voice/tools/[tool]">) => {
  requireVoiceTool(req);
  const { tool } = await ctx.params;
  if (!(tool in VOICE_TOOLS)) throw new HttpError(404, "Unknown tool", "unknown_tool");
  const name = tool as VoiceToolName;
  const input = await readJson(req, (v) => VOICE_TOOLS[name].parse(v));
  await rateLimit(`voice-tool:${input.call_id}`, 120);
  // Smoke tests send X-Aangan-Test: 1 (only accepted with the tool secret) so their rows are
  // stored as test fixtures and never counted in production metrics.
  const deps = { ...liveDeps(), isTest: req.headers.get("x-aangan-test") === "1" };
  try {
    switch (name) {
      case "save_intake":
        return NextResponse.json(await saveIntake(deps, input as never));
      case "answer_question":
        return NextResponse.json(await answerLive(deps, input as never));
      case "evaluate_qualification":
        return NextResponse.json(await evaluateLive(deps, input as never));
      case "get_availability":
        return NextResponse.json(await availabilityLive(deps, input as never));
      case "book_consultation":
        return NextResponse.json(await bookLive(deps, input as never));
      case "log_unanswered_question":
        return NextResponse.json(await logUnansweredLive(deps, input as never));
      case "escalate":
        return NextResponse.json(await escalateLive(deps, input as never));
      case "take_message":
        return NextResponse.json(await takeMessageLive(deps, input as never));
    }
  } catch (e) {
    if (e instanceof BookingRefused) return NextResponse.json({ status: "refused", code: e.code, say: "I can't book a consultation for this enquiry yet." }, { status: 409 });
    throw e;
  }
});
