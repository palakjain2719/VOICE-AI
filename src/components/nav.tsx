"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/", label: "Overview", roles: ["founder", "operator"] },
  { href: "/test-call", label: "Test call", roles: ["founder", "operator"] },
  { href: "/pipeline", label: "Pipeline", roles: ["founder", "operator"] },
  { href: "/desk", label: "Callbacks", roles: ["operator"] },
  { href: "/exceptions", label: "Decisions", roles: ["founder", "operator", "designer"] },
  { href: "/calls", label: "Calls", roles: ["operator"] },
  { href: "/knowledge", label: "Knowledge", roles: ["admin"] },
  { href: "/integrations", label: "Integrations", roles: ["admin"] },
  { href: "/settings", label: "Settings", roles: ["admin"] },
];

const allowed = (roles: string[], need: string[]) => roles.includes("admin") || need.some((r) => roles.includes(r));

export function TopNav({ roles }: { roles: string[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const links = ITEMS.filter((i) => allowed(roles, i.roles));
  const isActive = (href: string) => (href === "/" ? path === "/" || path.startsWith("/funnel") || path.startsWith("/costs") : path.startsWith(href));
  return (
    <>
      <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            aria-current={isActive(l.href) ? "page" : undefined}
            className={cn(
              "relative px-3 py-2 text-[14px] font-medium transition-colors",
              isActive(l.href) ? "text-ink after:absolute after:inset-x-3 after:-bottom-[13px] after:h-[2px] after:rounded-full after:bg-accent" : "text-ink-3 hover:text-ink",
            )}
          >
            {l.label}
          </Link>
        ))}
      </nav>
      <button type="button" className="inline-flex size-9 items-center justify-center rounded-lg border border-line md:hidden" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <X className="size-4" /> : <Menu className="size-4" />}
      </button>
      {open ? (
        <nav aria-label="Main" className="absolute inset-x-0 top-full z-30 border-b border-line bg-surface p-2 shadow-sm md:hidden">
          {links.map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)} aria-current={isActive(l.href) ? "page" : undefined} className={cn("block rounded-lg px-3 py-2 text-[14px]", isActive(l.href) ? "bg-accent-soft text-accent" : "text-ink-2")}>
              {l.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </>
  );
}
