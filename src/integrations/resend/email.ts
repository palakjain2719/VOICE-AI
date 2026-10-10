import { formatInTimeZone } from "date-fns-tz";

/**
 * Resend REST API: POST https://api.resend.com/emails with an `Idempotency-Key` header, so a
 * retried job can never send the same confirmation twice. https://resend.com/docs/api-reference
 */
export interface EmailSender {
  send(msg: { to: string; subject: string; html: string; text: string; idempotencyKey: string }): Promise<{ id: string }>;
}

export class EmailError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmailError";
  }
}

export function resendSender(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): EmailSender {
  return {
    async send({ to, subject, html, text, idempotencyKey }) {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (!res.ok || !body.id) {
        throw new EmailError(res.status, `Resend ${res.status}: ${body.name ?? body.message ?? "send failed"}`, res.status === 429 || res.status >= 500);
      }
      return { id: body.id };
    },
  };
}

export interface ConfirmationDetails {
  customerName: string | null;
  startIso: string;
  endIso: string;
  timezone: string;
  designerName: string | null;
  meetingType: "site_visit" | "studio" | "video";
  location: string | null;
  contactLine: string | null;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderConfirmationEmail(d: ConfirmationDetails): { subject: string; html: string; text: string } {
  const date = formatInTimeZone(new Date(d.startIso), d.timezone, "EEEE, d MMMM yyyy");
  const time = `${formatInTimeZone(new Date(d.startIso), d.timezone, "h:mm a")} – ${formatInTimeZone(new Date(d.endIso), d.timezone, "h:mm a")} IST`;
  const greeting = d.customerName ? `Dear ${d.customerName},` : "Hello,";
  const where =
    d.meetingType === "site_visit"
      ? `Site visit${d.location ? ` at ${d.location}` : ""} — your designer will visit the property.`
      : d.meetingType === "studio"
        ? "At the Aangan Studio office."
        : "Video consultation — your designer will share the meeting link before the call.";
  const reschedule = d.contactLine
    ? `Need to reschedule or cancel? ${d.contactLine}`
    : "Need to reschedule or cancel? Simply reply to this email and our team will help.";

  const rows: [string, string][] = [
    ["Date", date],
    ["Time", time],
    ...(d.designerName ? ([["Designer", d.designerName]] as [string, string][]) : []),
    ["Where", where],
  ];

  const text = [
    greeting,
    "",
    "Thank you for speaking with Aangan Studio. Your design consultation is confirmed.",
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    "Your designer will walk you through the design process, materials and pricing in detail at the consultation.",
    "",
    reschedule,
    "",
    "Warm regards,",
    "Aangan Studio — Interior design & execution, Pune",
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;background:#f6f5fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2337">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6e3f3;border-radius:16px;overflow:hidden">
<tr><td style="background:linear-gradient(135deg,#ece8fb,#e3effb 55%,#e2f5ee);padding:28px 32px">
<div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#5b528f;font-weight:600">Aangan Studio</div>
<div style="font-size:22px;font-weight:600;margin-top:6px;color:#1f2337">Your consultation is confirmed</div>
</td></tr>
<tr><td style="padding:28px 32px">
<p style="margin:0 0 16px;font-size:15px;line-height:1.6">${esc(greeting)}</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6">Thank you for speaking with Aangan Studio. Your design consultation is confirmed.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ecebf3;border-radius:12px;background:#fbfbfe">
${rows.map(([k, v]) => `<tr><td style="padding:12px 16px;font-size:13px;color:#6a6f86;width:96px;vertical-align:top">${esc(k)}</td><td style="padding:12px 16px;font-size:15px;font-weight:500">${esc(v)}</td></tr>`).join("")}
</table>
<p style="margin:20px 0 0;font-size:15px;line-height:1.6">Your designer will walk you through the design process, materials and pricing in detail at the consultation.</p>
<p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:#4a4f66">${esc(reschedule)}</p>
<p style="margin:24px 0 0;font-size:15px;line-height:1.6">Warm regards,<br/>Aangan Studio</p>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #efedf6;font-size:12px;color:#8a8ea3">Interior design &amp; execution · Pune city and PCMC</td></tr>
</table></td></tr></table></body></html>`;

  return { subject: `Your Aangan Studio consultation — ${date}`, html, text };
}
