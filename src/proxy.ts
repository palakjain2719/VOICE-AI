import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase session cookie and sends signed-out visitors to /login.
 * This is an optimistic check only; every page and API route re-verifies roles server-side.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const devPreview = process.env.NODE_ENV !== "production" && request.nextUrl.pathname.startsWith("/dev/");
  if (devPreview) return response;

  // Studio access code mode: one shared code instead of personal logins. Optimistic cookie check
  // here; every page and API route verifies the signed cookie server-side.
  const codeMode = (process.env.ACCESS_CODE?.trim().length ?? 0) >= 6;
  if (codeMode) {
    const path = request.nextUrl.pathname;
    const hasCookie = !!request.cookies.get("aangan_access")?.value;
    if (path === "/enter" || path.startsWith("/auth/")) return response;
    if (path === "/login" || !hasCookie) {
      const to = new URL("/enter", request.url);
      if (path !== "/login" && path !== "/") to.searchParams.set("next", path);
      return NextResponse.redirect(to);
    }
    return response;
  }
  if (!url || !key) {
    if (request.nextUrl.pathname.startsWith("/setup")) return response;
    return NextResponse.redirect(new URL("/setup", request.url));
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  const signedIn = !!data?.claims?.sub;
  const path = request.nextUrl.pathname;
  const isPublic = path === "/login" || path.startsWith("/auth/") || path.startsWith("/setup");
  if (!signedIn && !isPublic) {
    const to = new URL("/login", request.url);
    to.searchParams.set("next", path);
    return NextResponse.redirect(to);
  }
  return response;
}

export const config = {
  // API routes authenticate themselves (sessions, webhook signatures, tool secrets, cron secret).
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
