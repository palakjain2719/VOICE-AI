import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ACCESS_COOKIE, accessCode } from "@/lib/access-code";

export async function POST(req: Request) {
  if (accessCode()) {
    const res = NextResponse.redirect(new URL("/enter", req.url), { status: 303 });
    res.cookies.set(ACCESS_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
}
