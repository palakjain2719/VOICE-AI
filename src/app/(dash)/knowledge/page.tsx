import Link from "next/link";
import { Suspense } from "react";
import { Lock } from "lucide-react";
import { Badge, Card, CardHeader, dateTime, EmptyState, ErrorNote, Notice, PageHeader, PageSkeleton } from "@/components/ui";
import { createDataClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { cn } from "@/lib/utils";
import { AnswerQuestionForm, ProposeForm, VersionActions } from "./knowledge-forms";

const TABS = [
  ["articles", "Approved answers"],
  ["unanswered", "Unanswered questions"],
  ["history", "Review & history"],
  ["restricted", "Restricted"],
] as const;

export default function KnowledgePage({ searchParams }: PageProps<"/knowledge">) {
  return (
    <>
      <PageHeader title="Knowledge base" description="The only business facts the voice agent may say. Every change is versioned, tested and approved by an admin.">
        <a href="/api/admin/agent-instructions" className="inline-flex h-9 items-center rounded-xl border border-line bg-surface px-3.5 text-sm font-medium hover:border-line-strong">Export agent instructions</a>
      </PageHeader>
      <Suspense fallback={<PageSkeleton />}>
        <Knowledge searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Knowledge({ searchParams }: { searchParams: PageProps<"/knowledge">["searchParams"] }) {
  await requirePageRole("admin");
  const tab = ((await searchParams) as Record<string, string>).tab ?? "articles";
  const db = await createDataClient();
  const [articles, versions, questions, restricted] = await Promise.all([
    db.from("knowledge_articles").select("id, slug, category, title, keywords, status, published_version_id, knowledge_versions!knowledge_articles_published_fk(version, spoken_answer, published_at, source_reference)").order("category"),
    db.from("knowledge_versions").select("id, version, status, spoken_answer, test_results, created_at, approved_at, published_at, internal_notes, knowledge_articles!knowledge_versions_article_id_fkey(slug, title)").order("created_at", { ascending: false }).limit(100),
    db.from("unanswered_questions").select("id, question, occurrences, status, created_at, call_id, proposed_answer").eq("is_test", false).order("created_at", { ascending: false }).limit(200),
    db.from("restricted_documents").select("slug, title, updated_at"),
  ]);
  if (articles.error || versions.error || questions.error) return <ErrorNote>The knowledge base couldn&apos;t load. Please refresh.</ErrorNote>;

  return (
    <div className="space-y-4">
      <nav aria-label="Knowledge sections" className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
        {TABS.map(([key, label]) => (
          <Link key={key} href={`/knowledge?tab=${key}`} aria-current={tab === key ? "page" : undefined} className={cn("rounded-lg px-3 py-1.5 text-[13.5px] font-medium", tab === key ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink")}>
            {label}
            {key === "unanswered" ? ` (${(questions.data ?? []).filter((q) => q.status === "unresolved").length})` : ""}
          </Link>
        ))}
      </nav>

      {tab === "articles" ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {(articles.data ?? []).map((a) => {
            const v = a.knowledge_versions as unknown as { version: number; spoken_answer: string; published_at: string; source_reference: string | null } | null;
            return (
              <Card key={a.id} className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[15px] font-semibold">{a.title}</h3>
                  <Badge>{a.category.replace(/_/g, " ")}</Badge>
                  {v ? <Badge tone="good">v{v.version} live</Badge> : <Badge tone="warn">not published</Badge>}
                </div>
                <p className="mt-2 text-[14px] leading-relaxed">{v?.spoken_answer ?? "—"}</p>
                <p className="mt-2 text-[12px] text-ink-3">Source: {v?.source_reference ?? "—"}{a.keywords.length ? ` · keywords: ${a.keywords.join(", ")}` : ""}</p>
                <div className="mt-3"><ProposeForm articleId={a.id} current={v?.spoken_answer ?? ""} keywords={a.keywords} /></div>
              </Card>
            );
          })}
        </div>
      ) : null}

      {tab === "unanswered" ? (
        <Card>
          {(questions.data ?? []).length === 0 ? (
            <EmptyState title="No unanswered questions">When the agent can&apos;t answer from approved knowledge it gives the fallback and logs the question here.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {(questions.data ?? []).map((q) => (
                <li key={q.id} id={`q-${q.id}`} className="space-y-2 px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14.5px] font-medium">“{q.question}”</span>
                    <Badge tone={q.status === "unresolved" ? "accent" : q.status === "answered" ? "good" : "neutral"}>{q.status.replace("_", " ")}</Badge>
                    <span className="text-[12px] text-ink-3">asked {q.occurrences}× · first {dateTime(q.created_at)}</span>
                    {q.call_id ? <Link href={`/calls/${q.call_id}`} className="text-[12px] text-accent">call</Link> : null}
                  </div>
                  {q.status === "unresolved" ? <AnswerQuestionForm questionId={q.id} question={q.question} /> : q.proposed_answer ? <p className="text-[13px] text-ink-3">Proposed: {q.proposed_answer}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === "history" ? (
        <Card>
          <CardHeader title="Versions" description="Newest first. Only versions whose checks all pass can be published." />
          <ul className="divide-y divide-line">
            {(versions.data ?? []).map((v) => {
              const tests = ((v.test_results as { tests?: { name: string; passed: boolean; detail: string }[] } | null)?.tests ?? []);
              const art = v.knowledge_articles as unknown as { slug: string; title: string } | null;
              return (
                <li key={v.id} className="space-y-2 px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{art?.title ?? "Article"} · v{v.version}</span>
                    <Badge tone={v.status === "published" ? "good" : v.status === "in_review" ? "accent" : v.status === "rejected" ? "crit" : "neutral"}>{v.status.replace("_", " ")}</Badge>
                    <span className="text-[12px] text-ink-3">created {dateTime(v.created_at)}{v.published_at ? ` · published ${dateTime(v.published_at)}` : ""}</span>
                  </div>
                  <p className="text-[14px]">{v.spoken_answer}</p>
                  {tests.length ? (
                    <ul className="text-[12.5px]">
                      {tests.map((t) => <li key={t.name} className={t.passed ? "text-good-ink" : "text-crit-ink"}>{t.passed ? "✓" : "✗"} {t.name} — {t.detail}</li>)}
                    </ul>
                  ) : null}
                  {v.internal_notes ? <p className="text-[12.5px] text-ink-3">Note: {v.internal_notes}</p> : null}
                  {v.status === "in_review" ? <VersionActions versionId={v.id} canPublish={tests.length > 0 && tests.every((t) => t.passed)} /> : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {tab === "restricted" ? (
        <Card className="p-5">
          <div className="flex items-center gap-2"><Lock aria-hidden className="size-4 text-ink-3" /><h3 className="font-semibold">Internal pricing guide</h3></div>
          <p className="mt-2 text-[14px] text-ink-2">
            The numeric pricing guide is kept out of the runtime and out of every customer-facing context. The agent only ever receives the approved pricing deflection. It is stored, admin-only, in <code>restricted_documents</code>{(restricted.data ?? []).length ? ` (last updated ${dateTime(restricted.data![0].updated_at)})` : " (not loaded)"}, and the source file is excluded from git.
          </p>
          <div className="mt-3"><Notice>Qualification rules and thresholds live in Settings → Qualification and are versioned with every evaluation.</Notice></div>
        </Card>
      ) : null}
    </div>
  );
}
