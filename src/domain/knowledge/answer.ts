import { enforcePricingPolicy, isPricingRequest, PRICING_DEFLECTION } from "@/domain/pricing/guard";
import { FALLBACK_ANSWER } from "./seed";

export interface RuntimeArticle {
  slug: string;
  category: string;
  title: string;
  keywords: string[];
  spokenAnswer: string;
  versionId?: string | null;
}

/** Categories the agent may use to answer a free-form question. Closures etc. are flow-driven. */
const ANSWERABLE = new Set(["service", "service_area", "timeline", "faq"]);

export type AnswerKind = "pricing_deflection" | "approved_answer" | "fallback";

export interface AnswerResult {
  kind: AnswerKind;
  text: string;
  articleSlug: string | null;
  articleVersionId: string | null;
  /** True when the caller's question must be logged to the unanswered-question queue. */
  logUnanswered: boolean;
  pricingRequest: boolean;
  pricingBlocked: boolean;
}

/**
 * Optional model-assisted selector. It may only pick one of the candidate slugs (or none);
 * it never writes the answer text, so the agent cannot improvise business facts.
 */
export type ArticleSelector = (question: string, candidates: RuntimeArticle[]) => Promise<string | null>;

function norm(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

export function rankArticles(question: string, articles: RuntimeArticle[]): { article: RuntimeArticle; score: number }[] {
  const q = norm(question);
  return articles
    .filter((a) => ANSWERABLE.has(a.category))
    .map((article) => {
      let score = 0;
      for (const k of article.keywords) {
        if (q.includes(norm(k))) score += k.trim().split(/\s+/).length;
      }
      return { article, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

export async function answerQuestion(
  question: string,
  articles: RuntimeArticle[],
  selector?: ArticleSelector,
): Promise<AnswerResult> {
  const pricingRequest = isPricingRequest(question);
  if (pricingRequest) {
    // Pricing questions always get the approved deflection, even when embedded in another question.
    return {
      kind: "pricing_deflection",
      text: PRICING_DEFLECTION,
      articleSlug: "pricing-policy",
      articleVersionId: articles.find((a) => a.slug === "pricing-policy")?.versionId ?? null,
      logUnanswered: false,
      pricingRequest,
      pricingBlocked: false,
    };
  }

  const ranked = rankArticles(question, articles);
  let chosen: RuntimeArticle | null = null;
  if (selector) {
    const candidates = (ranked.length ? ranked.slice(0, 4).map((r) => r.article) : articles.filter((a) => ANSWERABLE.has(a.category)));
    try {
      const slug = await selector(question, candidates);
      chosen = candidates.find((c) => c.slug === slug) ?? null;
    } catch {
      chosen = ranked[0]?.article ?? null;
    }
  } else {
    chosen = ranked[0]?.article ?? null;
  }

  if (!chosen) {
    return {
      kind: "fallback",
      text: FALLBACK_ANSWER,
      articleSlug: null,
      articleVersionId: null,
      logUnanswered: true,
      pricingRequest,
      pricingBlocked: false,
    };
  }

  const guarded = enforcePricingPolicy(chosen.spokenAnswer);
  return {
    kind: guarded.blocked ? "pricing_deflection" : "approved_answer",
    text: guarded.text,
    articleSlug: chosen.slug,
    articleVersionId: chosen.versionId ?? null,
    logUnanswered: false,
    pricingRequest,
    pricingBlocked: guarded.blocked,
  };
}

export function normaliseQuestion(q: string): string {
  return norm(q).trim().slice(0, 300);
}
