import { detectPricingDisclosure, PRICING_DEFLECTION } from "@/domain/pricing/guard";
import { answerQuestion, type RuntimeArticle } from "./answer";

export interface KnowledgeTest {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * Checks a proposed answer before it can be published:
 *  1. no price, range or per-sq-ft figure (the pricing article must be the exact approved text);
 *  2. short enough to speak (≤ 450 characters);
 *  3. each test question routes to this article, with the proposal swapped into the live set;
 *  4. existing published answers still route to the articles they routed to before.
 */
export async function testKnowledgeVersion(input: {
  article: Pick<RuntimeArticle, "slug" | "category" | "title" | "keywords">;
  spokenAnswer: string;
  testQuestions: string[];
  published: RuntimeArticle[];
  regressionQuestions?: { question: string; expectedSlug: string }[];
}): Promise<KnowledgeTest[]> {
  const out: KnowledgeTest[] = [];
  const pricing = detectPricingDisclosure(input.spokenAnswer);
  if (input.article.category === "pricing_policy") {
    out.push({ name: "Pricing policy text", passed: input.spokenAnswer === PRICING_DEFLECTION, detail: input.spokenAnswer === PRICING_DEFLECTION ? "Matches the approved deflection exactly" : "The pricing answer must be the approved deflection from pricing.md, verbatim" });
  } else {
    out.push({ name: "No pricing figures", passed: !pricing.violation, detail: pricing.violation ? `Found: ${pricing.matches.join(", ")}` : "No prices, ranges or per-sq-ft figures" });
  }
  out.push({ name: "Spoken length", passed: input.spokenAnswer.length <= 450, detail: `${input.spokenAnswer.length} characters (max 450)` });

  const candidate: RuntimeArticle = { ...input.article, spokenAnswer: input.spokenAnswer };
  const set = [...input.published.filter((a) => a.slug !== candidate.slug), candidate];
  const answerable = ["service", "service_area", "timeline", "faq"].includes(candidate.category);
  if (answerable) {
    if (!input.testQuestions.length) out.push({ name: "Routing", passed: false, detail: "Add at least one example caller question" });
    for (const q of input.testQuestions) {
      const r = await answerQuestion(q, set);
      const passed = r.articleSlug === candidate.slug;
      out.push({ name: `Routes: “${q.slice(0, 60)}”`, passed, detail: passed ? "Answered by this article" : r.kind === "pricing_deflection" ? "Treated as a pricing question (deflected)" : `Answered by ${r.articleSlug ?? "fallback"} — adjust keywords` });
    }
  }
  for (const reg of input.regressionQuestions ?? []) {
    const r = await answerQuestion(reg.question, set);
    if (r.articleSlug !== reg.expectedSlug)
      out.push({ name: `Regression: “${reg.question.slice(0, 60)}”`, passed: false, detail: `Now answered by ${r.articleSlug ?? "fallback"} instead of ${reg.expectedSlug}` });
  }
  if ((input.regressionQuestions ?? []).length && out.every((t) => !t.name.startsWith("Regression"))) {
    out.push({ name: "Regression suite", passed: true, detail: `${input.regressionQuestions!.length} existing questions still route correctly` });
  }
  return out;
}

/** Caller phrasings from the September transcripts, used as the knowledge regression suite. */
export const REGRESSION_QUESTIONS: { question: string; expectedSlug: string }[] = [
  { question: "Do you take up projects in Nashik?", expectedSlug: "service-area" },
  { question: "Can you take on a rented apartment?", expectedSlug: "rented-home" },
  { question: "Do you do commercial office projects?", expectedSlug: "commercial-scope" },
  { question: "How long does the whole process take?", expectedSlug: "timeline-process" },
  { question: "Can someone just come and give us ideas and suggestions?", expectedSlug: "not-offered" },
  { question: "Do you do Vastu?", expectedSlug: "vastu" },
  { question: "Can you move a wall for us?", expectedSlug: "structural-work" },
];
