import { Suspense } from "react";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(1200px_600px_at_20%_0%,var(--lavender),transparent),radial-gradient(900px_500px_at_100%_100%,var(--mint),transparent)] px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7 shadow-sm">
        <div aria-hidden className="mb-5 size-10 rounded-xl bg-[linear-gradient(135deg,#d9d2fb,#cfe3fb_55%,#cdeedf)]" />
        <h1 className="text-xl font-semibold">Sign in to Aangan Studio</h1>
        <p className="mt-1 mb-6 text-sm text-ink-3">Enquiry desk and founder dashboard. Accounts are created by an administrator.</p>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
