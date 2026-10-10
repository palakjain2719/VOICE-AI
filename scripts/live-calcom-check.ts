/** LIVE: free/busy → book → idempotent re-book → cancel against Cal.com. Leaves nothing booked. */
import { calcomCalendar } from "../src/integrations/calcom/client";

async function main() {
  const cal = calcomCalendar({ apiKey: process.env.CALCOM_API_KEY!, timezone: "Asia/Kolkata", fallbackAttendeeEmail: process.env.CALCOM_FALLBACK_ATTENDEE_EMAIL });
  const types = await cal.listCalendars();
  const type = types.find((t) => t.primary);
  if (!type) throw new Error("Run npm run calcom:setup first");
  const start = new Date(Date.now() + 3 * 86400_000);
  start.setUTCHours(5, 30, 0, 0); // 11:00 IST
  if (start.getUTCDay() === 0) start.setUTCDate(start.getUTCDate() + 1);
  const end = new Date(start.getTime() + 3600_000);
  const fb = await cal.freeBusy([type.id], new Date().toISOString(), new Date(Date.now() + 7 * 86400_000).toISOString());
  console.log(`event type ${type.summary}; busy intervals next 7 days: ${fb[type.id].length}`);
  const ev = { id: `aanganchk${Date.now()}`, summary: "Aangan consultation — connection check", description: "Automated check; cancelled immediately.", start: start.toISOString(), end: end.toISOString(), timezone: "Asia/Kolkata", attendee: { name: "Connection check", email: null, phone: null } };
  const a = await cal.insertEvent(type.id, ev);
  console.log("booked", a);
  const b = await cal.insertEvent(type.id, ev);
  console.log("re-book same id →", b.alreadyExisted ? "returned existing (idempotent)" : "DUPLICATE CREATED");
  const after = await cal.freeBusy([type.id], start.toISOString(), end.toISOString());
  console.log("slot now busy:", after[type.id].some((i) => i.start < end && i.end > start));
  await cal.cancelEvent(type.id, a.id);
  if (b.id !== a.id) await cal.cancelEvent(type.id, b.id);
  console.log("cancelled");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
