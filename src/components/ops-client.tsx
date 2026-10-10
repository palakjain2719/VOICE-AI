"use client";
import { RefreshCw } from "lucide-react";
import { Btn, Feedback, useApi } from "./actions";
import { cn } from "@/lib/utils";

export function RefreshSummary() {
  const { call, pending, error } = useApi();
  return (
    <div className="flex items-center gap-2">
      {error ? <span className="text-[12px] text-crit-ink">{error}</span> : null}
      <button type="button" disabled={pending} onClick={() => call("/api/dashboard/ai-summary", {}, "POST", "Refreshed")} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent hover:underline disabled:opacity-50">
        <RefreshCw aria-hidden className={cn("size-3.5", pending && "animate-spin")} /> Refresh
      </button>
    </div>
  );
}

export function DecisionButtons({ id, actions }: { id: string; actions: ("approve" | "reject" | "route_admin" | "route_callback" | "route_designer")[] }) {
  const { call, pending, error, ok } = useApi();
  const label = { approve: "Approve & book", reject: "Not a fit", route_admin: "Send to admin", route_callback: "Needs a call", route_designer: "Ask a designer" } as const;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            disabled={pending}
            onClick={() => {
              if (a === "reject" && !window.confirm("Decline this enquiry? A polite closing email is sent if we have their email.")) return;
              call(`/api/dashboard/exceptions/${id}/decide`, { decision: a }, "POST", a === "approve" ? "Approved — booking callback created" : a === "reject" ? "Declined" : "Moved");
            }}
            className={cn(
              "h-8 rounded-md border px-2.5 text-[12.5px] font-medium disabled:opacity-50",
              a === "approve" ? "border-good/40 bg-good-soft text-good-ink" : a === "reject" ? "border-crit/30 bg-crit-soft text-crit-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong",
            )}
          >
            {label[a]}
          </button>
        ))}
      </div>
      <Feedback error={error} ok={ok} />
    </div>
  );
}

export function MessageDone({ id }: { id: string }) {
  const { call, pending } = useApi();
  return <Btn className="h-8 text-[12.5px]" disabled={pending} onClick={() => call(`/api/messages/${id}`, { status: "done" }, "PATCH", "Done")}>Done</Btn>;
}
