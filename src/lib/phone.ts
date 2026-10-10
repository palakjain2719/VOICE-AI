/** Normalises Indian numbers to E.164 (+91XXXXXXXXXX). Returns null if it isn't a usable number. */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/[x*]/i.test(raw)) return null; // provider-masked numbers are not identifiers
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  if (raw.trim().startsWith("+") && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

export function maskPhone(p: string | null | undefined): string {
  if (!p) return "—";
  const d = p.replace(/\D/g, "");
  return d.length < 4 ? "••••" : `•••• ${d.slice(-4)}`;
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
export function normaliseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase().replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".").replace(/\s/g, "");
  return EMAIL_RE.test(e) ? e : null;
}
