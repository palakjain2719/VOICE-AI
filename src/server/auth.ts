import "server-only";
import { forbidden, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { ACCESS_COOKIE, accessCode, verifyToken } from "@/lib/access-code";

export type AppRole = "founder" | "operator" | "admin" | "designer";

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string | null;
  roles: AppRole[];
  /** Entered with the studio access code rather than a personal account. */
  viaCode?: boolean;
}

const STUDIO_USER: AuthedUser = { id: "studio-access", email: "studio access", displayName: "Studio", roles: ["admin"], viaCode: true };

/** Value for user foreign keys (resolved_by, created_by, …): null when entered with the access code. */
export function actorId(user: AuthedUser): string | null {
  return user.viaCode ? null : user.id;
}

/** True when the request carries a valid access-code cookie. */
export async function hasAccessCodeSession(): Promise<boolean> {
  if (!accessCode()) return false;
  return verifyToken((await cookies()).get(ACCESS_COOKIE)?.value);
}

export class AuthError extends Error {
  constructor(public readonly status: 401 | 403) {
    super(status === 401 ? "Not signed in" : "Not permitted");
  }
}

/** Admin implicitly holds every role, mirroring has_role() in SQL. */
export function hasRole(user: Pick<AuthedUser, "roles">, role: AppRole): boolean {
  return user.roles.includes(role) || user.roles.includes("admin");
}

export async function getCurrentUser(): Promise<AuthedUser | null> {
  if (await hasAccessCodeSession()) return STUDIO_USER;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  if (!sub) return null;
  const { data: row } = await createAdminClient()
    .from("app_users")
    .select("id, email, display_name, roles, active")
    .eq("id", sub)
    .maybeSingle();
  if (!row || !row.active) return { id: sub, email: String(data.claims.email ?? ""), displayName: null, roles: [] };
  return { id: row.id, email: row.email, displayName: row.display_name, roles: row.roles as AppRole[] };
}

/** For route handlers: throws AuthError, converted to 401/403 by `handle()`. */
export async function requireRole(...anyOf: AppRole[]): Promise<AuthedUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError(401);
  if (user.roles.length === 0) throw new AuthError(403);
  if (anyOf.length && !anyOf.some((r) => hasRole(user, r))) throw new AuthError(403);
  return user;
}

/** For pages: redirects to /login or renders the 403 boundary. */
export async function requirePageRole(...anyOf: AppRole[]): Promise<AuthedUser> {
  const user = await getCurrentUser();
  if (!user) redirect(accessCode() ? "/enter" : "/login");
  if (user.roles.length === 0 || (anyOf.length && !anyOf.some((r) => hasRole(user, r)))) forbidden();
  return user;
}
