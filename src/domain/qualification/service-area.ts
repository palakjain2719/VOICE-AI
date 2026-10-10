import type { QualificationConfig } from "./config";

export type ServiceZone = "pune" | "pcmc" | "outside" | "unknown";

function normalise(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function find(text: string, places: string[]): string | null {
  // Longest match first so "pimple saudagar" wins over "pimpri".
  for (const p of [...places].sort((a, b) => b.length - a.length)) {
    if (text.includes(normalise(p))) return p;
  }
  return null;
}

/**
 * Deterministic service-area resolution. Exclusions are checked first so "Talegaon Dabhade,
 * near Pune" resolves to outside. A bare "Pune" with no qualifier counts as Pune city; "near"
 * or "outside" Pune is unknown and triggers the clarifying question.
 */
export function resolveServiceZone(
  locationText: string | null,
  config: QualificationConfig["serviceArea"],
): { zone: ServiceZone; locality: string | null } {
  if (!locationText || !locationText.trim()) return { zone: "unknown", locality: null };
  const text = normalise(locationText);

  const excluded = find(text, config.excludedLocalities);
  if (excluded) return { zone: "outside", locality: excluded };

  const pcmc = find(text, config.pcmcLocalities);
  const pune = find(text, config.puneLocalities);
  if (pune && (!pcmc || pune.length >= pcmc.length)) return { zone: "pune", locality: pune };
  if (pcmc) return { zone: "pcmc", locality: pcmc };

  if (/\b(near|outside|around|beyond|close to)\s+pune\b/.test(text)) return { zone: "unknown", locality: null };
  if (/\bpune\b/.test(text)) return { zone: "pune", locality: "pune" };
  return { zone: "unknown", locality: null };
}
