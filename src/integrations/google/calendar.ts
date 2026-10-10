import { decryptToken, encryptToken } from "@/lib/crypto";
import type { Interval } from "@/domain/booking/slots";
import type { GoogleCredentialRow, Store } from "@/server/store/types";

/**
 * Google Calendar API v3 over plain fetch (OAuth 2.0 web-server flow, offline access).
 * Docs: https://developers.google.com/calendar/api/v3/reference
 *  - POST /freeBusy, POST /calendars/{id}/events, GET/PATCH events, GET /users/me/calendarList
 * Event ids are client-supplied (base32hex) so a retried insert can never create a duplicate.
 */
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const API = "https://www.googleapis.com/calendar/v3";
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}
export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: string;
}

export function buildAuthUrl(cfg: GoogleOAuthConfig, state: string): string {
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  }).toString();
  return u.toString();
}

export async function exchangeCode(cfg: GoogleOAuthConfig, code: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new GoogleAuthError(`Token exchange failed: ${body.error ?? res.status}`);
  if (!body.refresh_token) throw new GoogleAuthError("Google did not return a refresh token; remove the app's access in the Google account and reconnect.");
  // id_token came straight from Google's token endpoint over TLS; we only read the email claim.
  const email = body.id_token ? (JSON.parse(Buffer.from(body.id_token.split(".")[1], "base64url").toString()) as { email?: string }).email : undefined;
  if (!email) throw new GoogleAuthError("Could not determine the Google account email");
  return {
    email,
    refreshTokenEncrypted: encryptToken(body.refresh_token, cfg.encryptionKey),
    accessTokenEncrypted: encryptToken(body.access_token, cfg.encryptionKey),
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
    scopes: (body.scope ?? "").split(" ").filter(Boolean),
  };
}

export interface CalendarEventInput {
  id: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  timezone: string;
  location?: string | null;
  /** The client being booked. Google ignores it; Cal.com books them as the attendee and emails them. */
  attendee?: { name: string | null; email: string | null; phone: string | null };
}

export interface CalendarApi {
  freeBusy(calendarIds: string[], timeMin: string, timeMax: string): Promise<Record<string, Interval[]>>;
  insertEvent(calendarId: string, ev: CalendarEventInput): Promise<{ id: string; htmlLink: string | null; alreadyExisted: boolean }>;
  cancelEvent(calendarId: string, eventId: string): Promise<void>;
  listCalendars(): Promise<{ id: string; summary: string; primary: boolean; accessRole: string }[]>;
}

/** Calendar client bound to one stored credential; refreshes and re-encrypts access tokens. */
export function googleCalendar(credential: GoogleCredentialRow, cfg: GoogleOAuthConfig, store: Store, fetchImpl: typeof fetch = fetch): CalendarApi {
  let access: { token: string; expiresAt: number } | null =
    credential.access_token_encrypted && credential.access_token_expires_at
      ? { token: decryptToken(credential.access_token_encrypted, cfg.encryptionKey), expiresAt: Date.parse(credential.access_token_expires_at) }
      : null;

  async function token(force = false): Promise<string> {
    if (!force && access && access.expiresAt - 60_000 > Date.now()) return access.token;
    if (credential.status === "revoked") throw new GoogleAuthError("Calendar authorisation was revoked; reconnect required");
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: decryptToken(credential.refresh_token_encrypted, cfg.encryptionKey),
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      const revoked = body.error === "invalid_grant";
      await store.updateGoogleCredential(credential.id, { status: revoked ? "revoked" : "error", last_error: revoked ? "Authorisation expired or revoked" : `Refresh failed (${res.status})` });
      throw new GoogleAuthError(revoked ? "Calendar authorisation expired or was revoked; reconnect required" : "Could not refresh calendar access");
    }
    access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    await store.updateGoogleCredential(credential.id, {
      access_token_encrypted: encryptToken(body.access_token, cfg.encryptionKey),
      access_token_expires_at: new Date(access.expiresAt).toISOString(),
      status: "active",
      last_error: null,
    });
    return access.token;
  }

  async function call<T>(path: string, init: RequestInit = {}, retried = false): Promise<{ status: number; body: T }> {
    const res = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 && !retried) {
      await token(true);
      return call<T>(path, init, true);
    }
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
  }

  return {
    async freeBusy(calendarIds, timeMin, timeMax) {
      const { status, body } = await call<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> }>("/freeBusy", {
        method: "POST",
        body: JSON.stringify({ timeMin, timeMax, items: calendarIds.map((id) => ({ id })) }),
      });
      if (status >= 400) throw new GoogleApiError(status, `freeBusy failed (${status})`);
      const out: Record<string, Interval[]> = {};
      for (const id of calendarIds) {
        const cal = body.calendars?.[id];
        if (!cal || cal.errors?.length) throw new GoogleApiError(403, `Calendar ${id} not accessible: ${cal?.errors?.[0]?.reason ?? "missing"}`);
        out[id] = (cal.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
      }
      return out;
    },
    async insertEvent(calendarId, ev) {
      const { status, body } = await call<{ id?: string; htmlLink?: string }>(`/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, {
        method: "POST",
        body: JSON.stringify({
          id: ev.id,
          summary: ev.summary,
          description: ev.description,
          location: ev.location ?? undefined,
          start: { dateTime: ev.start, timeZone: ev.timezone },
          end: { dateTime: ev.end, timeZone: ev.timezone },
          reminders: { useDefault: true },
        }),
      });
      if (status === 409) {
        // Same client-supplied id: a previous attempt already created it.
        const existing = await call<{ id?: string; htmlLink?: string; status?: string }>(`/calendars/${encodeURIComponent(calendarId)}/events/${ev.id}`);
        if (existing.status === 200 && existing.body.status !== "cancelled") return { id: ev.id, htmlLink: existing.body.htmlLink ?? null, alreadyExisted: true };
        throw new GoogleApiError(409, "Event id already used by a cancelled event");
      }
      if (status >= 400 || !body.id) throw new GoogleApiError(status, `Event insert failed (${status})`);
      return { id: body.id, htmlLink: body.htmlLink ?? null, alreadyExisted: false };
    },
    async cancelEvent(calendarId, eventId) {
      const { status } = await call(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled" }),
      });
      if (status >= 400 && status !== 404 && status !== 410) throw new GoogleApiError(status, `Event cancel failed (${status})`);
    },
    async listCalendars() {
      const { status, body } = await call<{ items?: { id: string; summary: string; primary?: boolean; accessRole: string }[] }>("/users/me/calendarList?minAccessRole=writer");
      if (status >= 400) throw new GoogleApiError(status, `calendarList failed (${status})`);
      return (body.items ?? []).map((c) => ({ id: c.id, summary: c.summary, primary: !!c.primary, accessRole: c.accessRole }));
    },
  };
}

/** Google event ids: 5–1024 chars of base32hex (a–v, 0–9). A UUID's hex digits qualify. */
export function eventIdFor(appointmentId: string): string {
  return `aangan${appointmentId.replace(/-/g, "")}`.replace(/[^a-v0-9]/g, "");
}
