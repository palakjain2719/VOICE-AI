import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCode, issueToken, verifyToken } from "@/lib/access-code";

describe("studio access code", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("accepts only the configured code and issues a cookie that verifies", () => {
    vi.stubEnv("ACCESS_CODE", "kothrud-2026");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "k");
    expect(checkCode("wrong")).toBe(false);
    expect(checkCode(" kothrud-2026 ")).toBe(true);
    const t = issueToken();
    expect(verifyToken(t)).toBe(true);
    expect(verifyToken(t.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBe(false);
    expect(verifyToken(undefined)).toBe(false);
  });
  it("expires after 30 days and is invalidated when the code changes", () => {
    vi.stubEnv("ACCESS_CODE", "kothrud-2026");
    const t = issueToken(Date.now());
    expect(verifyToken(t, Date.now() + 31 * 86400_000)).toBe(false);
    vi.stubEnv("ACCESS_CODE", "baner-2027");
    expect(verifyToken(t)).toBe(false);
  });
  it("is disabled when no code (or a too-short code) is set", () => {
    vi.stubEnv("ACCESS_CODE", "abc");
    expect(checkCode("abc")).toBe(false);
    expect(() => issueToken()).toThrow();
  });
});
