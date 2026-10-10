import Link from "next/link";
import { Suspense } from "react";
import { TopNav } from "@/components/nav";
import { getCurrentUser } from "@/server/auth";

async function UserArea() {
  const user = await getCurrentUser();
  const roles = user?.roles ?? [];
  return (
    <>
      <TopNav roles={roles} />
      <div className="ml-auto flex items-center gap-3">
        <div className="hidden text-right lg:block">
          <div className="max-w-[200px] truncate text-[13px] font-medium text-ink">{user?.displayName ?? user?.email}</div>
          <div className="text-[11.5px] text-ink-3 capitalize">{roles.join(" · ") || "no role assigned"}</div>
        </div>
        <form action="/auth/signout" method="post">
          <button className="h-8 rounded-lg border border-line px-3 text-[13px] text-ink-2 hover:border-line-strong hover:text-ink">Sign out</button>
        </form>
      </div>
    </>
  );
}

export default function DashLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
        <div className="relative mx-auto flex h-[60px] max-w-[1240px] items-center gap-6 px-4 sm:px-6">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="display text-[21px] font-semibold text-ink">Aangan</span>
            <span className="eyebrow hidden sm:inline">Enquiry desk</span>
          </Link>
          <Suspense fallback={<div className="ml-auto h-8 w-40 animate-pulse rounded-lg bg-line/60" />}>
            <UserArea />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto max-w-[1240px] px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
