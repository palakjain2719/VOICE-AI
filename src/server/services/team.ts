import { formatInTimeZone } from "date-fns-tz";
import { normalisePhone } from "@/lib/phone";
import { safeErrorMessage } from "@/lib/log";
import type { EmailSender } from "@/integrations/resend/email";
import type { LeadRow, Store, TeamMessageInput } from "@/server/store/types";
import { RetryableError } from "./confirmation";

export interface TeamDeps {
  store: Store;
  sender: EmailSender | null;
  appBaseUrl: string | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function designerBrief(lead: LeadRow, extra: { summary: string | null; appointment: string | null; hubspotUrl: string | null }): string {
  const u = (lead.uncertainties ?? []) as { detail?: string }[];
  return [
    `Caller: ${lead.name ?? "not given"}${lead.phone_normalized ? ` · ${lead.phone_normalized}` : ""}${lead.email ? ` · ${lead.email}` : ""}`,
    extra.appointment && `Consultation: ${extra.appointment}`,
    lead.project_type && `Project: ${lead.project_type}`,
    lead.project_scope && `Scope: ${lead.project_scope}`,
    lead.property_area_sqft && `Area: ${lead.property_area_sqft} sq ft`,
    lead.location && `Location: ${lead.location}`,
    lead.current_property_state && `Current state: ${lead.current_property_state}`,
    lead.timeline && `Timeline: ${lead.timeline}`,
    lead.decision_maker_status && `Decision-maker: ${lead.decision_maker_status.replace(/_/g, " ")}`,
    lead.is_rented != null && `Rented: ${lead.is_rented ? "yes (no structural changes)" : "no"}`,
    lead.budget_volunteered && `Budget mentioned by caller: ${lead.budget_notes ?? "yes"}`,
    `Qualification: ${lead.qualification_status.toUpperCase()}`,
    u.length ? `To clarify: ${u.map((x) => x.detail).join(" ")}` : null,
    extra.summary && `Call summary: ${extra.summary}`,
    extra.hubspotUrl && `HubSpot: ${extra.hubspotUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Designer handoff: emails the assigned designer the brief so they never re-ask what the caller
 * already said. Records handoff_at (used for "time to designer handoff").
 */
export async function handoffToDesigner(deps: TeamDeps, leadId: string, appointmentId: string | null): Promise<"sent" | "already" | "no_channel"> {
  const { store } = deps;
  const lead = await store.getLead(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  if (lead.handoff_at && lead.handoff_channel === "email") return "already";
  const designer = lead.assigned_designer_id ? await store.getDesigner(lead.assigned_designer_id) : null;
  if (!designer?.email || !deps.sender) return "no_channel";
  const appt = appointmentId ? await store.getAppointment(appointmentId) : null;
  const call = lead.last_call_id ? await store.getCall(lead.last_call_id) : null;
  const when = appt ? formatInTimeZone(new Date(appt.start_at), appt.timezone, "EEEE d MMMM, h:mm a") : null;
  const text = designerBrief(lead, { summary: call?.summary ?? null, appointment: when, hubspotUrl: null });
  try {
    await deps.sender.send({
      to: designer.email,
      subject: `New consultation${when ? ` ${when}` : ""}: ${lead.name ?? "new client"}${lead.locality ? `, ${lead.locality}` : ""}`,
      text: `${text}\n\n${deps.appBaseUrl ? `Call record: ${deps.appBaseUrl}/calls/${lead.last_call_id}` : ""}`,
      html: `<pre style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;white-space:pre-wrap">${esc(text)}</pre>`,
      idempotencyKey: `handoff-${lead.id}-${appointmentId ?? "lead"}`,
    });
  } catch (e) {
    throw new RetryableError(`Designer handoff email failed: ${safeErrorMessage(e)}`);
  }
  await store.updateLead(lead.id, { handoff_at: new Date().toISOString(), handoff_channel: "email" });
  return "sent";
}

/** A message for the team (existing client, named designer, callback). Routed to the named designer if unambiguous. */
export async function recordTeamMessage(store: Store, input: Omit<TeamMessageInput, "for_designer_id"> & { for_designer_id?: string | null }) {
  const designer = input.for_designer_id ? await store.getDesigner(input.for_designer_id) : input.for_name ? await store.findDesignerByName(input.for_name) : null;
  const r = await store.insertTeamMessage({ ...input, caller_phone: normalisePhone(input.caller_phone) ?? input.caller_phone, for_designer_id: designer?.id ?? null });
  if (r.created && designer?.email) await store.enqueueJob("notify_message", { message_id: r.id }, `message:${r.id}`);
  return { ...r, designer };
}

export async function deliverTeamMessage(deps: TeamDeps, messageId: string) {
  const m = await deps.store.getTeamMessage(messageId);
  if (!m) throw new Error("Message not found");
  const designer = m.for_designer_id ? await deps.store.getDesigner(m.for_designer_id) : null;
  if (!designer?.email || !deps.sender) return "no_channel" as const;
  const text = [`Message for ${designer.name}`, `From: ${m.caller_name ?? "caller"}${m.caller_phone ? ` · ${m.caller_phone}` : ""}`, `About: ${m.about}`, m.callback_window && `Best time to call back: ${m.callback_window}`]
    .filter(Boolean)
    .join("\n");
  await deps.sender.send({ to: designer.email, subject: `Message from ${m.caller_name ?? "a caller"}`, text, html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${esc(text)}</pre>`, idempotencyKey: `message-${messageId}` });
  await deps.store.markTeamMessageDelivered(messageId, "email");
  return "sent" as const;
}

/** Polite closing email after a human declines an enquiry, using the approved closure text. */
export async function sendClosureEmail(deps: TeamDeps, leadId: string, slug: string) {
  const lead = await deps.store.getLead(leadId);
  if (!lead?.email || !deps.sender) return "no_channel" as const;
  const article = (await deps.store.listPublishedArticles()).find((a) => a.slug === slug);
  if (!article) throw new Error(`Closure ${slug} not published`);
  const text = `${lead.name ? `Dear ${lead.name},` : "Hello,"}\n\nThank you for contacting Aangan Studio. ${article.spokenAnswer}\n\nWarm regards,\nAangan Studio`;
  await deps.sender.send({ to: lead.email, subject: "Your enquiry with Aangan Studio", text, html: `<p>${esc(text).replace(/\n/g, "<br/>")}</p>`, idempotencyKey: `closure-${leadId}` });
  return "sent" as const;
}
