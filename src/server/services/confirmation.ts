import { EmailError, renderConfirmationEmail, type EmailSender } from "@/integrations/resend/email";
import { safeErrorMessage } from "@/lib/log";
import { loadConfirmationPolicy } from "@/server/settings";
import type { Store } from "@/server/store/types";

export class RetryableError extends Error {}

/**
 * Sends the confirmation for an appointment that is already confirmed in the calendar.
 * A failure here never touches the booking; it is retried by the job queue and surfaced in
 * the exception queue.
 */
export async function sendConsultationConfirmation(
  deps: { store: Store; sender: EmailSender | null },
  appointmentId: string,
): Promise<"sent" | "already_sent" | "not_possible" | "not_confirmed"> {
  const { store } = deps;
  const appt = await store.getAppointment(appointmentId);
  if (!appt) throw new Error(`Appointment ${appointmentId} not found`);
  if (appt.status !== "confirmed") return "not_confirmed";
  if (appt.confirmation_email_status === "sent") return "already_sent";
  const lead = await store.getLead(appt.lead_id);
  if (!lead) throw new Error(`Lead ${appt.lead_id} not found`);
  const policy = await loadConfirmationPolicy(store);

  if (!lead.email) {
    await store.updateAppointment(appt.id, { confirmation_email_status: "not_possible" });
    if (policy.noEmailFallback === "manual_phone_confirmation") {
      await store.upsertException({
        kind: "missing_information", severity: "normal", lead_id: lead.id, appointment_id: appt.id, dedupe_key: `no-email:${appt.id}`, is_test: appt.is_test,
        title: `Confirm consultation by phone: ${lead.name ?? "customer"}`,
        detail: "No email address was collected, so no confirmation email was sent. Call the customer to confirm the booking.",
      });
    }
    return "not_possible";
  }
  if (!deps.sender) {
    await store.updateAppointment(appt.id, { confirmation_email_status: "failed" });
    throw new RetryableError("Resend is not configured (RESEND_API_KEY / EMAIL_FROM)");
  }

  const designer = appt.designer_id ? await store.getDesigner(appt.designer_id) : null;
  const msg = renderConfirmationEmail({
    customerName: lead.name,
    startIso: appt.start_at,
    endIso: appt.end_at,
    timezone: appt.timezone,
    designerName: designer?.name ?? null,
    meetingType: appt.meeting_type as "site_visit" | "studio" | "video",
    location: lead.location,
    contactLine: policy.rescheduleContactLine,
  });
  try {
    const { id } = await deps.sender.send({ to: lead.email, ...msg, idempotencyKey: `confirmation-${appt.id}` });
    await store.updateAppointment(appt.id, { confirmation_email_status: "sent", confirmation_email_sent_at: new Date().toISOString(), confirmation_email_provider_id: id });
    await store.recordIntegrationHealth("resend", true, "emails.send");
    return "sent";
  } catch (e) {
    await store.updateAppointment(appt.id, { confirmation_email_status: "failed" });
    await store.recordIntegrationHealth("resend", false, "emails.send", safeErrorMessage(e));
    await store.upsertException({
      kind: "email_failure", severity: "high", lead_id: lead.id, appointment_id: appt.id, dedupe_key: `email:${appt.id}`, retryable: true, is_test: appt.is_test,
      title: `Confirmation email failed: ${lead.name ?? "customer"}`,
      detail: `The consultation is booked; only the email failed. ${safeErrorMessage(e)}`,
    });
    if (e instanceof EmailError && !e.retryable) throw e;
    throw new RetryableError(safeErrorMessage(e));
  }
}
