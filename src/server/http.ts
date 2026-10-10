import "server-only";
import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { AuthError } from "./auth";
import { ConfigError, env } from "@/lib/env";
import { log, safeErrorMessage } from "@/lib/log";
import { safeEqual } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/server";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly publicMessage: string,
    public readonly code = "error",
  ) {
    super(publicMessage);
  }
}

/**
 * Wraps a route handler: maps known errors to generic client messages and logs redacted
 * details server-side. Never echoes internal error text to the browser.
 */
export function handle<A extends unknown[]>(name: string, fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      // Let Next.js control-flow signals (dynamic bail-out, redirects) pass through untouched.
      unstable_rethrow(err);
      if (err instanceof AuthError) return NextResponse.json({ error: err.status === 401 ? "unauthorized" : "forbidden" }, { status: err.status });
      if (err instanceof HttpError) return NextResponse.json({ error: err.code, message: err.publicMessage }, { status: err.status });
      if (err instanceof ZodError) return NextResponse.json({ error: "invalid_request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
      if (err instanceof ConfigError) {
        log.error(`${name}.config_error`, { provider: err.provider, missing: err.missing });
        return NextResponse.json({ error: "integration_not_configured", provider: err.provider }, { status: 503 });
      }
      log.error(`${name}.unhandled`, { error: safeErrorMessage(err) });
      return NextResponse.json({ error: "internal_error", message: "Something went wrong. Please try again." }, { status: 500 });
    }
  };
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
export function requireCron(req: Request) {
  const secret = env().CRON_SECRET;
  const got = bearer(req);
  if (!secret || !got || !safeEqual(got, secret)) throw new HttpError(401, "Unauthorized", "unauthorized");
}

/** The voice agent's live tool calls carry `Authorization: Bearer $VOICE_TOOL_SECRET`. */
export function requireVoiceTool(req: Request) {
  const secret = env().VOICE_TOOL_SECRET;
  const got = bearer(req);
  if (!secret || !got || !safeEqual(got, secret)) throw new HttpError(401, "Unauthorized", "unauthorized");
}

export async function rateLimit(bucket: string, max: number, windowSeconds = 60) {
  const { data, error } = await createAdminClient().rpc("rate_limit_hit", {
    p_bucket: bucket,
    p_window_seconds: windowSeconds,
    p_max: max,
  });
  if (error) {
    log.warn("rate_limit.unavailable", { bucket, error: error.message });
    return; // fail open on limiter outage; endpoints remain authenticated
  }
  if (data === false) throw new HttpError(429, "Too many requests", "rate_limited");
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function readJson<T>(req: Request, parse: (v: unknown) => T, maxBytes = 64_000): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Payload too large", "payload_too_large");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON", "invalid_json");
  }
  return parse(body);
}
