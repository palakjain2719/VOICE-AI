"use client";
import { useState } from "react";
import { Btn, Feedback, fieldCls, useApi } from "@/components/actions";

type Test = { name: string; passed: boolean; detail: string };

function Tests({ tests }: { tests: Test[] | null }) {
  if (!tests) return null;
  return (
    <ul className="mt-2 space-y-1 text-[12.5px]">
      {tests.map((t) => (
        <li key={t.name} className={t.passed ? "text-good-ink" : "text-crit-ink"}>
          {t.passed ? "✓" : "✗"} {t.name} — {t.detail}
        </li>
      ))}
    </ul>
  );
}

const splitLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export function ProposeForm({ articleId, current, keywords }: { articleId: string; current: string; keywords: string[] }) {
  const { call, pending, error, ok } = useApi();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(current);
  const [kw, setKw] = useState(keywords.join(", "));
  const [qs, setQs] = useState("");
  const [tests, setTests] = useState<Test[] | null>(null);
  if (!open) return <Btn onClick={() => setOpen(true)}>Propose change</Btn>;
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-line bg-surface-2 p-3">
      <label className="block text-[13px] text-ink-3">Spoken answer<textarea className={`${fieldCls} mt-1`} rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} /></label>
      <label className="block text-[13px] text-ink-3">Keywords (comma-separated)<input className={`${fieldCls} mt-1`} value={kw} onChange={(e) => setKw(e.target.value)} /></label>
      <label className="block text-[13px] text-ink-3">Example caller questions (one per line)<textarea className={`${fieldCls} mt-1`} rows={2} value={qs} onChange={(e) => setQs(e.target.value)} /></label>
      <div className="flex gap-2">
        <Btn variant="primary" disabled={pending} onClick={async () => {
          const r = (await call("/api/admin/knowledge", { action: "propose", article_id: articleId, spoken_answer: text, keywords: kw.split(",").map((k) => k.trim()).filter(Boolean), test_questions: splitLines(qs) }, "POST", "Version created — review the checks below, then publish from History")) as { tests?: Test[] } | null;
          setTests(r?.tests ?? null);
        }}>Run checks & submit for approval</Btn>
        <Btn onClick={() => setOpen(false)}>Cancel</Btn>
      </div>
      <Tests tests={tests} />
      <Feedback error={error} ok={ok} />
    </div>
  );
}

export function AnswerQuestionForm({ questionId, question }: { questionId: string; question: string }) {
  const { call, pending, error, ok } = useApi();
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("faq");
  const [kw, setKw] = useState("");
  const [text, setText] = useState("");
  const [qs, setQs] = useState(question);
  const [reason, setReason] = useState("");
  const [tests, setTests] = useState<Test[] | null>(null);
  if (!open)
    return (
      <div className="flex flex-wrap gap-2">
        <Btn onClick={() => setOpen(true)}>Write approved answer</Btn>
        <input className={`${fieldCls} h-9 max-w-xs py-0`} placeholder="Reason to reject" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Btn disabled={pending || reason.trim().length < 3} onClick={() => call("/api/admin/knowledge", { action: "reject_question", question_id: questionId, reason }, "POST", "Rejected")}>Reject</Btn>
        <Feedback error={error} ok={ok} />
      </div>
    );
  return (
    <div className="mt-2 space-y-2 rounded-xl border border-line bg-surface-2 p-3">
      <div className="grid gap-2 md:grid-cols-3">
        <label className="text-[13px] text-ink-3">Slug<input className={`${fieldCls} mt-1`} placeholder="e.g. consultation-fee" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} /></label>
        <label className="text-[13px] text-ink-3">Title<input className={`${fieldCls} mt-1`} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="text-[13px] text-ink-3">Category
          <select className={`${fieldCls} mt-1`} value={category} onChange={(e) => setCategory(e.target.value)}>
            {["faq", "service", "service_area", "timeline"].map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-[13px] text-ink-3">Approved spoken answer (no prices)<textarea className={`${fieldCls} mt-1`} rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} /></label>
      <label className="block text-[13px] text-ink-3">Keywords (comma-separated)<input className={`${fieldCls} mt-1`} value={kw} onChange={(e) => setKw(e.target.value)} /></label>
      <label className="block text-[13px] text-ink-3">Test questions (one per line)<textarea className={`${fieldCls} mt-1`} rows={2} value={qs} onChange={(e) => setQs(e.target.value)} /></label>
      <div className="flex gap-2">
        <Btn variant="primary" disabled={pending} onClick={async () => {
          const r = (await call("/api/admin/knowledge", { action: "answer_unanswered", question_id: questionId, slug, title, category, keywords: kw.split(",").map((k) => k.trim()).filter(Boolean), spoken_answer: text, test_questions: splitLines(qs) }, "POST", "Draft created — publish it from History once checks pass")) as { tests?: Test[] } | null;
          setTests(r?.tests ?? null);
        }}>Run checks & submit</Btn>
        <Btn onClick={() => setOpen(false)}>Cancel</Btn>
      </div>
      <Tests tests={tests} />
      <Feedback error={error} ok={ok} />
    </div>
  );
}

export function VersionActions({ versionId, canPublish }: { versionId: string; canPublish: boolean }) {
  const { call, pending, error, ok } = useApi();
  const [reason, setReason] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Btn variant="primary" disabled={pending || !canPublish} title={canPublish ? undefined : "All checks must pass"} onClick={() => call("/api/admin/knowledge", { action: "publish", version_id: versionId }, "POST", "Published — re-export the agent instructions")}>Approve & publish</Btn>
      <input className={`${fieldCls} h-9 max-w-[200px] py-0`} placeholder="Rejection reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Btn disabled={pending || reason.trim().length < 3} onClick={() => call("/api/admin/knowledge", { action: "reject_version", version_id: versionId, reason }, "POST", "Rejected")}>Reject</Btn>
      <Feedback error={error} ok={ok} />
    </div>
  );
}
