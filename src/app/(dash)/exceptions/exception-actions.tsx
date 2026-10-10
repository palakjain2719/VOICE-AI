"use client";
import { useState } from "react";
import { Btn, Feedback, fieldCls, useApi } from "@/components/actions";

export function ExceptionActions({ id, status, ownerId, users, retryable }: { id: string; status: string; ownerId: string | null; users: { id: string; label: string }[]; retryable: boolean }) {
  const { call, pending, error, ok } = useApi();
  const [note, setNote] = useState("");
  const [resolution, setResolution] = useState("");
  const closed = status === "resolved" || status === "dismissed";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-[13px] text-ink-3">Owner</span>
          <select className={`${fieldCls} h-9 py-0`} defaultValue={ownerId ?? ""} disabled={pending} onChange={(e) => call(`/api/dashboard/exceptions/${id}`, { owner_id: e.target.value || null }, "PATCH", "Owner updated")}>
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.label}</option>
            ))}
          </select>
        </label>
        {!closed && status !== "in_review" ? (
          <Btn disabled={pending} onClick={() => call(`/api/dashboard/exceptions/${id}`, { status: "in_review" }, "PATCH", "Marked in review")}>Start review</Btn>
        ) : null}
        {retryable && !closed ? (
          <Btn disabled={pending} onClick={() => call(`/api/dashboard/exceptions/${id}/retry`, {}, "POST", "Retry queued")}>Retry integration</Btn>
        ) : null}
      </div>
      <div>
        <label className="block text-sm">
          <span className="mb-1 block text-[13px] text-ink-3">Add a note</span>
          <textarea className={fieldCls} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </label>
        <Btn className="mt-2" disabled={pending || !note.trim()} onClick={async () => { if (await call(`/api/dashboard/exceptions/${id}`, { note }, "PATCH", "Note added")) setNote(""); }}>Add note</Btn>
      </div>
      {!closed ? (
        <div>
          <label className="block text-sm">
            <span className="mb-1 block text-[13px] text-ink-3">Resolution</span>
            <textarea className={fieldCls} rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} maxLength={2000} placeholder="What was done" />
          </label>
          <div className="mt-2 flex gap-2">
            <Btn variant="primary" disabled={pending || !resolution.trim()} onClick={() => call(`/api/dashboard/exceptions/${id}/resolve`, { status: "resolved", resolution }, "POST", "Resolved")}>Resolve</Btn>
            <Btn disabled={pending || !resolution.trim()} onClick={() => call(`/api/dashboard/exceptions/${id}/resolve`, { status: "dismissed", resolution }, "POST", "Dismissed")}>Dismiss</Btn>
          </div>
        </div>
      ) : (
        <Btn disabled={pending} onClick={() => call(`/api/dashboard/exceptions/${id}`, { status: "open" }, "PATCH", "Reopened")}>Reopen</Btn>
      )}
      <Feedback error={error} ok={ok} />
    </div>
  );
}
