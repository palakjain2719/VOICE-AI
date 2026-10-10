import { NextResponse } from "next/server";
import { z } from "zod";
import { clientIp, handle, HttpError, rateLimit, readJson } from "@/server/http";
import { ACCESS_COOKIE, ACCESS_TTL_SECONDS, accessCode, checkCode, issueToken } from "@/lib/access-code";
import { log } from "@/lib/log";

const Body = z.object({ code: z.string().trim().min(1).max(100) });

/** Exchanges the studio access code for a signed 30-day cookie. Attempts are rate-limited per IP. */
export const POST = handle("access.enter", async (req: Request) => {
  if (!accessCode()) throw new HttpError(404, "Access codes are not enabled", "not_enabled");
  await rateLimit(`access:${clientIp(req)}`, 8, 300);
  const { code } = await readJson(req, (v) => Body.parse(v));
  if (!checkCode(code)) {
    log.warn("access.wrong_code", { ip: clientIp(req) });
    throw new HttpError(401, "That code isn't right.", "wrong_code");
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, issueToken(), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: ACCESS_TTL_SECONDS });
  return res;
});
