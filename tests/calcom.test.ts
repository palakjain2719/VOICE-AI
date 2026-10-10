import { describe, expect, it } from "vitest";
import { calcomCalendar } from "@/integrations/calcom/client";

function fakeFetch(routes: Record<string, (init?: RequestInit) => unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname.replace("/v2", "");
    const key = Object.keys(routes).find((k) => (init?.method ?? "GET") + " " + path === k);
    if (!key) return new Response(JSON.stringify({ status: "error" }), { status: 404 });
    return new Response(JSON.stringify({ status: "success", data: routes[key](init) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const ev = { id: "aanganabc", summary: "Aangan consultation — Priya", description: "Scope: full home", start: "2026-10-13T05:30:00.000Z", end: "2026-10-13T06:30:00.000Z", timezone: "Asia/Kolkata", location: "Kothrud", attendee: { name: "Priya", email: null, phone: "+919800000000" } };

describe("Cal.com calendar", () => {
  it("merges connected-calendar busy times with Cal.com bookings", async () => {
    const { f } = fakeFetch({
      "GET /calendars": () => ({ connectedCalendars: [{ calendars: [{ credentialId: 1, externalId: "a@b.c", isSelected: true }] }] }),
      "GET /calendars/busy-times": () => [{ start: "2026-10-13T04:30:00Z", end: "2026-10-13T05:00:00Z" }],
      "GET /bookings": () => [{ uid: "u1", start: "2026-10-13T08:30:00Z", end: "2026-10-13T09:30:00Z", status: "accepted" }, { uid: "u2", start: "2026-10-13T10:00:00Z", end: "2026-10-13T11:00:00Z", status: "cancelled" }],
    });
    const fb = await calcomCalendar({ apiKey: "k", timezone: "Asia/Kolkata", fetchImpl: f }).freeBusy(["42"], "2026-10-13T00:00:00Z", "2026-10-14T00:00:00Z");
    expect(fb["42"]).toHaveLength(2);
  });

  it("books with the fallback attendee when no email, and is idempotent by event id", async () => {
    let existing: unknown[] = [];
    const { f, calls } = fakeFetch({
      "GET /bookings": () => existing,
      "POST /bookings": (init) => {
        const body = JSON.parse(String(init!.body));
        existing = [{ uid: "new1", start: body.start, end: ev.end, status: "accepted", metadata: body.metadata }];
        return { uid: "new1" };
      },
    });
    const cal = calcomCalendar({ apiKey: "k", timezone: "Asia/Kolkata", fallbackAttendeeEmail: "desk@studio.test", fetchImpl: f });
    const a = await cal.insertEvent("42", ev);
    const posted = JSON.parse(String(calls.find((c) => c.init?.method === "POST")!.init!.body));
    expect(posted.eventTypeId).toBe(42);
    expect(posted.attendee.email).toBe("desk@studio.test");
    expect(posted.bookingFieldsResponses.notes).toContain("Site: Kothrud");
    const b = await cal.insertEvent("42", ev);
    expect(a.alreadyExisted).toBe(false);
    expect(b).toMatchObject({ id: "new1", alreadyExisted: true });
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
  });

  it("refuses to book without any attendee email", async () => {
    const { f } = fakeFetch({ "GET /bookings": () => [] });
    await expect(calcomCalendar({ apiKey: "k", timezone: "Asia/Kolkata", fetchImpl: f }).insertEvent("42", ev)).rejects.toThrow(/attendee email/);
  });
});
