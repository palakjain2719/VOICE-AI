/** LIVE: one test call through the real server path (Supabase + Gemini). Rows are test fixtures. */
import { startTestCall, testCallOutputs, testCallTurn } from "../src/server/test-call";

async function main() {
  const { callId, state } = await startTestCall();
  console.log(`call ${callId}\nAgent: ${state.turns[0].text}`);
  for (const line of [
    "Hi, we want to redo our whole 2BHK in Baner with execution — kitchen, wardrobes and living room.",
    "I'm Rahul Mehta.", "About 950 square feet.", "No fixed date, we're flexible.", "Yes I decide, it's my flat.", "9822055555",
    "Is the consultation free?", "No thanks, not right now.",
  ]) {
    console.log(`Caller: ${line}`);
    const r = await testCallTurn(callId, line);
    console.log(`Agent: ${r.say}`);
    if (r.done) break;
  }
  const out = await testCallOutputs(callId);
  console.log("\nOUTPUTS", JSON.stringify({ call: out?.call, lead: out?.lead, exceptions: out?.exceptions.map((e) => `${e.kind}/${e.lane}`), jobs: out?.jobs }, null, 1));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
