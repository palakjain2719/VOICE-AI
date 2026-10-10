/**
 * LIVE check of the conversation engine: real Gemini understanding, in-memory store and a fake
 * calendar (writes nothing anywhere). npm run check:conversation
 */
import { gemini } from "../src/integrations/gemini/client";
import { handleTurn, newState, type ConversationState } from "../src/server/services/conversation";
import type { CalendarApi, CalendarEventInput } from "../src/integrations/google/calendar";
import { memoryStore } from "../tests/support/memory-store";

function fakeCalendar(): CalendarApi {
  const events = new Map<string, CalendarEventInput>();
  return {
    async freeBusy(ids) { return Object.fromEntries(ids.map((id) => [id, [...events.values()].map((e) => ({ start: new Date(e.start), end: new Date(e.end) }))])); },
    async insertEvent(_c, ev) { events.set(ev.id, ev); return { id: ev.id, htmlLink: null, alreadyExisted: false }; },
    async cancelEvent() {},
    async listCalendars() { return []; },
  };
}

const SCRIPTS: { name: string; expect: string; lines: string[] }[] = [
  { name: "Qualified caller books", expect: "booked", lines: [
    "Hi, I want to redo my whole 3BHK flat — kitchen, living room and both bedrooms.",
    "I'm Priya Kulkarni.", "It's in Kothrud, Dahanukar Colony.", "It's our home.", "About 1400 square feet carpet.",
    "We'd like it done by March, no rush.", "Yes, me and my husband decide, he's fine with it.", "9822012345",
    "How much would something like this cost, roughly?", "Okay fine, yes please book it.", "The first one works.", "priya.k@example.com",
  ] },
  { name: "Outside service area", expect: "declined", lines: ["Hello, I'd like interiors done for my flat in Nashik, the whole thing with execution."] },
  { name: "Existing-client complaint", expect: "complaint escalated", lines: [
    "I need to speak to someone, my project has been going on for three months and my designer Aryan hasn't replied in five days.",
    "Sheetal Deshpande", "9822033333",
  ] },
  { name: "Message for a designer", expect: "message taken", lines: [
    "Hi, I wanted to leave a message for Rohan about the kitchen tile samples.", "Meenal", "9822044444, after 6 pm is best",
  ] },
];

async function run() {
  const model = gemini();
  let failures = 0;
  for (const sc of SCRIPTS) {
    const m = memoryStore();
    m.addDesigner({ name: "Asha Kulkarni" });
    m.addDesigner({ name: "Rohan Joshi", email: "rohan@example.com" });
    const deps = { live: { store: m.store, now: () => new Date(), calendarFor: async () => fakeCalendar(), isTest: true }, model };
    let state: ConversationState = newState();
    const callId = `check-${Date.now()}`;
    console.log(`\n── ${sc.name}`);
    console.log(`Agent: ${state.turns[0].text}`);
    for (const line of sc.lines) {
      console.log(`Caller: ${line}`);
      const r = await handleTurn(deps, callId, state, line);
      state = r.state;
      console.log(`Agent: ${r.say}`);
      if (r.done) break;
    }
    const ok = state.outcome === sc.expect;
    if (!ok) failures++;
    console.log(`${ok ? "✓" : "✗"} outcome: ${state.outcome} (expected ${sc.expect})`);
    console.log(`  trace: ${state.trace.map((t) => `${t.step}: ${t.detail}`).join(" | ")}`);
  }
  console.log(`\n${SCRIPTS.length - failures}/${SCRIPTS.length} conversations ended as expected`);
  process.exitCode = failures ? 1 : 0;
}
run();
