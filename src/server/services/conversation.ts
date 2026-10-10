import { z } from "zod";
import type { JsonModel } from "@/integrations/gemini/client";
import { LeadFactsSchema, type CriterionKey, type LeadFacts } from "@/domain/qualification/types";
import { evaluate } from "@/domain/qualification/engine";
import { loadQualificationConfig } from "@/server/settings";
import { isPricingRequest, PRICING_DEFLECTION } from "@/domain/pricing/guard";
import { normaliseEmail, normalisePhone } from "@/lib/phone";
import {
  answerLive,
  availabilityLive,
  bookLive,
  BookingRefused,
  ensureLiveCall,
  escalateLive,
  evaluateLive,
  saveIntake,
  takeMessageLive,
  type LiveDeps,
} from "./live-call";

/**
 * The enquiry conversation, following the flow map:
 *   ② answer → ③ collect inputs one at a time → ④ answer from approved knowledge →
 *   ⑤ understand / extract / evaluate → ⑥ Red / Amber / Green → availability → booking → ⑦ outputs.
 *
 * Gemini only UNDERSTANDS each caller turn (intent + structured fields). Everything the agent SAYS
 * comes from the server: approved knowledge, the approved pricing reply, the rules engine's
 * clarifying question or closure, and the booking/escalation services. The agent can't improvise
 * business facts or prices.
 */

export type Stage = "intent" | "collecting" | "offer_booking" | "choosing_slot" | "email" | "complaint" | "message" | "closed";

export interface Trace {
  step: "understand" | "extract" | "answer" | "evaluate" | "decide" | "availability" | "book" | "escalate" | "message" | "close";
  detail: string;
  at: string;
}

export interface Turn {
  role: "agent" | "caller";
  text: string;
  at: string;
}

export interface ConversationState {
  stage: Stage;
  intent: "new_enquiry" | "existing_project_complaint" | "message_for_team" | "existing_lead_follow_up" | "general_question" | "unknown";
  facts: Partial<LeadFacts>;
  contact: { name?: string | null; phone?: string | null; email?: string | null };
  asked: string[];
  lastAsked: string | null;
  clarificationsAsked: CriterionKey[];
  qualification: { status: string; uncertainties: string[]; closure?: string | null; leadId?: string } | null;
  slots: { start: string; designerId: string; label: string; designer: string }[];
  complaint: { issue?: string | null; designer?: string | null } | null;
  message: { forName?: string | null; about?: string | null; type?: string; window?: string | null } | null;
  outcome: string | null;
  turns: Turn[];
  trace: Trace[];
}

export const GREETING = "Hello, thank you for calling Aangan Studio. I'm the studio's virtual assistant. How can I help you today?";

export function newState(): ConversationState {
  return {
    stage: "intent", intent: "unknown", facts: {}, contact: {}, asked: [], lastAsked: null, clarificationsAsked: [],
    qualification: null, slots: [], complaint: null, message: null, outcome: null,
    turns: [{ role: "agent", text: GREETING, at: new Date().toISOString() }], trace: [],
  };
}

// ---------------------------------------------------------------------------
// ⑤ Understand & extract (Gemini, structured output)
// ---------------------------------------------------------------------------

export const UnderstandingSchema = z.object({
  intent: z.enum(["new_enquiry", "existing_project_complaint", "message_for_team", "existing_lead_follow_up", "general_question", "goodbye", "unclear"]),
  facts: LeadFactsSchema.partial(),
  name: z.string().max(120).nullable(),
  phone: z.string().max(40).nullable(),
  email: z.string().max(200).nullable(),
  question: z.string().max(300).nullable().describe("A question the caller asked that needs an answer, verbatim"),
  wantsBooking: z.boolean().nullable(),
  slotChoice: z.number().int().min(1).max(5).nullable().describe("1-based index of the offered slot the caller picked"),
  complaintIssue: z.string().max(500).nullable(),
  designerName: z.string().max(120).nullable(),
  messageFor: z.string().max(120).nullable(),
  messageAbout: z.string().max(500).nullable(),
  callbackWindow: z.string().max(120).nullable(),
  declined: z.boolean().describe("Caller declined or didn't know the answer to what was just asked"),
});
export type Understanding = z.infer<typeof UnderstandingSchema>;

const UNDERSTAND_SYSTEM = `You understand one caller turn in a phone call to Aangan Studio (interior design + execution, Pune).
Return JSON only. Extract ONLY what the caller said in this turn (use null / "unknown" otherwise). Never invent.
- intent: new_enquiry (wants interiors done), existing_project_complaint (existing client unhappy), message_for_team (wants a specific person / leaving a message or project update), existing_lead_follow_up (enquired before, nobody called back), general_question, goodbye (ending the call), unclear.
- facts: same meanings as the qualification fields. intent "design_and_execution" when they want rooms/home/office redone, designed and built, or fitted out; "advice_only" if they only want ideas/suggestions or will execute themselves. requiredCompletionDate as YYYY-MM-DD resolved from today's date given (month-only = last day of that month, next occurrence). timelineFlexible true for "no rush"/"flexible". budgetMentioned only if they volunteered a figure; budgetMaxInr in rupees (1 lakh = 100000). decisionMaker "self" if they decide (with spouse is fine), "authorised_representative" if the decision-maker said go ahead, "researching_for_others" if checking for family who decide.
- Short answers apply to the question just asked (given as lastAsked): e.g. lastAsked=location and "Kothrud" → facts.locationText "Kothrud".
- slotChoice: if offered slots are listed and the caller picks one ("the second", "Tuesday at 11"), give its 1-based index.
- wantsBooking: true if they agree to a consultation/visit, false if they decline.
- declined: true if they say they don't know / prefer not to say to the question just asked.`;

export async function understand(model: JsonModel, state: ConversationState, utterance: string, today: string): Promise<Understanding> {
  const recent = state.turns.slice(-6).map((t) => `${t.role === "agent" ? "Agent" : "Caller"}: ${t.text}`).join("\n");
  const offered = state.slots.length ? `\nOffered slots: ${state.slots.map((s, i) => `${i + 1}) ${s.label}`).join("; ")}` : "";
  const { data } = await model.generateJson({
    system: UNDERSTAND_SYSTEM,
    prompt: `Today (Asia/Kolkata): ${today}\nlastAsked: ${state.lastAsked ?? "none"}${offered}\nKnown so far: ${JSON.stringify({ ...state.facts, ...state.contact })}\n\nRecent conversation:\n${recent}\n\nCaller now: ${utterance}`,
    schema: UnderstandingSchema,
    maxOutputTokens: 4096,
  });
  return data;
}

// ---------------------------------------------------------------------------
// ③ Inputs collected — one question at a time, never budget
// ---------------------------------------------------------------------------

export const INPUTS: { key: string; label: string; question: string; known: (s: ConversationState) => boolean; optional?: boolean }[] = [
  { key: "name", label: "Name", question: "May I have your name, please?", known: (s) => !!s.contact.name },
  { key: "location", label: "Location", question: "Which area is the property in?", known: (s) => !!s.facts.locationText },
  { key: "segment", label: "Home / office", question: "Is this for a home or an office?", known: (s) => !!s.facts.segment && s.facts.segment !== "unknown" },
  { key: "scope", label: "Project & scope", question: "What would you like done — the whole home, a few rooms, or a full fit-out — and should we handle the execution too?", known: (s) => (!!s.facts.scopeKind && s.facts.scopeKind !== "unknown") || (!!s.facts.intent && s.facts.intent !== "unknown") },
  { key: "area", label: "Size (sq ft)", question: "Roughly how big is the space, in square feet?", known: (s) => s.facts.areaSqft != null, optional: true },
  { key: "timeline", label: "Timeline", question: "When would you need the project complete?", known: (s) => !!s.facts.requiredCompletionDate || s.facts.timelineFlexible === true },
  { key: "decision", label: "Decision-maker", question: "Will you be making the decision on this, or is someone else involved?", known: (s) => !!s.facts.decisionMaker && s.facts.decisionMaker !== "unknown", optional: true },
  { key: "phone", label: "Callback number", question: "What's the best number to reach you on?", known: (s) => !!normalisePhone(s.contact.phone) },
];

function nextInput(s: ConversationState) {
  return INPUTS.find((f) => !f.known(s) && !(s.asked.includes(f.key) && (f.optional || f.key === "timeline")));
}

const ACKS = ["Thank you.", "Got it.", "That's helpful.", "Thanks."];

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export interface TurnDeps {
  live: LiveDeps;
  model: JsonModel;
  /** Post-call processing once the conversation ends (transcript, summary, outputs). */
  finalize?: (callId: string, state: ConversationState) => Promise<void>;
}

function mergeFacts(s: ConversationState, u: Understanding) {
  for (const [k, v] of Object.entries(u.facts)) {
    if (v === null || v === undefined || v === "unknown") continue;
    if (k === "budgetMentioned" && v === false) continue;
    (s.facts as Record<string, unknown>)[k] = v;
  }
  if (u.name) s.contact.name = u.name;
  if (u.phone) s.contact.phone = u.phone;
  const email = normaliseEmail(u.email);
  if (email) s.contact.email = email;
}

export async function handleTurn(deps: TurnDeps, callId: string, state: ConversationState, utterance: string): Promise<{ say: string; state: ConversationState; done: boolean }> {
  const s: ConversationState = structuredClone(state);
  const now = deps.live.now();
  const at = now.toISOString();
  const trace = (step: Trace["step"], detail: string) => s.trace.push({ step, detail, at: new Date().toISOString() });
  s.turns.push({ role: "caller", text: utterance, at });
  const parts: string[] = [];

  const u = await understand(deps.model, s, utterance, at.slice(0, 10));
  trace("understand", `intent: ${u.intent}${u.question ? ` · asked: “${u.question}”` : ""}`);
  mergeFacts(s, u);
  if (s.lastAsked && !s.asked.includes(s.lastAsked)) s.asked.push(s.lastAsked);
  const got = Object.entries(u.facts).filter(([, v]) => v != null && v !== "unknown" && v !== false).map(([k]) => k).concat(u.name ? ["name"] : [], u.phone ? ["phone"] : [], u.email ? ["email"] : []);
  if (got.length) trace("extract", `captured ${got.join(", ")}`);

  if (s.stage === "intent" || (s.intent === "unknown" && u.intent !== "unclear")) {
    if (u.intent === "existing_project_complaint") s.intent = "existing_project_complaint";
    else if (u.intent === "message_for_team") s.intent = "message_for_team";
    else if (u.intent === "new_enquiry" || u.intent === "existing_lead_follow_up") s.intent = u.intent;
    else if (u.intent === "general_question" && s.intent === "unknown") s.intent = "general_question";
  }
  if (u.complaintIssue) s.complaint = { ...(s.complaint ?? {}), issue: u.complaintIssue, designer: u.designerName ?? s.complaint?.designer ?? null };
  if (u.messageAbout || u.messageFor) s.message = { ...(s.message ?? {}), forName: u.messageFor ?? s.message?.forName ?? null, about: u.messageAbout ?? s.message?.about ?? null, window: u.callbackWindow ?? s.message?.window ?? null };

  // ④ Answer from approved knowledge first (pricing always gets the approved reply).
  if (u.question || isPricingRequest(utterance)) {
    const a = await answerLive(deps.live, { call_id: callId, question: u.question ?? utterance });
    trace("answer", a.kind === "pricing_deflection" ? "pricing question → approved reply" : a.kind === "fallback" ? "no approved answer → fallback, logged for review" : `approved answer: ${a.article}`);
    parts.push(a.say === PRICING_DEFLECTION && s.stage === "offer_booking" ? PRICING_DEFLECTION : a.say);
  }

  if (u.intent === "goodbye" && s.stage !== "email" && s.stage !== "choosing_slot") {
    return close(deps, callId, s, parts, "Thank you for calling Aangan Studio. Have a lovely day.", s.outcome ?? "caller ended");
  }

  // Existing-client complaint → stop sales questions, collect, escalate.
  if (s.intent === "existing_project_complaint") {
    s.stage = "complaint";
    if (!s.complaint?.issue) return ask(s, parts, "complaint_issue", "I'm very sorry to hear that. Could you tell me briefly what's happened?");
    if (!s.contact.name) return ask(s, parts, "name", "I'm sorry about this. May I have your name, please?");
    if (!normalisePhone(s.contact.phone)) return ask(s, parts, "phone", "What's the best number for a senior team member to call you back on?");
    const e = await escalateLive(deps.live, { call_id: callId, type: "complaint", name: s.contact.name, callback_phone: s.contact.phone, issue: s.complaint.issue, designer_name: s.complaint.designer ?? null, project_location: s.facts.locationText ?? null });
    trace("escalate", `complaint logged as priority${e.callback_promise ? ` · callback ${e.callback_promise}` : " · no callback time promised"}`);
    return close(deps, callId, s, parts, e.say, "complaint escalated");
  }

  // Message for a named person / project update.
  if (s.intent === "message_for_team") {
    s.stage = "message";
    if (!s.message?.about) return ask(s, parts, "message_about", "Of course. What would you like me to pass on?");
    if (!s.contact.name) return ask(s, parts, "name", "And may I have your name?");
    if (!normalisePhone(s.contact.phone)) return ask(s, parts, "phone", "What's the best number to call you back on, and when are you usually free?");
    const m = await takeMessageLive(deps.live, { call_id: callId, name: s.contact.name, callback_phone: s.contact.phone, message_type: s.message.forName ? "designer_request" : "other", for_name: s.message.forName ?? null, about: s.message.about, callback_window: s.message.window ?? null });
    trace("message", `message for ${m.routed_to ?? "the team"} recorded`);
    return close(deps, callId, s, parts, m.say, "message taken");
  }

  if (s.intent === "unknown" || s.intent === "general_question") {
    if (!parts.length) parts.push("I'd be glad to help.");
    return ask(s, parts, "intent", "Are you looking to get interiors done for a home or office?");
  }

  // ③ New enquiry: collect inputs, then evaluate.
  if (s.stage === "intent" || s.stage === "collecting") {
    s.stage = "collecting";
    await saveIntake(deps.live, { call_id: callId, name: s.contact.name ?? null, callback_phone: s.contact.phone ?? null, email: s.contact.email ?? null, location: s.facts.locationText ?? null, area_sqft: s.facts.areaSqft ?? null, timeline_text: s.facts.timelineText ?? null, budget_text: s.facts.budgetText ?? null, is_rented: s.facts.isRented ?? null, call_type: s.intent === "existing_lead_follow_up" ? "existing_lead_follow_up" : "new_enquiry" });
    if (s.intent === "existing_lead_follow_up" && !s.asked.includes("apology")) {
      s.asked.push("apology");
      parts.unshift("I'm sorry nobody got back to you — let me take your details now so it doesn't slip again.");
    }

    // A clear failure ends the call early (checked without saving); otherwise evaluate once all inputs are in.
    const next = nextInput(s);
    if (next) {
      const preview = evaluate({ facts: LeadFactsSchema.parse(s.facts), config: await loadQualificationConfig(deps.live.store), clarificationsAsked: s.clarificationsAsked, now });
      if (preview.status !== "red") return ask(s, parts, next.key, `${ACKS[s.turns.length % ACKS.length]} ${next.question}`);
    }
    const r = await evaluateLive(deps.live, {
      call_id: callId, name: s.contact.name ?? null, callback_phone: s.contact.phone ?? null, email: s.contact.email ?? null,
      facts: s.facts, clarifications_asked: s.clarificationsAsked,
    });
    if (r.status === "red") {
      trace("evaluate", "rules: RED — not a fit");
      s.qualification = { status: "red", uncertainties: r.uncertainties, closure: r.closure_text, leadId: r.lead_id };
      trace("decide", "polite closure · logged as not qualified");
      return close(deps, callId, s, parts, r.closure_text ?? "Thank you for thinking of us.", "declined");
    }
    if (r.status === "needs_clarification" && r.next_question && r.next_criterion) {
      trace("evaluate", `rules: ${r.next_criterion.replace("_", " ")} unclear → one direct question`);
      s.clarificationsAsked.push(r.next_criterion);
      return ask(s, parts, "clarify", r.next_question);
    }
    if (r.status === "needs_review" || r.status === "needs_clarification") {
      trace("evaluate", "rules: needs a designer's judgement");
      s.qualification = { status: "needs_review", uncertainties: r.uncertainties, leadId: r.lead_id };
      trace("decide", "sent to the Decisions queue for a designer");
      return close(deps, callId, s, parts, "Thank you — I've noted everything. One of our designers will review your project and call you back.", "needs review");
    }
    s.qualification = { status: r.status, uncertainties: r.uncertainties, leadId: r.lead_id };
    trace("evaluate", `rules: ${r.status.toUpperCase()}${r.uncertainties.length ? ` (to clarify with the designer: ${r.uncertainties.join(", ").replace(/_/g, " ")})` : ""}`);
    s.stage = "offer_booking";
    trace("decide", "qualified → offer a consultation");
    return ask(s, parts, "booking", "From what you've told me, this sounds like a good fit for us. Would you like me to book a consultation with one of our designers?");
  }

  // ⑥ Check availability → offer slots.
  if (s.stage === "offer_booking") {
    if (u.wantsBooking === false) {
      trace("decide", "caller declined booking → front desk will follow up");
      return close(deps, callId, s, parts, "No problem at all. The team will be in touch, and you're welcome to call back any time.", "qualified, not booked");
    }
    if (u.wantsBooking !== true && !parts.length) return ask(s, parts, "booking", "Shall I book a consultation with one of our designers for you?");
    if (u.wantsBooking !== true) return ask(s, parts, "booking", "Would you like me to book that consultation now?");
    try {
      const a = await availabilityLive(deps.live, { call_id: callId });
      trace("availability", a.status === "ok" ? `${a.slots.length} real slot(s) from designer calendars` : a.status === "none" ? "calendars read — no free slots" : "calendars unavailable → callback task created");
      if (a.status !== "ok") return close(deps, callId, s, parts, a.say, "qualified, booking unavailable");
      s.slots = a.slots.map((x) => ({ start: x.start, designerId: x.designerId, label: x.label, designer: x.designer_name }));
      s.stage = "choosing_slot";
      return ask(s, parts, "slot", a.say);
    } catch (e) {
      if (e instanceof BookingRefused) return close(deps, callId, s, parts, "I'll ask the team to call you to arrange a time.", "booking refused");
      throw e;
    }
  }

  if (s.stage === "choosing_slot") {
    const pick = u.slotChoice ? s.slots[u.slotChoice - 1] : null;
    if (!pick) return ask(s, parts, "slot", `Which of these suits you: ${s.slots.map((x) => x.label).join(", or ")}?`);
    s.slots = [pick];
    if (!s.contact.email) { s.stage = "email"; return ask(s, parts, "email", "Lovely. Could I have an email address to send your booking confirmation to?"); }
  }

  if (s.stage === "email" && !s.contact.email && !u.declined) return ask(s, parts, "email", "Sorry, I didn't catch that — could you spell the email address for me?");

  if ((s.stage === "email" || s.stage === "choosing_slot") && s.slots[0]) {
    const slot = s.slots[0];
    const b = await bookLive(deps.live, { call_id: callId, slot_start: slot.start, designer_id: slot.designerId, name: s.contact.name ?? null, email: s.contact.email ?? null, idempotency_key: `conv:${callId}:${slot.start}` });
    trace("book", b.status === "confirmed" ? `calendar event created with ${b.designer_name ?? "designer"} → confirmation email, HubSpot sync and designer brief queued` : `booking ${b.status}`);
    if (b.status === "conflict") { s.slots = b.alternatives.map((x) => ({ start: x.start, designerId: x.designerId, label: x.label, designer: x.designer_name })); s.stage = "choosing_slot"; return ask(s, parts, "slot", b.say); }
    return close(deps, callId, s, parts, `${b.say}${b.status === "confirmed" && s.contact.email ? ` I've got your email as ${s.contact.email}.` : ""} Thank you for calling Aangan Studio.`, b.status === "confirmed" ? "booked" : "booking failed");
  }

  return ask(s, parts, s.lastAsked ?? "intent", "Sorry, could you say that again?");
}

function ask(s: ConversationState, parts: string[], key: string, question: string) {
  s.lastAsked = key;
  const say = [...parts, question].join(" ").trim();
  s.turns.push({ role: "agent", text: say, at: new Date().toISOString() });
  return { say, state: s, done: false };
}

async function close(deps: TurnDeps, callId: string, s: ConversationState, parts: string[], closing: string, outcome: string) {
  s.stage = "closed";
  s.outcome = outcome;
  const say = [...parts, closing].join(" ").trim();
  s.turns.push({ role: "agent", text: say, at: new Date().toISOString() });
  s.trace.push({ step: "close", detail: `call ended · ${outcome}`, at: new Date().toISOString() });
  await deps.finalize?.(callId, s);
  return { say, state: s, done: true };
}

/** Starts a conversation record (a test call when isTest). */
export async function startConversation(deps: LiveDeps, callId: string) {
  const call = await ensureLiveCall(deps, callId, null);
  const state = newState();
  await deps.store.updateCall(call.id, { call_type: "unknown", intake: { ...call.intake, conversation: state } });
  return { call, state };
}

/** ③ Inputs collected, for display: what's known so far and its value. Budget only if volunteered. */
export function inputSummary(s: ConversationState) {
  const f = s.facts;
  const value: Record<string, string | null> = {
    name: s.contact.name ?? null,
    location: f.locationText ?? null,
    segment: f.segment && f.segment !== "unknown" ? f.segment : null,
    scope: [f.scopeKind && f.scopeKind !== "unknown" ? f.scopeKind.replace("_", " ") : null, f.propertyType && f.propertyType !== "unknown" ? f.propertyType.replace("_", " ") : null, f.executionIncluded ? "with execution" : f.intent === "advice_only" ? "advice only" : null].filter(Boolean).join(" · ") || null,
    area: f.areaSqft ? `${f.areaSqft} sq ft` : null,
    timeline: f.requiredCompletionDate ? `by ${f.requiredCompletionDate}` : f.timelineFlexible ? "flexible" : f.timelineText ?? null,
    decision: f.decisionMaker && f.decisionMaker !== "unknown" ? f.decisionMaker.replace(/_/g, " ") : null,
    phone: s.contact.phone ?? null,
  };
  const rows = INPUTS.map((i) => ({ key: i.key, label: i.label, done: i.known(s), value: value[i.key] ?? null, skipped: !i.known(s) && s.asked.includes(i.key) }));
  rows.push({ key: "email", label: "Email (for confirmation)", done: !!s.contact.email, value: s.contact.email ?? null, skipped: false });
  rows.push({ key: "budget", label: "Budget (only if volunteered)", done: !!f.budgetMentioned, value: f.budgetText ?? (f.budgetMaxInr ? `up to ₹${f.budgetMaxInr.toLocaleString("en-IN")}` : null), skipped: false });
  return rows;
}
