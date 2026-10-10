import { pct } from "./period";

export interface FunnelCounts {
  incoming: number;
  answered: number;
  failed: number;
  disconnected: number;
  new_enquiries_answered: number;
  new_enquiries_evaluated: number;
  complaints: number;
  green: number;
  amber: number;
  red: number;
  needs_review: number;
  qualified: number;
  booked: number;
  consultation_completed: number;
  deal_opened: number;
  won: number;
  lost: number;
}

export const FUNNEL_STAGES: { key: keyof FunnelCounts; label: string }[] = [
  { key: "incoming", label: "Incoming calls" },
  { key: "answered", label: "Answered calls" },
  { key: "qualified", label: "Eligible qualified leads" },
  { key: "booked", label: "Consultations booked" },
  { key: "consultation_completed", label: "Consultations completed" },
  { key: "deal_opened", label: "Open deals" },
  { key: "won", label: "Closed won" },
];

export function funnelSteps(f: FunnelCounts) {
  return FUNNEL_STAGES.map((s, i) => ({
    ...s,
    count: f[s.key],
    conversion: i === 0 ? null : pct(f[s.key], f[FUNNEL_STAGES[i - 1].key]),
  }));
}

/** The stage-to-stage step with the lowest conversion, among steps with at least 3 entrants. */
export function largestDropOff(f: FunnelCounts) {
  const steps = funnelSteps(f).slice(1);
  let worst: (typeof steps)[number] & { from: string } | null = null;
  steps.forEach((s, i) => {
    const prev = FUNNEL_STAGES[i];
    if (f[prev.key] < 3 || s.conversion === null) return;
    if (!worst || s.conversion < (worst.conversion ?? 1)) worst = { ...s, from: prev.label };
  });
  return worst as ((typeof steps)[number] & { from: string }) | null;
}

export interface Insight {
  /** Stable id so a suggestion can be added to a to-do list or dismissed for today. */
  key: string;
  severity: "critical" | "warning" | "info";
  text: string;
  reason: string;
  href: string;
}

export interface InsightInput {
  funnel: FunnelCounts;
  openComplaints: number;
  overdueComplaints: number;
  pricingViolations: number;
  bookingBacklog: number;
  emailFailures: number;
  hubspotFailures: number;
  unansweredOpen: number;
  integrationsDown: string[];
  upcomingConsultations: number;
  reviewOver24h?: number;
  reviewTotal?: number;
  callbacksOpen?: number;
  openMessages?: number;
}

/**
 * Deterministic observations. Every sentence is built from a counted value and links to the
 * records behind it; nothing is generated that the data doesn't show.
 */
export function buildInsights(i: InsightInput): Insight[] {
  const out: Insight[] = [];
  const plural = (n: number, s: string, p = `${s}s`) => `${n} ${n === 1 ? s : p}`;
  if (i.pricingViolations > 0)
    out.push({ key: "pricing", severity: "critical", text: `Review ${plural(i.pricingViolations, "possible price disclosure")} by the voice agent.`, reason: "Pricing-policy scan flagged agent speech", href: "/exceptions?kind=pricing_violation" });
  if (i.overdueComplaints > 0)
    out.push({ key: "complaints-overdue", severity: "critical", text: `${plural(i.overdueComplaints, "complaint")} past the promised callback time.`, reason: "Complaint exceptions with due time passed", href: "/exceptions?kind=complaint" });
  else if (i.openComplaints > 0)
    out.push({ key: "complaints", severity: "warning", text: `Confirm a senior has called back ${plural(i.openComplaints, "existing-client complaint")}.`, reason: "Open complaint exceptions", href: "/exceptions?kind=complaint" });
  if (i.bookingBacklog > 0)
    out.push({ key: "booking-backlog", severity: "warning", text: `Call back ${plural(i.bookingBacklog, "qualified lead")} who didn't get a consultation booked on the call.`, reason: "Open booking-not-completed / follow-up exceptions", href: "/exceptions?kind=booking_not_completed" });
  if (i.emailFailures > 0)
    out.push({ key: "email-failures", severity: "warning", text: `${plural(i.emailFailures, "confirmation email")} failed — bookings stand, retry the emails.`, reason: "Open email-failure exceptions", href: "/exceptions?kind=email_failure" });
  if (i.hubspotFailures > 0)
    out.push({ key: "hubspot-failures", severity: "warning", text: `${plural(i.hubspotFailures, "lead")} not yet in HubSpot because of sync errors.`, reason: "Open HubSpot-failure exceptions", href: "/exceptions?kind=hubspot_failure" });
  for (const p of i.integrationsDown)
    out.push({ key: `integration-${p}`, severity: "warning", text: `${p} reported an error on its last operation.`, reason: "Integration health", href: "/integrations" });
  if (i.reviewOver24h)
    out.push({ key: "review-24h", severity: "warning", text: `Decide on ${plural(i.reviewOver24h, "enquiry", "enquiries")} that have waited more than 24 hours.`, reason: `${i.reviewTotal ?? i.reviewOver24h} items are waiting on a person`, href: "/exceptions" });
  if (i.openMessages)
    out.push({ key: "messages", severity: "info", text: `Return ${plural(i.openMessages, "message")} left for named designers or the team.`, reason: "Open team messages", href: "/desk" });
  const drop = largestDropOff(i.funnel);
  if (drop && drop.conversion !== null && drop.conversion < 0.5)
    out.push({ key: "drop-off", severity: "info", text: `Biggest drop-off: ${drop.from} → ${drop.label} (${Math.round(drop.conversion * 100)}% convert).`, reason: "Lowest stage-to-stage conversion with ≥3 entrants", href: "/funnel" });
  if (i.unansweredOpen > 0)
    out.push({ key: "unanswered", severity: "info", text: `${plural(i.unansweredOpen, "caller question")} had no approved answer — review them for the knowledge base.`, reason: "Unresolved unanswered questions", href: "/knowledge?tab=unanswered" });
  if (i.funnel.needs_review > 0)
    out.push({ key: "needs-review", severity: "info", text: `${plural(i.funnel.needs_review, "enquiry", "enquiries")} need a human qualification decision.`, reason: "Calls classified needs_review", href: "/exceptions?kind=ambiguous_qualification" });
  return out;
}

/** Plain-language summary assembled from the same counted values. */
export function summarise(i: InsightInput, periodLabel: string): string {
  const f = i.funnel;
  if (f.incoming === 0) return `No live production calls recorded for ${periodLabel}. Metrics will populate as calls arrive.`;
  const parts = [
    `${f.incoming} calls came in (${f.answered} answered${f.failed ? `, ${f.failed} failed or missed` : ""}).`,
    `${f.qualified} leads qualified (${f.green} green, ${f.amber} amber) and ${f.red} were declined as not a fit.`,
    `${f.booked} consultations were booked${i.upcomingConsultations ? `; ${i.upcomingConsultations} are upcoming` : ""}.`,
  ];
  if (f.won) parts.push(`${f.won} deal${f.won === 1 ? "" : "s"} closed won.`);
  if (i.openComplaints) parts.push(`${i.openComplaints} complaint${i.openComplaints === 1 ? " is" : "s are"} open.`);
  return parts.join(" ");
}
