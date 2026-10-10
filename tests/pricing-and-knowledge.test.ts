import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPricingDisclosure, enforcePricingPolicy, isPricingRequest, PRICING_DEFLECTION } from "@/domain/pricing/guard";
import { answerQuestion, type RuntimeArticle } from "@/domain/knowledge/answer";
import { FALLBACK_ANSWER, SEED_ARTICLES } from "@/domain/knowledge/seed";
import { buildAgentInstructions } from "@/domain/knowledge/agent-instructions";
import { REGRESSION_QUESTIONS, testKnowledgeVersion } from "@/domain/knowledge/review";
import { buildKnowledgeSeedSql } from "@/domain/knowledge/seed-sql";

const articles: RuntimeArticle[] = SEED_ARTICLES.map((a) => ({ slug: a.slug, category: a.category, title: a.title, keywords: a.keywords, spokenAnswer: a.spokenAnswer }));
const ROOT = join(__dirname, "..");

describe("pricing policy (pricing.md)", () => {
  it("uses the exact approved deflection", () => {
    expect(PRICING_DEFLECTION).toBe(
      "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.",
    );
    expect(readFileSync(join(ROOT, "business-source/restricted/pricing.md"), "utf8")).toContain(PRICING_DEFLECTION);
  });

  const requests = [
    "Can you tell me roughly how much something like that would cost?", // T02 direct
    "Yes, but can you give me a rough ballpark first? Even a range?", // T02 repeated
    "But seriously — can't you give me even a rough range?", // T13 repeated
    "how much do you charge per sq ft for a 2bhk?", // W02
    "Can you email me the price list?", // F07 rate card
    "What are your rates?",
    "Is it expensive to do a 3BHK with you?", // indirect
    "Would 10 lakh be enough for my flat?", // indirect, budget check
    "Do you work in Wakad and what would a 2BHK cost?", // embedded
    "What's the starting price for a kitchen?",
    "Kitna kharcha aayega 2BHK ke liye?", // Hindi
    "Can I get a quotation?",
  ];
  it.each(requests)("deflects: %s", async (q) => {
    expect(isPricingRequest(q)).toBe(true);
    const r = await answerQuestion(q, articles);
    expect(r.kind).toBe("pricing_deflection");
    expect(r.text).toBe(PRICING_DEFLECTION);
  });

  it("deflects every time when the caller insists", async () => {
    for (let i = 0; i < 5; i++) expect((await answerQuestion("Just give me a number, how much?", articles)).text).toBe(PRICING_DEFLECTION);
  });

  const disclosures = [
    "It'll cost around 18 lakh for that.",
    "Our rates start at ₹1,800 per sq ft.",
    "For a 2BHK it's typically 12 to 15 lakhs.",
    "Roughly Rs. 2400 a square foot.",
    "Somewhere between 3.5L and 8L for a room.",
    "That would be about three and a half lakh rupees.",
    "Pricing starts from 1200 per sqft for offices.",
    "It costs around twenty thousand rupees per room.",
  ];
  it.each(disclosures)("detects a prohibited disclosure: %s", (t) => {
    expect(detectPricingDisclosure(t).violation).toBe(true);
    expect(enforcePricingPolicy(t)).toMatchObject({ blocked: true, text: PRICING_DEFLECTION });
  });

  it("does not treat non-price questions as pricing requests", () => {
    for (const q of ["Is a 2BHK possible in 6 weeks?", "Do you work in Baner?", "How long does design take?", "Can you do 3 rooms?"]) expect(isPricingRequest(q), q).toBe(false);
  });

  it("does not flag ordinary numbers (areas, weeks, BHK, times)", () => {
    for (const t of ["About 1,400 sq ft carpet.", "Design takes three to four weeks.", "A 3BHK in Kothrud.", "You're booked for Tuesday at 10:30 am.", "Offices up to about 3,000 square feet."]) {
      expect(detectPricingDisclosure(t).violation).toBe(false);
    }
  });

  it("no approved runtime answer contains a pricing figure", () => {
    for (const a of SEED_ARTICLES) expect(detectPricingDisclosure(a.spokenAnswer).violation, a.slug).toBe(false);
  });

  it("the customer-facing agent instructions contain none of the internal pricing guide's figures", () => {
    const text = buildAgentInstructions(articles, { toolsBaseUrl: "https://example.test" });
    const guide = readFileSync(join(ROOT, "business-source/restricted/pricing.md"), "utf8");
    const figures = [...guide.matchAll(/₹\s?[\d,.]+\+?|\d[\d,.]*\s?lakh/g)].map((m) => m[0].replace(/[₹\s+]/g, "")).filter((f) => /\d[,.]\d|lakh/.test(f));
    expect(figures.length).toBeGreaterThan(5);
    for (const f of figures) expect(text, f).not.toContain(f);
    expect(text).not.toMatch(/₹|per sq ?ft\s*\d|\d\s*lakh/i);
    expect(text).toContain(PRICING_DEFLECTION);
  });

  it("no application code imports the restricted pricing guide", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f) && /(from|import\(|require\(|readFile\w*\()\s*["'`][^"'`]*(restricted|pricing\.md)/.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });

  it("the generated knowledge migration contains no pricing figures and matches the TS source", () => {
    const sql = readFileSync(join(ROOT, "supabase/migrations/20261010000004_seed_knowledge.sql"), "utf8");
    expect(sql).toBe(buildKnowledgeSeedSql());
    expect(sql).not.toMatch(/₹|\d\s*lakh/i);
  });
});

describe("runtime answer policy", () => {
  it.each(REGRESSION_QUESTIONS)("routes '$question' to $expectedSlug", async ({ question, expectedSlug }) => {
    const r = await answerQuestion(question, articles);
    expect(r.articleSlug).toBe(expectedSlug);
    expect(r.kind).toBe("approved_answer");
  });

  it("gives the approved fallback and asks for logging when nothing approved applies", async () => {
    const r = await answerQuestion("Do you work on Sundays?", articles);
    expect(r).toMatchObject({ kind: "fallback", text: FALLBACK_ANSWER, logUnanswered: true });
  });

  it("the model selector can only choose approved articles — it cannot write text", async () => {
    const none = await answerQuestion("Is the consultation free?", articles, async () => null);
    expect(none.kind).toBe("fallback");
    const invented = await answerQuestion("Do you do kitchens?", articles, async () => "made-up-slug");
    expect(invented.kind).toBe("fallback");
    const ok = await answerQuestion("Do you do kitchens?", articles, async () => "residential-scope");
    expect(ok.text).toBe(articles.find((a) => a.slug === "residential-scope")!.spokenAnswer);
  });
});

describe("knowledge review checks", () => {
  const published = articles;
  it("passes a good new FAQ that routes its example question", async () => {
    const tests = await testKnowledgeVersion({
      article: { slug: "office-hours", category: "faq", title: "Office hours", keywords: ["office hours", "open", "sunday", "weekend"] },
      spokenAnswer: "Our studio team works Monday to Saturday. I can book a consultation for you right now.",
      testQuestions: ["Are you open on Sunday?"],
      published,
      regressionQuestions: REGRESSION_QUESTIONS,
    });
    expect(tests.every((t) => t.passed)).toBe(true);
  });

  it("blocks an answer that contains a price", async () => {
    const tests = await testKnowledgeVersion({ article: { slug: "kitchen", category: "faq", title: "Kitchen", keywords: ["kitchen"] }, spokenAnswer: "Kitchens start at ₹3 lakh.", testQuestions: ["Do you do kitchens?"], published });
    expect(tests.find((t) => t.name === "No pricing figures")?.passed).toBe(false);
  });

  it("blocks a change to the pricing article unless it is the exact deflection", async () => {
    const tests = await testKnowledgeVersion({ article: { slug: "pricing-policy", category: "pricing_policy", title: "Pricing", keywords: [] }, spokenAnswer: "Pricing varies, ask your designer.", testQuestions: [], published });
    expect(tests[0].passed).toBe(false);
  });

  it("flags a change that steals another article's questions", async () => {
    const tests = await testKnowledgeVersion({
      article: { slug: "areas-extra", category: "faq", title: "Areas", keywords: ["nashik", "projects in nashik", "take up projects"] },
      spokenAnswer: "We love working everywhere.",
      testQuestions: ["Do you take up projects in Nashik?"],
      published,
      regressionQuestions: REGRESSION_QUESTIONS,
    });
    expect(tests.some((t) => t.name.startsWith("Regression") && !t.passed)).toBe(true);
  });
});
