import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError, readJson } from "@/server/http";
import { requireRole, actorId } from "@/server/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { store } from "@/server/store/supabase-store";
import { REGRESSION_QUESTIONS, testKnowledgeVersion } from "@/domain/knowledge/review";

const CATEGORIES = ["service", "service_area", "timeline", "faq", "qualification_policy", "pricing_policy", "fallback", "escalation_policy", "brand_voice", "closure"] as const;
const answer = z.string().trim().min(10).max(1000);
const questions = z.array(z.string().trim().min(3).max(300)).max(5).default([]);

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose"), article_id: z.uuid(), spoken_answer: answer, keywords: z.array(z.string().trim().min(2).max(60)).max(30).optional(), test_questions: questions, source_reference: z.string().trim().max(300).optional() }),
  z.object({
    action: z.literal("answer_unanswered"),
    question_id: z.uuid(),
    slug: z.string().trim().regex(/^[a-z0-9-]{3,60}$/),
    title: z.string().trim().min(3).max(120),
    category: z.enum(CATEGORIES),
    keywords: z.array(z.string().trim().min(2).max(60)).min(1).max(30),
    spoken_answer: answer,
    test_questions: questions,
  }),
  z.object({ action: z.literal("publish"), version_id: z.uuid() }),
  z.object({ action: z.literal("reject_version"), version_id: z.uuid(), reason: z.string().trim().min(3).max(500) }),
  z.object({ action: z.literal("reject_question"), question_id: z.uuid(), reason: z.string().trim().min(3).max(500) }),
]);

/**
 * Human-reviewed knowledge loop. Every change is a new version: proposed → tested → approved &
 * published by an admin, with who/when/which version recorded and audited. Nothing a caller
 * says becomes official information without this.
 */
export const POST = handle("admin.knowledge", async (req: Request) => {
  const user = await requireRole("admin");
  const body = await readJson(req, (v) => Body.parse(v));
  const db = createAdminClient();
  const s = store();
  const published = await s.listPublishedArticles();

  async function createVersion(articleId: string, article: { slug: string; category: string; title: string; keywords: string[] }, spoken: string, tests: string[], source: string | null) {
    const results = await testKnowledgeVersion({ article: { ...article, category: article.category }, spokenAnswer: spoken, testQuestions: tests, published, regressionQuestions: REGRESSION_QUESTIONS.filter((r) => r.expectedSlug !== article.slug) });
    const { data: last } = await db.from("knowledge_versions").select("version").eq("article_id", articleId).order("version", { ascending: false }).limit(1).maybeSingle();
    const { data: v, error } = await db
      .from("knowledge_versions")
      .insert({ article_id: articleId, version: (last?.version ?? 0) + 1, spoken_answer: spoken, status: "in_review", source_reference: source, test_results: { tests: results, test_questions: tests }, created_by: actorId(user) })
      .select("id, version")
      .single();
    if (error) throw new Error(error.message);
    return { version: v, results };
  }

  switch (body.action) {
    case "propose": {
      const { data: a } = await db.from("knowledge_articles").select("id, slug, category, title, keywords").eq("id", body.article_id).maybeSingle();
      if (!a) throw new HttpError(404, "Article not found", "not_found");
      if (body.keywords) await db.from("knowledge_articles").update({ keywords: body.keywords }).eq("id", a.id);
      const r = await createVersion(a.id, { ...a, keywords: body.keywords ?? a.keywords }, body.spoken_answer, body.test_questions, body.source_reference ?? null);
      await s.audit({ actor_id: actorId(user), action: "knowledge.propose", entity_type: "knowledge_version", entity_id: r.version.id, after: { article: a.slug, version: r.version.version } });
      return NextResponse.json({ ok: true, version_id: r.version.id, tests: r.results });
    }
    case "answer_unanswered": {
      const { data: q } = await db.from("unanswered_questions").select("id, question, status").eq("id", body.question_id).maybeSingle();
      if (!q) throw new HttpError(404, "Question not found", "not_found");
      let { data: a } = await db.from("knowledge_articles").select("id, slug, category, title, keywords").eq("slug", body.slug).maybeSingle();
      if (!a) {
        const ins = await db.from("knowledge_articles").insert({ slug: body.slug, category: body.category, title: body.title, keywords: body.keywords, status: "draft", audience: "customer" }).select("id, slug, category, title, keywords").single();
        if (ins.error) throw new Error(ins.error.message);
        a = ins.data;
      }
      const tests = body.test_questions.length ? body.test_questions : [q.question];
      const r = await createVersion(a.id, { ...a, keywords: body.keywords }, body.spoken_answer, tests, `unanswered_question:${q.id}`);
      await db.from("unanswered_questions").update({ status: "in_review", proposed_answer: body.spoken_answer, knowledge_article_id: a.id, knowledge_version_id: r.version.id }).eq("id", q.id);
      await s.audit({ actor_id: actorId(user), action: "knowledge.answer_unanswered", entity_type: "unanswered_question", entity_id: q.id, after: { article: a.slug, version_id: r.version.id } });
      return NextResponse.json({ ok: true, version_id: r.version.id, tests: r.results });
    }
    case "publish": {
      const { data: v } = await db.from("knowledge_versions").select("id, article_id, version, status, spoken_answer, test_results").eq("id", body.version_id).maybeSingle();
      if (!v) throw new HttpError(404, "Version not found", "not_found");
      if (v.status !== "in_review") throw new HttpError(409, "Only versions in review can be published.", "invalid_state");
      const tests = ((v.test_results as { tests?: { passed: boolean }[] } | null)?.tests ?? []);
      if (!tests.length || tests.some((t) => !t.passed)) throw new HttpError(409, "All checks must pass before publishing. Propose a revised version.", "tests_failed");
      const { data: a } = await db.from("knowledge_articles").select("id, published_version_id, slug").eq("id", v.article_id).single();
      const now = new Date().toISOString();
      if (a?.published_version_id) await db.from("knowledge_versions").update({ status: "archived" }).eq("id", a.published_version_id);
      await db.from("knowledge_versions").update({ status: "published", approved_by: actorId(user), approved_at: now, published_at: now }).eq("id", v.id);
      await db.from("knowledge_articles").update({ published_version_id: v.id, status: "published" }).eq("id", v.article_id);
      const { data: linked } = await db.from("unanswered_questions").select("id").eq("knowledge_version_id", v.id);
      for (const q of linked ?? []) {
        await db.from("unanswered_questions").update({ status: "answered", approved_answer: v.spoken_answer, reviewer_id: actorId(user), reviewed_at: now }).eq("id", q.id);
        await db.from("exceptions").update({ status: "resolved", resolution: `Answer published (version ${v.version})`, resolved_by: actorId(user), resolved_at: now }).eq("unanswered_question_id", q.id).in("status", ["open", "in_review"]);
      }
      await s.audit({ actor_id: actorId(user), action: "knowledge.publish", entity_type: "knowledge_version", entity_id: v.id, before: { published_version_id: a?.published_version_id ?? null }, after: { article: a?.slug, version: v.version } });
      return NextResponse.json({ ok: true });
    }
    case "reject_version": {
      const { error } = await db.from("knowledge_versions").update({ status: "rejected", internal_notes: body.reason }).eq("id", body.version_id).eq("status", "in_review");
      if (error) throw new Error(error.message);
      await s.audit({ actor_id: actorId(user), action: "knowledge.reject_version", entity_type: "knowledge_version", entity_id: body.version_id, after: { reason: body.reason } });
      return NextResponse.json({ ok: true });
    }
    case "reject_question": {
      const now = new Date().toISOString();
      await db.from("unanswered_questions").update({ status: "rejected", reviewer_id: actorId(user), reviewed_at: now }).eq("id", body.question_id);
      await db.from("exceptions").update({ status: "dismissed", resolution: body.reason, resolved_by: actorId(user), resolved_at: now }).eq("unanswered_question_id", body.question_id).in("status", ["open", "in_review"]);
      await s.audit({ actor_id: actorId(user), action: "knowledge.reject_question", entity_type: "unanswered_question", entity_id: body.question_id, after: { reason: body.reason } });
      return NextResponse.json({ ok: true });
    }
  }
});
