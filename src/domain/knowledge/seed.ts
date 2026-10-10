import { PRICING_DEFLECTION } from "@/domain/pricing/guard";

/**
 * Initial approved runtime knowledge, written from services.md and qualified.md (and the
 * approved deflection from pricing.md). This is the only business content the voice agent may
 * speak. The numeric pricing guide is NOT part of it.
 *
 * Changes after launch happen in the admin Knowledge page (versioned and approved); this file
 * only seeds version 1 via `npm run knowledge:seed-sql`.
 */

export type KnowledgeCategory =
  | "service" | "service_area" | "timeline" | "faq" | "qualification_policy"
  | "pricing_policy" | "fallback" | "escalation_policy" | "brand_voice" | "closure";

export interface SeedArticle {
  slug: string;
  category: KnowledgeCategory;
  title: string;
  keywords: string[];
  spokenAnswer: string;
  source: string;
}

export const FALLBACK_ANSWER =
  "I don't want to give you inaccurate information. I'll note that question for the team, and your designer can clarify it during the consultation.";

export const MULTI_FAIL_CLOSURE =
  "This sounds like it may not be the right fit for us right now — but feel free to reach out if your timeline or scope changes.";

export const SEED_ARTICLES: SeedArticle[] = [
  {
    slug: "greeting",
    category: "brand_voice",
    title: "Greeting",
    keywords: [],
    spokenAnswer: "Hello, thank you for calling Aangan Studio. I'm the studio's virtual assistant. How can I help you today?",
    source: "Brand voice (approved at launch)",
  },
  {
    slug: "services-overview",
    category: "service",
    title: "What Aangan does",
    keywords: ["what do you do", "services", "offer", "interior design", "end to end", "full service", "what kind of work"],
    spokenAnswer:
      "Aangan Studio does end-to-end interior design and execution for homes and small offices across Pune and PCMC — space planning, materials, furniture, lighting, kitchens and wardrobes — and we supervise the execution through our own network of contractors and vendors.",
    source: "services.md §What we do",
  },
  {
    slug: "residential-scope",
    category: "service",
    title: "Residential projects",
    keywords: ["home", "flat", "apartment", "villa", "house", "bhk", "bedroom", "living room", "single room", "one room", "partial", "full home", "kitchen", "wardrobe", "modular"],
    spokenAnswer:
      "For homes, we take on full homes from 2BHK upwards, a full floor or two or more rooms with execution, or a single bedroom or living room when it's a complete redesign with materials, furniture and execution included.",
    source: "services.md §Typical project scope",
  },
  {
    slug: "commercial-scope",
    category: "service",
    title: "Commercial projects",
    keywords: ["office", "commercial", "clinic", "studio", "workstations", "cabin", "reception", "startup", "workspace", "fitout", "fit out"],
    spokenAnswer:
      "We design offices, clinics and studios up to about 3,000 square feet — workstations, cabins, reception and common areas. We don't take on restaurants, hotels, retail stores or gyms.",
    source: "services.md §Commercial projects",
  },
  {
    slug: "not-offered",
    category: "service",
    title: "What we don't do",
    keywords: ["advice", "ideas", "suggestions", "decor", "styling", "colours", "colors", "rearrange", "just consultation", "only advice"],
    spokenAnswer:
      "We're a full-service studio, so our projects include design and execution together. We don't do advice-only visits, decor or styling on its own, standalone furniture sourcing, or standalone Vastu consultations.",
    source: "services.md §What we don't do",
  },
  {
    slug: "vastu",
    category: "faq",
    title: "Vastu",
    keywords: ["vastu", "vaastu"],
    spokenAnswer: "We incorporate Vastu requirements into our designs, but we don't offer standalone Vastu consultations.",
    source: "services.md §What we don't do",
  },
  {
    slug: "structural-work",
    category: "faq",
    title: "Structural work and architecture",
    keywords: ["wall", "walls", "structural", "structure", "architect", "architecture", "permit", "break", "demolish", "extension", "move a wall"],
    spokenAnswer:
      "We're interior designers, not architects, so we don't move walls, change the building structure or handle permits for structural changes.",
    source: "services.md §What we don't do",
  },
  {
    slug: "furniture-sourcing",
    category: "faq",
    title: "Furniture",
    keywords: ["furniture", "sofa", "bed", "dining table", "custom furniture", "buy furniture", "source furniture"],
    spokenAnswer:
      "Furniture design and curation — both custom and sourced — is part of our design projects. We don't source furniture on its own without an associated design project.",
    source: "services.md §What we do / §What we don't do",
  },
  {
    slug: "service-area",
    category: "service_area",
    title: "Service area",
    keywords: ["area", "location", "where", "serve", "pune", "pcmc", "city", "come to", "nashik", "mumbai", "talegaon", "lonavala", "outside pune"],
    spokenAnswer:
      "We work across Pune city and PCMC — areas like Kothrud, Baner, Aundh, Wakad, Koregaon Park, Viman Nagar, Hadapsar, Pimpri, Chinchwad, Ravet and Hinjewadi. We don't currently take projects in Talegaon, Lonavala, Nashik, Mumbai or other cities.",
    source: "services.md §Service area",
  },
  {
    slug: "timeline-process",
    category: "timeline",
    title: "How long a project takes",
    keywords: ["how long", "timeline", "time", "weeks", "months", "duration", "process", "when can", "how soon", "schedule", "steps"],
    spokenAnswer:
      "The design phase usually takes three to four weeks from the first consultation, and execution typically takes eight to sixteen weeks depending on the size of the project and how ready the site is. Your designer will confirm the schedule for your project.",
    source: "services.md §Timelines",
  },
  {
    slug: "minimum-lead-time",
    category: "timeline",
    title: "Urgent projects",
    keywords: ["urgent", "asap", "quickly", "fast", "rush", "before diwali", "guests", "in three weeks", "in a month", "deadline"],
    spokenAnswer:
      "We can't take on a project that needs to be ready in under six weeks from today — design alone takes three to four weeks before execution begins, and we wouldn't want to rush it.",
    source: "services.md §Timelines; qualified.md §3",
  },
  {
    slug: "rented-home",
    category: "faq",
    title: "Rented homes",
    keywords: ["rent", "rented", "renting", "tenant", "lease", "landlord", "rented apartment", "rented flat", "rented home", "rental"],
    spokenAnswer:
      "Yes, we can work on rented homes as long as no structural changes are needed. It's a good idea to check with your landlord as well.",
    source: "qualified.md §What does NOT disqualify",
  },
  {
    slug: "consultation",
    category: "faq",
    title: "The consultation",
    keywords: ["consultation", "meeting", "site visit", "visit", "next step", "how does it work", "first step", "designer come"],
    spokenAnswer:
      "The first step is a consultation with one of our designers, where they understand your brief and the space and walk you through the options in detail. I can book that for you now.",
    source: "services.md §Timelines (design phase starts from first consultation)",
  },
  {
    slug: "undecided-style",
    category: "faq",
    title: "Not sure what they want",
    keywords: ["not sure", "don't know", "style", "ideas yet", "undecided", "materials", "layout", "theme", "look"],
    spokenAnswer:
      "That's completely fine — working out the style, materials and layout is exactly what the consultation is for. Your designer will guide you through it.",
    source: "qualified.md §What does NOT disqualify",
  },
  {
    slug: "pricing-policy",
    category: "pricing_policy",
    title: "Pricing questions (approved deflection)",
    keywords: [],
    spokenAnswer: PRICING_DEFLECTION,
    source: "pricing.md §The only acceptable response to a pricing question",
  },
  {
    slug: "fallback-unknown",
    category: "fallback",
    title: "No approved answer",
    keywords: [],
    spokenAnswer: FALLBACK_ANSWER,
    source: "Runtime answer policy",
  },
  {
    slug: "clarify-execution",
    category: "qualification_policy",
    title: "Clarify: design with execution?",
    keywords: [],
    spokenAnswer: "Just so I understand — are you looking for us to design and carry out the work, or mainly for ideas and advice?",
    source: "qualified.md §1, §At the boundary",
  },
  {
    slug: "clarify-area",
    category: "qualification_policy",
    title: "Clarify: location",
    keywords: [],
    spokenAnswer: "Could you tell me which area the property is in — is it within Pune city or PCMC?",
    source: "qualified.md §2, §At the boundary",
  },
  {
    slug: "clarify-timeline",
    category: "qualification_policy",
    title: "Clarify: timeline",
    keywords: [],
    spokenAnswer: "When would you need the project complete?",
    source: "qualified.md §3",
  },
  {
    slug: "closure-multiple",
    category: "closure",
    title: "Closure: two or more criteria fail",
    keywords: [],
    spokenAnswer: MULTI_FAIL_CLOSURE,
    source: "qualified.md §At the boundary",
  },
  {
    slug: "closure-service-area",
    category: "closure",
    title: "Closure: outside service area",
    keywords: [],
    spokenAnswer:
      "Thank you for thinking of us. We only work in Pune city and PCMC at the moment, because our execution depends on our own contractors being on site, so we won't be able to take this on. I'm sorry we can't help this time.",
    source: "services.md §Service area; qualified.md §2",
  },
  {
    slug: "closure-advice-only",
    category: "closure",
    title: "Closure: advice-only",
    keywords: [],
    spokenAnswer:
      "We're a full-service studio — our projects include design and execution together, so we don't do advice-only or styling visits. If you decide to go ahead with a full redesign with execution, we'd be glad to help.",
    source: "services.md §What we don't do; qualified.md §1",
  },
  {
    slug: "closure-timeline",
    category: "closure",
    title: "Closure: timeline not feasible",
    keywords: [],
    spokenAnswer:
      "Our design phase alone takes three to four weeks, and execution follows, so we couldn't do justice to a project in that time. If your timeline can move, we'd be happy to talk again.",
    source: "services.md §Timelines; qualified.md §3",
  },
  {
    slug: "closure-out-of-scope",
    category: "closure",
    title: "Closure: project type or size out of scope",
    keywords: [],
    spokenAnswer:
      "Thank you for reaching out. That kind of project is outside what we take on — we focus on homes, and on offices, clinics and studios of a certain size. A studio that specialises in that type of space would serve you better.",
    source: "services.md §Commercial projects / §What we don't do",
  },
  {
    slug: "closure-structural",
    category: "closure",
    title: "Closure: structural work",
    keywords: [],
    spokenAnswer:
      "We're interior designers rather than architects, so we can't take on work that involves structural changes. An architect would be the right person to start with.",
    source: "services.md §What we don't do",
  },
  {
    slug: "closure-budget",
    category: "closure",
    title: "Closure: volunteered budget clearly misaligned",
    keywords: [],
    spokenAnswer:
      "I appreciate you sharing that. For the scope you've described with full execution — materials, furniture and contractor work — that budget would be significantly below what a project like this costs with us, and I wouldn't want to bring you to a consultation if the numbers don't align.",
    source: "qualified.md §4",
  },
  {
    slug: "escalation-complaint",
    category: "escalation_policy",
    title: "Existing project complaint",
    keywords: [],
    spokenAnswer:
      "I'm very sorry to hear that. I'll take down your details and pass this to our team as a priority so the right person gets back to you.",
    source: "Escalation policy (T09 precedent); callback times only per configured policy",
  },
  {
    slug: "missed-follow-up",
    category: "escalation_policy",
    title: "Missed follow-up",
    keywords: [],
    spokenAnswer:
      "I'm sorry nobody got back to you — that isn't the experience we want you to have. Let me take your details now and book the consultation directly so it doesn't slip again.",
    source: "Escalation policy (T16 / W08 precedent)",
  },
  {
    slug: "email-request",
    category: "brand_voice",
    title: "Ask for confirmation email",
    keywords: [],
    spokenAnswer: "Could I have an email address to send your booking confirmation to?",
    source: "Booking flow",
  },
  {
    slug: "goodbye",
    category: "brand_voice",
    title: "Closing the call",
    keywords: [],
    spokenAnswer: "Thank you for calling Aangan Studio. Have a lovely day.",
    source: "Brand voice",
  },
];
