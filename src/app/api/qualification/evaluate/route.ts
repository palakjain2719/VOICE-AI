import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, readJson } from "@/server/http";
import { requireRole } from "@/server/auth";
import { evaluate } from "@/domain/qualification/engine";
import { CRITERIA, LeadFactsSchema } from "@/domain/qualification/types";
import { loadQualificationConfig } from "@/server/settings";
import { store } from "@/server/store/supabase-store";

const Body = z.object({ facts: LeadFactsSchema.partial(), clarifications_asked: z.array(z.enum(CRITERIA)).default([]), as_of: z.iso.date().optional() });

/** Deterministic rules on supplied facts. No persistence; live calls use /api/voice/tools/evaluate_qualification. */
export const POST = handle("qualification.evaluate", async (req: Request) => {
  await requireRole("operator");
  const body = await readJson(req, (v) => Body.parse(v));
  const config = await loadQualificationConfig(store());
  return NextResponse.json(evaluate({ facts: LeadFactsSchema.parse(body.facts), config, clarificationsAsked: body.clarifications_asked, now: body.as_of ? new Date(`${body.as_of}T12:00:00+05:30`) : new Date() }));
});
