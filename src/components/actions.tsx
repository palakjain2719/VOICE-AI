"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";

/** Posts JSON to an internal API route and refreshes the page; shows generic errors only. */
export function useApi() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  async function call(url: string, body: unknown, method = "POST", success = "Saved") {
    setError(null);
    setOk(null);
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    if (!res.ok) {
      setError(json.message ?? (res.status === 403 ? "You don't have permission for this." : "That didn't work. Please try again."));
      return null;
    }
    setOk(success);
    start(() => router.refresh());
    return json;
  }
  return { call, pending, error, ok };
}

export function Btn({ className, variant = "secondary", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  return (
    <button
      {...rest}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-1.5 rounded-xl px-3.5 text-sm font-medium transition-colors disabled:opacity-50",
        variant === "primary" && "bg-accent text-accent-ink hover:opacity-90",
        variant === "secondary" && "border border-line bg-surface text-ink hover:border-line-strong",
        variant === "danger" && "border border-transparent bg-crit-soft text-crit-ink hover:opacity-90",
        className,
      )}
    />
  );
}

export function Feedback({ error, ok }: { error: string | null; ok: string | null }) {
  if (error) return <p role="alert" className="text-[13px] text-crit-ink">{error}</p>;
  if (ok) return <p role="status" className="text-[13px] text-good-ink">{ok}</p>;
  return null;
}

export const fieldCls = "w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent";
