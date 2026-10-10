import { NextResponse } from "next/server";
import { z } from "zod";
import { normaliseQuestion } from "@/domain/knowledge/answer";
import { handle, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { store } from "@/server/store/supabase-store";

const Body = z.object({ question: z.string().trim().min(3).max(500), call_id: z.uuid().nullish() });

/** Lets an operator log a question the agent (or the team) couldn't answer. The voice agent uses /api/voice/tools/log_unanswered_question. */
export const POST = handle("knowledge.unanswered", async (req: Request) => {
  const user = await requireRole("operator");
  const body = await readJson(req, (v) => Body.parse(v));
  const s = store();
  const q = await s.logUnansweredQuestion({ question: body.question, normalized: normaliseQuestion(body.question), call_id: body.call_id ?? null });
  await s.upsertException({ kind: "unanswered_question", severity: "low", title: `Unanswered: “${body.question.slice(0, 120)}”`, detail: "Logged manually.", call_id: body.call_id ?? null, unanswered_question_id: q.id, dedupe_key: `unanswered:${q.id}` });
  await s.audit({ actor_id: actorId(user), action: "knowledge.log_unanswered", entity_type: "unanswered_question", entity_id: q.id });
  return NextResponse.json({ ok: true, id: q.id, created: q.created });
});
