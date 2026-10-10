"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const { error } = await createSupabaseBrowserClient().auth.signInWithPassword({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setBusy(false);
    if (error) {
      setError("Those details didn't work. Check your email and password.");
      return;
    }
    const next = sp.get("next");
    router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    router.refresh();
  }

  const input = "h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm outline-none focus:border-accent";
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="block text-sm font-medium">
        Email
        <input name="email" type="email" autoComplete="email" required className={`${input} mt-1`} />
      </label>
      <label className="block text-sm font-medium">
        Password
        <input name="password" type="password" autoComplete="current-password" required className={`${input} mt-1`} />
      </label>
      {error ? <p role="alert" className="text-sm text-crit-ink">{error}</p> : null}
      <button disabled={busy} className="h-10 w-full rounded-xl bg-accent text-sm font-medium text-accent-ink disabled:opacity-60">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
