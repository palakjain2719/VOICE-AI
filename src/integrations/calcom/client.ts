import type { Interval } from "@/domain/booking/slots";
import type { CalendarApi, CalendarEventInput } from "@/integrations/google/calendar";

/**
 * Cal.com API v2 over plain fetch, behind the same CalendarApi the booking service already uses.
 * Docs: https://cal.com/docs/api-reference/v2
 *  - "calendar id" = a Cal.com event type id (designers.calendar_id)
 *  - free/busy  = GET /calendars/busy-times on every calendar connected to Cal.com, plus Cal.com's
 *                 own upcoming bookings (so a booking not yet mirrored to Google still blocks the slot)
 *  - insert     = POST /bookings; Cal.com emails the attendee and writes to the connected calendar
 *  - cancel     = POST /bookings/{uid}/cancel
 * Retries are idempotent: each booking carries `aangan_event_id` in its metadata and an insert first
 * looks for an existing booking with that id at the same start time.
 */
const API = "https://api.cal.com/v2";
const BOOKINGS_VERSION = "2024-08-13";
const EVENT_TYPES_VERSION = "2024-06-14";

export class CalcomApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CalcomApiError";
  }
}

export interface CalcomOptions {
  apiKey: string;
  timezone: string;
  /** Used as the attendee when the caller gave no email (Cal.com requires one). */
  fallbackAttendeeEmail?: string | null;
  fetchImpl?: typeof fetch;
}

type Booking = { uid: string; start: string; end: string; status: string; metadata?: Record<string, string> };

export function calcomCalendar(opts: CalcomOptions): CalendarApi & { me(): Promise<{ email: string; name: string; timeZone: string }> } {
  const f = opts.fetchImpl ?? fetch;

  async function call<T>(path: string, init: RequestInit & { version?: string } = {}): Promise<T> {
    const res = await f(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        ...(init.version ? { "cal-api-version": init.version } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; data?: unknown; error?: { message?: string } };
    if (!res.ok || body.status === "error") throw new CalcomApiError(res.status, `Cal.com ${path.split("?")[0]} failed (${res.status})${body.error?.message ? `: ${body.error.message}` : ""}`);
    return body.data as T;
  }

  let connected: Promise<{ credentialId: number; externalId: string }[]> | null = null;
  function connectedCalendars() {
    connected ??= call<{ connectedCalendars: { calendars?: { credentialId: number; externalId: string; isSelected?: boolean }[] }[] }>("/calendars").then((d) =>
      d.connectedCalendars.flatMap((c) => (c.calendars ?? []).filter((x) => x.isSelected !== false).map((x) => ({ credentialId: x.credentialId, externalId: x.externalId }))),
    );
    return connected;
  }

  async function bookingsBetween(fromIso: string, toIso: string): Promise<Booking[]> {
    const q = new URLSearchParams({ status: "upcoming", afterStart: fromIso, beforeEnd: toIso, take: "100" });
    return call<Booking[]>(`/bookings?${q}`, { version: BOOKINGS_VERSION });
  }

  const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: opts.timezone });

  return {
    async me() {
      return call<{ email: string; name: string; timeZone: string }>("/me");
    },

    async freeBusy(calendarIds, timeMin, timeMax) {
      const cals = await connectedCalendars();
      const q = new URLSearchParams({ loggedInUsersTz: opts.timezone, dateFrom: day(timeMin), dateTo: day(timeMax) });
      cals.forEach((c, i) => {
        q.set(`calendarsToLoad[${i}][credentialId]`, String(c.credentialId));
        q.set(`calendarsToLoad[${i}][externalId]`, c.externalId);
      });
      const [external, bookings] = await Promise.all([
        cals.length ? call<{ start: string; end: string }[]>(`/calendars/busy-times?${q}`) : Promise.resolve([]),
        bookingsBetween(timeMin, timeMax),
      ]);
      const busy: Interval[] = [...external, ...bookings.filter((b) => b.status !== "cancelled")].map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
      // One Cal.com account: every event type shares the same busy times.
      return Object.fromEntries(calendarIds.map((id) => [id, busy]));
    },

    async insertEvent(calendarId, ev: CalendarEventInput) {
      const prior = (await bookingsBetween(new Date(Date.parse(ev.start) - 60_000).toISOString(), ev.end)).find((b) => b.metadata?.aangan_event_id === ev.id && b.status !== "cancelled");
      if (prior) return { id: prior.uid, htmlLink: null, alreadyExisted: true };

      const email = ev.attendee?.email ?? opts.fallbackAttendeeEmail;
      if (!email) throw new CalcomApiError(400, "Cal.com needs an attendee email and no fallback is configured");
      const booking = await call<{ uid: string }>("/bookings", {
        method: "POST",
        version: BOOKINGS_VERSION,
        body: JSON.stringify({
          start: new Date(ev.start).toISOString(),
          eventTypeId: Number(calendarId),
          attendee: {
            name: ev.attendee?.name || "Aangan client",
            email,
            timeZone: ev.timezone,
            ...(ev.attendee?.phone ? { phoneNumber: ev.attendee.phone } : {}),
          },
          // The event type's own location applies; the site address travels in the notes.
          bookingFieldsResponses: { notes: [ev.summary, ev.location && `Site: ${ev.location}`, ev.description].filter(Boolean).join("\n\n") },
          metadata: { aangan_event_id: ev.id },
        }),
      });
      return { id: booking.uid, htmlLink: `https://app.cal.com/booking/${booking.uid}`, alreadyExisted: false };
    },

    async cancelEvent(_calendarId, eventId) {
      try {
        await call(`/bookings/${encodeURIComponent(eventId)}/cancel`, {
          method: "POST",
          version: BOOKINGS_VERSION,
          body: JSON.stringify({ cancellationReason: "Cancelled by Aangan Studio" }),
        });
      } catch (e) {
        if (!(e instanceof CalcomApiError) || (e.status !== 404 && e.status !== 410)) throw e;
      }
    },

    /** Event types stand in for "calendars": a designer books into one event type. */
    async listCalendars() {
      const types = await call<{ id: number; title: string; slug: string; lengthInMinutes: number }[]>("/event-types", { version: EVENT_TYPES_VERSION });
      return types.map((t) => ({ id: String(t.id), summary: `${t.title} (${t.lengthInMinutes} min)`, primary: t.slug === "aangan-consultation", accessRole: "owner" }));
    },
  };
}
