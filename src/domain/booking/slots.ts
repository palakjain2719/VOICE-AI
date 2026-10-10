import { fromZonedTime, toZonedTime, formatInTimeZone } from "date-fns-tz";
import { z } from "zod";

export const BookingConfigSchema = z.object({
  timezone: z.string(),
  durationMinutes: z.number().int().min(15).max(240),
  bufferMinutes: z.number().int().min(0).max(240),
  slotStepMinutes: z.number().int().min(15).max(120),
  minNoticeHours: z.number().min(0).max(168),
  horizonDays: z.number().int().min(1).max(60),
  maxOptions: z.number().int().min(1).max(5),
  /** 0 = Sunday … 6 = Saturday; null = closed. Times are local "HH:MM". */
  workingHours: z.array(z.object({ start: z.string(), end: z.string() }).nullable()).length(7),
  /** Local dates (YYYY-MM-DD) when no consultations are booked. */
  holidays: z.array(z.iso.date()),
  meetingType: z.enum(["site_visit", "studio", "video"]),
});
export type BookingConfig = z.infer<typeof BookingConfigSchema>;

export const DEFAULT_BOOKING_CONFIG: BookingConfig = {
  timezone: "Asia/Kolkata",
  durationMinutes: 60,
  bufferMinutes: 30,
  slotStepMinutes: 30,
  minNoticeHours: 18,
  horizonDays: 14,
  maxOptions: 3,
  // Front-desk hours in the September transcripts were 10am–7pm; Sunday closed. Admin-editable.
  workingHours: [null, ...Array(6).fill({ start: "10:00", end: "19:00" })],
  holidays: [],
  meetingType: "site_visit",
};

export interface Interval {
  start: Date;
  end: Date;
}

export interface Slot {
  designerId: string;
  start: string;
  end: string;
  label: string;
}

export interface SlotPreference {
  /** Local dates the caller asked for (YYYY-MM-DD). Empty = any. */
  dates?: string[];
  dayparts?: ("morning" | "afternoon" | "evening")[];
  weekdaysOnly?: boolean;
  weekendsOnly?: boolean;
  earliest?: string;
}

const DAYPART: Record<string, [number, number]> = { morning: [0, 12 * 60], afternoon: [12 * 60, 16 * 60], evening: [16 * 60, 24 * 60] };

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function formatSlotLabel(startIso: string, tz: string): string {
  return formatInTimeZone(new Date(startIso), tz, "EEEE d MMMM, h:mm a");
}

/**
 * Real slots only: derived from each designer's free/busy response plus configured hours,
 * buffers and holidays. Designers with fewer upcoming bookings are offered first.
 */
export function computeSlots(input: {
  designers: { id: string; load: number }[];
  busy: Record<string, Interval[]>;
  config: BookingConfig;
  now: Date;
  preference?: SlotPreference;
  limit?: number;
}): Slot[] {
  const { config: c, now, preference: p = {} } = input;
  const limit = input.limit ?? c.maxOptions;
  const earliest = new Date(Math.max(now.getTime() + c.minNoticeHours * 3600_000, p.earliest ? Date.parse(p.earliest) : 0));
  const designers = [...input.designers].sort((a, b) => a.load - b.load);
  const result: Slot[] = [];
  const takenStarts = new Set<string>();

  for (let d = 0; d <= c.horizonDays && result.length < limit; d++) {
    const localDay = toZonedTime(new Date(now.getTime() + d * 86400_000), c.timezone);
    const dateStr = formatInTimeZone(new Date(now.getTime() + d * 86400_000), c.timezone, "yyyy-MM-dd");
    const dow = localDay.getDay();
    const hours = c.workingHours[dow];
    if (!hours || c.holidays.includes(dateStr)) continue;
    if (p.dates?.length && !p.dates.includes(dateStr)) continue;
    if (p.weekdaysOnly && (dow === 0 || dow === 6)) continue;
    if (p.weekendsOnly && dow !== 0 && dow !== 6) continue;

    for (let m = minutes(hours.start); m + c.durationMinutes <= minutes(hours.end) && result.length < limit; m += c.slotStepMinutes) {
      if (p.dayparts?.length && !p.dayparts.some((dp) => m >= DAYPART[dp][0] && m < DAYPART[dp][1])) continue;
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      const start = fromZonedTime(`${dateStr}T${hh}:${mm}:00`, c.timezone);
      const end = new Date(start.getTime() + c.durationMinutes * 60_000);
      if (start < earliest) continue;
      if (takenStarts.has(start.toISOString())) continue;
      const padded: Interval = { start: new Date(start.getTime() - c.bufferMinutes * 60_000), end: new Date(end.getTime() + c.bufferMinutes * 60_000) };
      const free = designers.find((ds) => !(input.busy[ds.id] ?? []).some((b) => overlaps(b, padded)));
      if (!free) continue;
      result.push({ designerId: free.id, start: start.toISOString(), end: end.toISOString(), label: formatSlotLabel(start.toISOString(), c.timezone) });
      takenStarts.add(start.toISOString());
      // Spread options: skip ahead so the caller hears distinct choices, not 10:00/10:30/11:00.
      m += Math.max(0, 120 - c.slotStepMinutes);
    }
  }
  return result;
}

/** True when [start,end] (with buffer) is free for the designer. Used to revalidate before booking. */
export function isSlotFree(busy: Interval[], start: Date, end: Date, bufferMinutes: number): boolean {
  const padded = { start: new Date(start.getTime() - bufferMinutes * 60_000), end: new Date(end.getTime() + bufferMinutes * 60_000) };
  return !busy.some((b) => overlaps(b, padded));
}
