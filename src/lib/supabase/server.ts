import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { requireEnv } from "@/lib/env";
import { DB_SCHEMA } from "./schema";
import { ACCESS_COOKIE, accessCode, verifyToken } from "@/lib/access-code";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = SupabaseClient<any, any, any>;

/** Session-scoped client: every query runs as the signed-in user, so RLS applies. */
export async function createSupabaseServerClient(): Promise<Db> {
  // Read the request first: during prerendering this marks the caller dynamic before any
  // configuration check can fail.
  const cookieStore = await cookies();
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY } = requireEnv("supabase", [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ]);
  return createServerClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    db: { schema: DB_SCHEMA },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component: the proxy refreshes the session instead.
        }
      },
    },
  });
}

let admin: Db | null = null;

/**
 * Privileged client using the Supabase secret key. Bypasses RLS: only for trusted server code
 * (webhooks, voice tools, jobs, and route handlers after an explicit role check).
 */
export function createAdminClient(): Db {
  if (admin) return admin;
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY } = requireEnv("supabase", [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
  ]);
  admin = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: DB_SCHEMA },
  });
  return admin;
}

/**
 * Client for dashboard reads/writes on behalf of the visitor. A personal account gets its own
 * session client (RLS applies). A visitor who entered the studio access code — verified from its
 * signed cookie — uses the server client, since there is no personal account to scope rows to.
 */
export async function createDataClient(): Promise<Db> {
  const cookieStore = await cookies();
  if (accessCode() && verifyToken(cookieStore.get(ACCESS_COOKIE)?.value)) return createAdminClient();
  return createSupabaseServerClient();
}
