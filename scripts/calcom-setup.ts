/**
 * LIVE, idempotent: prepares Cal.com for consultation booking.
 *  1. a "Aangan studio hours" schedule (Mon–Sat 10:00–19:00 IST, matching the booking config)
 *  2. an "Aangan consultation" event type (60 min, site visit) on that schedule
 *  3. a bookable designer row linked to that event type (the Cal.com account owner)
 * Notice period and buffers stay in the app's booking rules, so Cal.com's own are set to zero.
 *   npm run calcom:setup
 */
import { createAdminClient } from "../src/lib/supabase/server";

const API = "https://api.cal.com/v2";
const key = process.env.CALCOM_API_KEY;
if (!key) throw new Error("CALCOM_API_KEY is not set");

async function cal<T>(path: string, version: string | null, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(version ? { "cal-api-version": version } : {}) },
  });
  const body = (await res.json()) as { status: string; data: T; error?: unknown };
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${JSON.stringify(body.error ?? body)}`);
  return body.data;
}

async function main() {
  const me = await cal<{ id: number; email: string; name: string }>("/me", null);
  console.log(`Cal.com account: ${me.name} <${me.email}>`);

  const schedules = await cal<{ id: number; name: string }[]>("/schedules", "2024-06-11");
  let schedule = schedules.find((s) => s.name === "Aangan studio hours");
  if (!schedule) {
    schedule = await cal<{ id: number; name: string }>("/schedules", "2024-06-11", {
      method: "POST",
      body: JSON.stringify({
        name: "Aangan studio hours",
        timeZone: "Asia/Kolkata",
        isDefault: false,
        availability: [{ days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], startTime: "10:00", endTime: "19:00" }],
      }),
    });
    console.log(`Created schedule ${schedule.id}`);
  } else console.log(`Schedule ${schedule.id} exists`);

  const types = await cal<{ id: number; slug: string }[]>("/event-types", "2024-06-14");
  let type = types.find((t) => t.slug === "aangan-consultation");
  if (!type) {
    type = await cal<{ id: number; slug: string }>("/event-types", "2024-06-14", {
      method: "POST",
      body: JSON.stringify({
        title: "Aangan consultation",
        slug: "aangan-consultation",
        lengthInMinutes: 60,
        description: "Free design consultation with an Aangan Studio designer. Booked by the Aangan enquiry desk.",
        scheduleId: schedule.id,
        minimumBookingNotice: 0,
        beforeEventBuffer: 0,
        afterEventBuffer: 0,
        locations: [{ type: "address", address: "Client's property (site visit) — address in booking notes", public: true }],
      }),
    });
    console.log(`Created event type ${type.id}`);
  } else console.log(`Event type ${type.id} exists`);

  const db = createAdminClient();
  const { data: existing } = await db.from("designers").select("id").eq("calendar_id", String(type.id)).maybeSingle();
  if (existing) {
    await db.from("designers").update({ active: true, booking_enabled: true }).eq("id", existing.id);
    console.log(`Designer ${existing.id} already linked`);
  } else {
    const { data, error } = await db.from("designers").insert({ name: me.name, email: me.email, calendar_id: String(type.id), active: true, booking_enabled: true }).select("id").single();
    if (error) throw error;
    console.log(`Designer ${data.id} linked to event type ${type.id}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
