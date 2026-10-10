/**
 * LIVE check: runs real Gemini extraction on the September transcript fixtures, then the rules
 * engine, and compares with the rubric's expected outcome. Writes nothing anywhere.
 *   npm run check:extraction
 */
import { gemini } from "../src/integrations/gemini/client";
import { articleSelector, extractCall } from "../src/integrations/gemini/tasks";
import { answerQuestion } from "../src/domain/knowledge/answer";
import { SEED_ARTICLES } from "../src/domain/knowledge/seed";
import { evaluate } from "../src/domain/qualification/engine";
import { DEFAULT_QUALIFICATION_CONFIG } from "../src/domain/qualification/config";
import { TRANSCRIPTS } from "../tests/fixtures/transcripts";

async function main() {
  const model = gemini();
  let failures = 0;
  let tokens = 0;
  for (const t of TRANSCRIPTS) {
    try {
      const { data, usage } = await extractCall(model, t.text, `${t.date}T12:00:00+05:30`);
      tokens += usage.promptTokens + usage.outputTokens;
      const isLead = data.callType === "new_enquiry" || data.callType === "existing_lead_follow_up";
      let outcome: string = "not_a_lead";
      if (isLead) {
        const r = evaluate({ facts: data.facts, config: DEFAULT_QUALIFICATION_CONFIG, clarificationsAsked: data.clarificationsAsked, now: new Date(`${t.date}T12:00:00+05:30`) });
        outcome = r.status === "needs_clarification" ? "needs_review" : r.status; // post-call: no one left to ask
      }
      const ok = (t.expected as string[]).includes(outcome) && data.callType === t.expectedCallType;
      if (!ok) failures++;
      console.log(`${ok ? "✓" : "✗"} ${t.id} type=${data.callType} outcome=${outcome} (expected ${t.expected.join("/")})`);
      if (!ok) console.log(`    facts: ${JSON.stringify(data.facts)}`);
    } catch (e) {
      failures++;
      console.log(`✗ ${t.id} error: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  console.log(`\n${TRANSCRIPTS.length - failures}/${TRANSCRIPTS.length} matched the rubric · ${tokens} tokens\n`);

  // Gemini may only CHOOSE an approved answer (or none); it never writes customer-facing text.
  const articles = SEED_ARTICLES.map((a) => ({ slug: a.slug, category: a.category, title: a.title, keywords: a.keywords, spokenAnswer: a.spokenAnswer }));
  const selector = articleSelector(model);
  const cases: [string, string | null][] = [
    ["Do you take projects in Nashik?", "service-area"],
    ["Can you also break a wall between the kitchen and living room?", "structural-work"],
    ["I'm renting — can you still do my flat?", "rented-home"],
    ["Is the first consultation free?", null],
    ["Do you have a showroom I can visit on Sunday?", null],
    ["How long will the whole thing take?", "timeline-process"],
  ];
  for (const [q, want] of cases) {
    const r = await answerQuestion(q, articles, selector);
    const ok = r.articleSlug === want;
    if (!ok) failures++;
    console.log(`${ok ? "✓" : "✗"} "${q}" → ${r.articleSlug ?? "fallback (logged for review)"}${ok ? "" : ` (expected ${want ?? "fallback"})`}`);
  }
  process.exitCode = failures ? 1 : 0;
}
main();
