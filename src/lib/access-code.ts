import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Access-code entry (instead of email + password). When ACCESS_CODE is set, the entry page asks for
 * that one code; a correct code sets a signed, httpOnly cookie valid for 30 days. The signing key is
 * derived from the code itself plus TOKEN_ENCRYPTION_KEY, so changing the code signs everyone out.
 */
export const ACCESS_COOKIE = "aangan_access";
export const ACCESS_TTL_SECONDS = 30 * 24 * 3600;

export function accessCode(): string | null {
  const c = process.env.ACCESS_CODE?.trim();
  return c && c.length >= 6 ? c : null;
}

function signingKey(code: string): string {
  return createHmac("sha256", process.env.TOKEN_ENCRYPTION_KEY ?? "aangan-access").update(`access:${code}`).digest("hex");
}

function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function checkCode(input: string): boolean {
  const code = accessCode();
  return !!code && equal(input.trim(), code);
}

export function issueToken(now = Date.now()): string {
  const code = accessCode();
  if (!code) throw new Error("ACCESS_CODE not configured");
  const exp = Math.floor(now / 1000) + ACCESS_TTL_SECONDS;
  const sig = createHmac("sha256", signingKey(code)).update(`v1.${exp}`).digest("base64url");
  return `v1.${exp}.${sig}`;
}

export function verifyToken(token: string | undefined | null, now = Date.now()): boolean {
  const code = accessCode();
  if (!code || !token) return false;
  const [v, exp, sig] = token.split(".");
  if (v !== "v1" || !exp || !sig || Number(exp) * 1000 < now) return false;
  const expected = createHmac("sha256", signingKey(code)).update(`v1.${exp}`).digest("base64url");
  return equal(sig, expected);
}
