"use client";
import { useState } from "react";
import { Btn, useApi } from "@/components/actions";

export function TestButton({ provider, label = "Test connection", confirm }: { provider: string; label?: string; confirm?: string }) {
  const { call, pending, error } = useApi();
  const [result, setResult] = useState<{ ok: boolean; message?: string; checks?: { check: string; ok: boolean; missingScopes?: string[] }[]; results?: { designer: string; ok: boolean; message: string }[]; missing_scopes?: string[] } | null>(null);
  return (
    <div className="space-y-2">
      <Btn
        disabled={pending}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setResult((await call("/api/integrations/test", { provider }, "POST", "")) as typeof result);
        }}
      >
        {pending ? "Testing…" : label}
      </Btn>
      {error ? <p role="alert" className="text-[12.5px] text-crit-ink">{error}</p> : null}
      {result ? (
        <div role="status" className={`text-[12.5px] ${result.ok ? "text-good-ink" : "text-crit-ink"}`}>
          {result.message}
          {result.checks?.map((c) => <div key={c.check}>{c.ok ? "✓" : "✗"} {c.check}{c.missingScopes?.length ? ` — missing ${c.missingScopes.join(", ")}` : ""}</div>)}
          {result.results?.map((r) => <div key={r.designer}>{r.ok ? "✓" : "✗"} {r.designer}: {r.message}</div>)}
        </div>
      ) : null}
    </div>
  );
}
