"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export function EnterForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    setBusy(false);
    if (!res.ok) {
      setError(res.status === 429 ? "Too many tries — wait a few minutes." : "That code isn't right.");
      return;
    }
    const next = sp.get("next");
    router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-[13px] font-medium text-ink-2">
        Studio access code
        <input value={code} onChange={(e) => setCode(e.target.value)} type="password" autoComplete="current-password" autoFocus required className="mt-1.5 h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px] tracking-wider outline-none focus:border-accent" />
      </label>
      {error ? <p role="alert" className="text-[13px] text-crit-ink">{error}</p> : null}
      <button disabled={busy || !code.trim()} className="h-11 w-full rounded-lg bg-accent text-[15px] font-medium text-accent-ink disabled:opacity-60">{busy ? "Checking…" : "Enter"}</button>
    </form>
  );
}
