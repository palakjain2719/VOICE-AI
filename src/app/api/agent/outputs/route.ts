import { NextResponse, type NextRequest } from "next/server";
import { handle, HttpError } from "@/server/http";
import { requireRole } from "@/server/auth";
import { testCallOutputs } from "@/server/test-call";

export const GET = handle("agent.outputs", async (req: NextRequest) => {
  await requireRole("founder", "operator");
  const callId = req.nextUrl.searchParams.get("callId") ?? "";
  if (!/^test-[0-9a-f-]{36}$/.test(callId)) throw new HttpError(400, "callId required", "invalid_request");
  const out = await testCallOutputs(callId);
  if (!out) throw new HttpError(404, "Test call not found", "not_found");
  return NextResponse.json(out);
});
