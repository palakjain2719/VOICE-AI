import { Suspense } from "react";
import { EnterForm } from "./enter-form";

export default function EnterPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="display text-[34px] font-semibold">Aangan</div>
          <div className="eyebrow mt-1">Enquiry desk</div>
        </div>
        <div className="rounded-[10px] border border-line bg-surface p-6">
          <Suspense>
            <EnterForm />
          </Suspense>
        </div>
        <p className="mt-4 text-center text-[12px] text-ink-3">The studio access code is shared by the team. This browser stays signed in for 30 days.</p>
      </div>
    </div>
  );
}
