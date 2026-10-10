import { z } from "zod";

/**
 * Operational parameters for the qualification rubric. Defaults come from services.md and
 * qualified.md; values marked DERIVED are operational decisions where the sources are silent
 * or ambiguous. All of them are admin-editable (Settings → Qualification) and every change is
 * versioned through `configHash`.
 */
export const QualificationConfigSchema = z.object({
  serviceArea: z.object({
    // services.md lists these explicitly.
    puneLocalities: z.array(z.string()),
    pcmcLocalities: z.array(z.string()),
    // services.md: "We do not currently serve Talegaon, Lonavala, Nashik, Mumbai, or other cities"
    excludedLocalities: z.array(z.string()),
  }),
  commercial: z.object({
    // services.md: "up to approximately 3,000 sq ft"
    maxSqft: z.number().int().positive(),
    // DERIVED: how far "approximately" stretches before a commercial project fails scope.
    maxSqftTolerancePct: z.number().min(0).max(50),
    // DERIVED from front-desk practice in transcript T18 ("typically 500 sq ft or more").
    // Not stated in services.md — confirm with the founder.
    minSqft: z.number().int().min(0),
  }),
  // services.md: "Restaurants, hotels, retail stores, gyms: out of scope." (+ coworking pods are judged by size)
  excludedPropertyTypes: z.array(z.string()),
  timeline: z.object({
    // services.md: cannot begin a project that needs to be ready in under 6 weeks.
    hardMinWeeks: z.number().positive(),
    // DERIVED: design 3–4 weeks + execution from 8 weeks (services.md) = 11 weeks minimum.
    realisticMinWeeks: z.number().positive(),
    // What to do between hardMinWeeks and realisticMinWeeks: a designer judges it, or decline.
    tightTimelinePolicy: z.enum(["review", "fail"]),
  }),
  budget: z.object({
    // DERIVED: qualified.md's example "₹1–1.5 lakh for a full flat redesign" is clearly below
    // any scope with execution. A volunteered maximum below this floor fails criterion 4.
    // Internal-only threshold; never spoken to a customer.
    clearlyInsufficientBelowInr: z.number().int().positive(),
    // qualified.md: "If budget is not mentioned, treat as qualified." Off by default.
    notMentionedIsUncertain: z.boolean(),
  }),
});
export type QualificationConfig = z.infer<typeof QualificationConfigSchema>;

export const RULES_VERSION = "2026-10-10.1";

export const DEFAULT_QUALIFICATION_CONFIG: QualificationConfig = {
  serviceArea: {
    puneLocalities: [
      // services.md
      "kothrud", "baner", "aundh", "wakad", "koregaon park", "kalyani nagar", "viman nagar",
      "hadapsar", "magarpatta", "nibm", "kondhwa", "undri", "shivane", "warje", "erandwane", "deccan",
      // DERIVED: inside Pune city limits ("and adjoining areas")
      "kharadi", "nanded city", "bavdhan", "pashan", "balewadi", "shivajinagar", "camp", "yerawada",
      "dhanori", "katraj", "bibwewadi", "sinhagad road", "dhayari", "karve nagar", "sus road",
      "mundhwa", "wanowrie", "fatima nagar", "salunke vihar", "sopan baug", "prabhat road",
      "model colony", "sadashiv peth", "swargate", "market yard", "parvati", "sahakar nagar",
      "dahanukar colony", "sunderban", "cybercity", "boat club road", "east street", "pune city",
    ],
    pcmcLocalities: [
      // services.md
      "pimpri", "chinchwad", "pimple saudagar", "pimple nilakh", "ravet", "hinjewadi",
      // DERIVED: PCMC wards
      "pimple gurav", "akurdi", "nigdi", "bhosari", "moshi", "chikhali", "tathawade", "punawale",
      "kalewadi", "thergaon", "sangvi", "rahatani", "dapodi", "pimpri chinchwad", "pcmc",
    ],
    excludedLocalities: [
      "talegaon", "lonavala", "nashik", "mumbai", "thane", "navi mumbai", "satara", "nagpur",
      "aurangabad", "kolhapur", "bangalore", "bengaluru", "hyderabad", "delhi", "goa",
      "chakan", "shirur", "baramati", "khandala", "kamshet",
    ],
  },
  commercial: { maxSqft: 3000, maxSqftTolerancePct: 10, minSqft: 500 },
  excludedPropertyTypes: ["restaurant", "hotel", "retail", "gym"],
  timeline: { hardMinWeeks: 6, realisticMinWeeks: 11, tightTimelinePolicy: "review" },
  budget: { clearlyInsufficientBelowInr: 200000, notMentionedIsUncertain: false },
};

/** Stable short hash of the config so each stored evaluation records which rules it ran on. */
export function configHash(config: QualificationConfig): string {
  const json = JSON.stringify(config, Object.keys(flatten(config)).sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function flatten(obj: unknown, out: Record<string, true> = {}): Record<string, true> {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      out[k] = true;
      flatten(v, out);
    }
  }
  return out;
}
