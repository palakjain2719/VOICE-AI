/**
 * Pricing policy enforcement (pricing.md): no number from the internal pricing guide, no
 * range, no per-sq-ft figure and no "it'll cost around…" may ever reach a customer.
 *
 * This module is deliberately self-contained and never imports the internal guide: the
 * customer-facing path only knows the approved deflection below.
 */

/** Verbatim from pricing.md: "The only acceptable response to a pricing question". */
export const PRICING_DEFLECTION =
  "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.";

const REQUEST_PATTERNS: RegExp[] = [
  /\bhow much\b/i,
  /\b(price|prices|pricing|priced)\b/i,
  /\bcosts?\b|\bcosting\b/i,
  /\brates?\b/i,
  /\brate ?card\b|\bprice ?list\b|\bbrochure with (prices|rates)\b/i,
  /\bper\s*(sq|square)\.?\s*(ft|feet|foot|metre|meter)\b|\bper sqft\b|\/\s*sq\.?\s*ft\b/i,
  /\bball ?park\b|\brough (figure|idea|number|range|estimate)\b|\bapproximate (figure|amount)\b/i,
  /\b(estimate|quotation|quote)\b/i,
  /\b(charge|charges|charging|fee|fees)\b/i,
  /\b(expensive|affordable|cheap|afford)\b/i,
  /\bwhat (kind of |sort of )?budget\b|\bbudget (do i|would i|should i|will i) need\b/i,
  /\bstarting (price|from)\b|\bminimum (cost|price|budget|amount)\b/i,
  // Budget-fit checks are price questions in disguise: "Would 10 lakh be enough?"
  /(\blakhs?\b|\blacs?\b|\bcrores?\b|\brupees\b|₹|\brs\.?\s*\d|\d\s*(l|k)\b).{0,40}\b(enough|sufficient|work for|be ok|be okay|be fine|possible)\b/i,
  /\b(within|fit|in) (my|our|a) budget\b|\bis that (in|within) budget\b/i,
  // Common Hindi / Marathi phrasing heard on Pune calls
  /\bkitna\b|\bkitne\b|\bkharcha\b|\bkiti\b|\bkimat\b|\bkeemat\b|\bpaise lagenge\b/i,
];

const DISCLOSURE_PATTERNS: RegExp[] = [
  // Currency followed by a figure: ₹1,800 / Rs. 2400 / INR 3.5
  /(₹|\brs\.?|\binr\b|\brupees?\b)\s*\d/i,
  // Figure followed by a currency or Indian magnitude word: 3.5 lakh / 2,400 rupees / 8L / 50k
  /\d[\d,.]*\s*(₹|rs\b|inr\b|rupees?\b|lakhs?\b|lacs?\b|crores?\b|cr\b|l\b|k\b)/i,
  // Figure per area unit: 1800 per sq ft / 2,400/sqft
  /\d[\d,.]*\s*(\/|per)\s*(sq|square)/i,
  // Spelled-out magnitudes: "three and a half lakh", "twenty thousand rupees"
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half|few|couple of)\b[\w\s-]{0,20}\b(lakh|lakhs|lac|lacs|crore|crores|thousand rupees|rupees)\b/i,
  // Prohibited phrasings from pricing.md, even before a figure is spoken
  /\b(it('|’)?ll|it will|would|should|may|might|could)\s+cost\s+(around|about|roughly|approximately|somewhere)\b/i,
  /\b(costs?|costing|pricing|prices?)\s+(around|about|roughly|approximately|between|from)\b/i,
  /\b(our\s+)?(rates?|prices?|pricing|packages?|fees?)\s+(start|starts|begin|begins)\b/i,
  /\bfor an? \d\s*bhk,?\s+it('|’)?s typically\b|\btypically costs?\b/i,
  /\b(price|cost|budget)\s+range\s+(is|of|would be)\b/i,
];

export interface PricingCheck {
  violation: boolean;
  matches: string[];
}

export function isPricingRequest(text: string): boolean {
  return REQUEST_PATTERNS.some((p) => p.test(text));
}

/** Detects a prohibited price disclosure in text the agent said or is about to say. */
export function detectPricingDisclosure(text: string): PricingCheck {
  const matches: string[] = [];
  for (const p of DISCLOSURE_PATTERNS) {
    const m = text.match(p);
    if (m) matches.push(m[0]);
  }
  return { violation: matches.length > 0, matches };
}

/**
 * Last line of defence before text is returned to the voice agent. Any candidate answer
 * containing a price disclosure is replaced with the approved deflection.
 */
export function enforcePricingPolicy(candidate: string): { text: string; blocked: boolean; matches: string[] } {
  const check = detectPricingDisclosure(candidate);
  if (check.violation) return { text: PRICING_DEFLECTION, blocked: true, matches: check.matches };
  return { text: candidate, blocked: false, matches: [] };
}
