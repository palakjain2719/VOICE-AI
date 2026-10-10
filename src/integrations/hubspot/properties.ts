import { HubSpotError, type HubSpotClient } from "./client";

/** Custom properties Aangan writes. Created on demand from Integrations → HubSpot. */
export const PROPERTY_GROUP = "aangan_studio";

type PropDef = { name: string; label: string; type: "string" | "number" | "datetime"; fieldType: "text" | "textarea" | "number" | "date" };

export const CONTACT_PROPERTIES: PropDef[] = [
  { name: "aangan_phone_normalized", label: "Phone (normalised, E.164)", type: "string", fieldType: "text" },
  { name: "aangan_project_location", label: "Project location", type: "string", fieldType: "text" },
  { name: "aangan_project_type", label: "Project type", type: "string", fieldType: "text" },
  { name: "aangan_scope_summary", label: "Scope summary", type: "string", fieldType: "textarea" },
  { name: "aangan_area_sqft", label: "Designed area (sq ft)", type: "number", fieldType: "number" },
  { name: "aangan_timeline", label: "Project timeline", type: "string", fieldType: "text" },
  { name: "aangan_qualification_status", label: "Qualification status", type: "string", fieldType: "text" },
  { name: "aangan_qualification_notes", label: "Qualification notes", type: "string", fieldType: "textarea" },
  { name: "aangan_lead_source", label: "Aangan lead source", type: "string", fieldType: "text" },
  { name: "aangan_first_call_at", label: "First call", type: "datetime", fieldType: "date" },
  { name: "aangan_last_call_at", label: "Last call", type: "datetime", fieldType: "date" },
  { name: "aangan_appointment_status", label: "Consultation status", type: "string", fieldType: "text" },
];

export const DEAL_PROPERTIES: PropDef[] = [
  { name: "aangan_lead_id", label: "Aangan lead id", type: "string", fieldType: "text" },
  { name: "aangan_qualification_status", label: "Qualification status", type: "string", fieldType: "text" },
  { name: "aangan_uncertainties", label: "Points to clarify", type: "string", fieldType: "textarea" },
  { name: "aangan_project_brief", label: "Project brief", type: "string", fieldType: "textarea" },
  { name: "aangan_call_summary", label: "Call summary", type: "string", fieldType: "textarea" },
  { name: "aangan_call_reference", label: "Call record link", type: "string", fieldType: "text" },
  { name: "aangan_appointment_at", label: "Consultation date/time", type: "datetime", fieldType: "date" },
  { name: "aangan_calendar_event_id", label: "Calendar event id", type: "string", fieldType: "text" },
  { name: "aangan_next_step", label: "Next step", type: "string", fieldType: "text" },
  { name: "aangan_lead_source", label: "Aangan lead source", type: "string", fieldType: "text" },
];

export async function ensureProperties(hs: HubSpotClient): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const objectType of ["contacts", "deals"] as const) {
    try {
      await hs.request("POST", `/crm/v3/properties/${objectType}/groups`, { name: PROPERTY_GROUP, label: "Aangan Studio", displayOrder: -1 });
    } catch (e) {
      if (!(e instanceof HubSpotError && e.status === 409)) throw e;
    }
    for (const p of objectType === "contacts" ? CONTACT_PROPERTIES : DEAL_PROPERTIES) {
      try {
        await hs.request("POST", `/crm/v3/properties/${objectType}`, { ...p, groupName: PROPERTY_GROUP, formField: false });
        created.push(`${objectType}.${p.name}`);
      } catch (e) {
        if (e instanceof HubSpotError && e.status === 409) existing.push(`${objectType}.${p.name}`);
        else throw e;
      }
    }
  }
  return { created, existing };
}

/** Non-destructive capability probe: one read per required scope. */
export async function probeScopes(hs: HubSpotClient): Promise<{ check: string; ok: boolean; status?: number; missingScopes?: string[] }[]> {
  const checks: [string, string][] = [
    ["contacts.read", "/crm/v3/objects/contacts?limit=1"],
    ["deals.read", "/crm/v3/objects/deals?limit=1"],
    ["owners.read", "/crm/v3/owners?limit=1"],
    ["pipelines.read", "/crm/v3/pipelines/deals"],
    ["contact properties", "/crm/v3/properties/contacts/aangan_phone_normalized"],
    ["deal properties", "/crm/v3/properties/deals/aangan_lead_id"],
  ];
  const out = [];
  for (const [check, path] of checks) {
    try {
      await hs.request("GET", path);
      out.push({ check, ok: true });
    } catch (e) {
      const he = e instanceof HubSpotError ? e : null;
      out.push({ check, ok: false, status: he?.status, missingScopes: he?.missingScopes });
    }
  }
  return out;
}
