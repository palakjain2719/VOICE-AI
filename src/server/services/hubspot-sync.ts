import { z } from "zod";
import type { HubSpotClient, HubSpotPipeline } from "@/integrations/hubspot/client";
import type { AppointmentRow, DesignerRow, HubspotDealUpsert, LeadRow, Store } from "@/server/store/types";

/**
 * Stage mapping lives in app_settings("hubspot_pipeline") and is chosen in Settings from the
 * pipelines HubSpot actually returns — no stage ids are hard-coded.
 */
export const PipelineMappingSchema = z.object({
  pipelineId: z.string().min(1),
  stages: z.object({
    qualified: z.string().min(1),
    consultation_booked: z.string().min(1),
    consultation_completed: z.string().min(1),
    deal_open: z.string().min(1),
  }),
});
export type PipelineMapping = z.infer<typeof PipelineMappingSchema>;

export class HubSpotSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubSpotSetupError";
  }
}

const CONTACT_PROPS = ["email", "phone", "firstname", "lastname", "aangan_phone_normalized", "aangan_first_call_at", "hubspot_owner_id"];
const DEAL_PROPS = ["dealstage", "pipeline", "hs_is_closed", "aangan_lead_id", "hubspot_owner_id"];

function splitName(name: string | null): { firstname?: string; lastname?: string } {
  if (!name) return {};
  const parts = name.trim().split(/\s+/);
  return parts.length === 1 ? { firstname: parts[0] } : { firstname: parts.slice(0, -1).join(" "), lastname: parts.at(-1) };
}

function uncertaintyText(lead: LeadRow): string {
  const u = (lead.uncertainties ?? []) as { criterion?: string; detail?: string }[];
  return u.length ? u.map((x) => `• ${x.detail ?? x.criterion}`).join("\n") : "None recorded";
}

function brief(lead: LeadRow): string {
  return [
    lead.project_type && `Project: ${lead.project_type}`,
    lead.project_scope && `Scope: ${lead.project_scope}`,
    lead.property_area_sqft && `Area: ${lead.property_area_sqft} sq ft`,
    lead.location && `Location: ${lead.location}`,
    lead.current_property_state && `Current state: ${lead.current_property_state}`,
    lead.timeline && `Timeline: ${lead.timeline}`,
    lead.is_rented !== null && `Rented: ${lead.is_rented ? "yes" : "no"}`,
    lead.decision_maker_status && `Decision-maker: ${lead.decision_maker_status.replace(/_/g, " ")}`,
    lead.budget_volunteered && `Budget volunteered by caller: ${lead.budget_notes ?? "yes"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function stageOrder(pipeline: HubSpotPipeline | undefined, stageId: string | null): number {
  if (!pipeline || !stageId) return -1;
  return pipeline.stages.find((s) => s.id === stageId)?.displayOrder ?? -1;
}

export interface SyncLeadDeps {
  store: Store;
  hs: HubSpotClient;
  mapping: PipelineMapping | null;
  appBaseUrl: string | null;
}

export interface SyncLeadResult {
  contactId: string;
  dealId: string;
  contactCreated: boolean;
  dealCreated: boolean;
  stage: string;
}

/**
 * Create-or-update the contact (matched by email, then normalised phone) and the deal (matched by
 * stored id, then aangan_lead_id). Stage only ever moves forward, never out of a closed stage, and
 * no amount or close date is written — those belong to the sales team.
 */
export async function syncLeadToHubSpot(leadId: string, deps: SyncLeadDeps): Promise<SyncLeadResult> {
  const { store, hs } = deps;
  if (!deps.mapping) throw new HubSpotSetupError("HubSpot pipeline/stage mapping is not configured (Settings → HubSpot pipeline).");
  const mapping = deps.mapping;
  const lead = await store.getLead(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  if (lead.qualification_status !== "green" && lead.qualification_status !== "amber") {
    throw new Error(`Lead ${leadId} is ${lead.qualification_status}; only eligible leads sync to HubSpot`);
  }
  const appt = await store.getLiveAppointmentForLead(lead.id);
  const designer: DesignerRow | null = lead.assigned_designer_id ? await store.getDesigner(lead.assigned_designer_id) : null;
  const ownerId = designer?.hubspot_owner_id ?? null;

  // ---- contact
  let contact = lead.hubspot_contact_id ? await hs.get("contacts", lead.hubspot_contact_id, CONTACT_PROPS) : null;
  if (!contact && lead.email) contact = await hs.searchOne("contacts", "email", lead.email, CONTACT_PROPS);
  if (!contact && lead.phone_normalized) contact = await hs.searchOne("contacts", "aangan_phone_normalized", lead.phone_normalized, CONTACT_PROPS);

  const now = new Date().toISOString();
  const contactProps: Record<string, unknown> = {
    ...splitName(lead.name),
    ...(lead.email ? { email: lead.email } : {}),
    ...(lead.phone_normalized ? { phone: lead.phone_normalized, aangan_phone_normalized: lead.phone_normalized } : {}),
    aangan_project_location: lead.location ?? "",
    aangan_project_type: lead.project_type ?? "",
    aangan_scope_summary: lead.project_scope ?? "",
    ...(lead.property_area_sqft ? { aangan_area_sqft: lead.property_area_sqft } : {}),
    aangan_timeline: lead.timeline ?? "",
    aangan_qualification_status: lead.qualification_status,
    aangan_qualification_notes: uncertaintyText(lead),
    aangan_lead_source: lead.source,
    aangan_last_call_at: now,
    aangan_appointment_status: appt ? `${appt.status} — ${appt.start_at}` : "not booked",
  };
  let contactCreated = false;
  if (contact) {
    if (!contact.properties.aangan_first_call_at) contactProps.aangan_first_call_at = lead.created_at;
    if (!contact.properties.hubspot_owner_id && ownerId) contactProps.hubspot_owner_id = ownerId;
    contact = await hs.update("contacts", contact.id, contactProps);
  } else {
    contact = await hs.create("contacts", { ...contactProps, aangan_first_call_at: lead.created_at, ...(ownerId ? { hubspot_owner_id: ownerId } : {}) });
    contactCreated = true;
  }
  // Persist immediately so a retry after a later failure re-uses this contact.
  await store.updateLead(lead.id, { hubspot_contact_id: contact.id });

  // ---- deal
  let deal = lead.hubspot_deal_id ? await hs.get("deals", lead.hubspot_deal_id, DEAL_PROPS) : null;
  if (!deal) deal = await hs.searchOne("deals", "aangan_lead_id", lead.id, DEAL_PROPS);

  const pipelines = await hs.pipelines();
  const pipeline = pipelines.find((p) => p.id === mapping.pipelineId);
  if (!pipeline) throw new HubSpotSetupError(`Configured HubSpot pipeline ${mapping.pipelineId} no longer exists.`);
  const target = appt && appt.status === "confirmed" ? mapping.stages.consultation_booked : mapping.stages.qualified;

  const callRef = lead.last_call_id && deps.appBaseUrl ? `${deps.appBaseUrl}/calls/${lead.last_call_id}` : lead.last_call_id ?? "";
  const lastCall = lead.last_call_id ? await store.getCall(lead.last_call_id) : null;
  const dealProps: Record<string, unknown> = {
    aangan_lead_id: lead.id,
    aangan_qualification_status: lead.qualification_status,
    aangan_uncertainties: uncertaintyText(lead),
    aangan_project_brief: brief(lead),
    aangan_call_summary: lastCall?.summary ?? "",
    aangan_call_reference: callRef,
    aangan_lead_source: lead.source,
    aangan_next_step: nextStep(appt),
    ...(appt?.status === "confirmed" ? { aangan_appointment_at: appt.start_at, aangan_calendar_event_id: appt.provider_event_id ?? "" } : {}),
  };

  let dealCreated = false;
  let stage = target;
  if (deal) {
    const closed = deal.properties.hs_is_closed === "true";
    const forward = deal.properties.pipeline === pipeline.id && stageOrder(pipeline, deal.properties.dealstage) < stageOrder(pipeline, target);
    if (!closed && forward) dealProps.dealstage = target;
    else stage = deal.properties.dealstage ?? target;
    if (!deal.properties.hubspot_owner_id && ownerId) dealProps.hubspot_owner_id = ownerId;
    deal = await hs.update("deals", deal.id, dealProps);
  } else {
    deal = await hs.create(
      "deals",
      {
        ...dealProps,
        dealname: `${lead.name ?? "Caller"} — ${lead.project_type ?? "Interior project"}${lead.locality ? `, ${lead.locality}` : ""}`,
        pipeline: pipeline.id,
        dealstage: target,
        ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
      },
      // 3 = HUBSPOT_DEFINED deal → contact association
      [{ to: { id: contact.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }],
    );
    dealCreated = true;
  }

  await store.updateLead(lead.id, { hubspot_deal_id: deal.id, hubspot_sync_status: "synced", hubspot_last_synced_at: new Date().toISOString() });
  return { contactId: contact.id, dealId: deal.id, contactCreated, dealCreated, stage };
}

function nextStep(appt: AppointmentRow | null): string {
  if (!appt) return "Contact the customer to arrange a consultation";
  if (appt.status === "confirmed") return `Consultation on ${appt.start_at}`;
  return "Confirm consultation time with the customer";
}

// ---------------------------------------------------------------------------
// Deal mirror: HubSpot → Supabase (read-only cache for the founder dashboard)
// ---------------------------------------------------------------------------

const MIRROR_PROPS = [
  "dealname", "amount", "deal_currency_code", "pipeline", "dealstage", "hs_deal_stage_probability",
  "hs_is_closed", "hs_is_closed_won", "hubspot_owner_id", "closedate", "createdate", "hs_lastmodifieddate", "aangan_lead_id",
];

export interface DealSyncResult {
  fetched: number;
  pages: number;
  cursor: string | null;
  leadEvents: number;
}

export async function syncDealsFromHubSpot(deps: { store: Store; hs: HubSpotClient; mapping: PipelineMapping | null; maxPages?: number }): Promise<DealSyncResult> {
  const { store, hs, mapping } = deps;
  const pipelines = await hs.pipelines();
  const stageInfo = new Map<string, { label: string; probability: number | null; pipeline: HubSpotPipeline }>();
  for (const p of pipelines)
    for (const s of p.stages)
      stageInfo.set(s.id, { label: s.label, probability: s.metadata.probability != null ? Number(s.metadata.probability) : null, pipeline: p });

  const dateEnteredProps = mapping ? Object.values(mapping.stages).map((s) => `hs_v2_date_entered_${s}`) : [];
  const cursorName = "hubspot_deals";
  let cursor = await store.getCursor(cursorName);
  let pages = 0;
  let fetched = 0;
  let leadEvents = 0;
  let after: string | undefined;
  const maxPages = deps.maxPages ?? 10;
  const since = cursor ?? "0";

  while (pages < maxPages) {
    const filters: { propertyName: string; operator: string; value: string }[] = [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: since }];
    if (mapping) filters.push({ propertyName: "pipeline", operator: "EQ", value: mapping.pipelineId });
    const r = await hs.request<{ results: { id: string; properties: Record<string, string | null> }[]; paging?: { next?: { after: string } } }>(
      "POST",
      "/crm/v3/objects/deals/search",
      { filterGroups: [{ filters }], sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }], properties: [...MIRROR_PROPS, ...dateEnteredProps], limit: 100, ...(after ? { after } : {}) },
    );
    pages++;
    const rows: HubspotDealUpsert[] = [];
    for (const d of r.results) {
      const p = d.properties;
      const st = p.dealstage ? stageInfo.get(p.dealstage) : undefined;
      const prob = st?.probability ?? (p.hs_deal_stage_probability != null ? Number(p.hs_deal_stage_probability) : null);
      const leadId = p.aangan_lead_id || null;
      const lead = leadId ? await store.getLead(leadId) : await store.findLeadByHubspotDeal(d.id);
      const designer = p.hubspot_owner_id ? await store.getDesignerByHubspotOwner(p.hubspot_owner_id) : null;
      const amount = p.amount != null && p.amount !== "" ? Number(p.amount) : null;
      rows.push({
        hubspot_deal_id: d.id,
        lead_id: lead?.id ?? null,
        deal_name: p.dealname,
        amount: Number.isFinite(amount) ? amount : null,
        currency: p.deal_currency_code ?? null,
        pipeline_id: p.pipeline,
        stage_id: p.dealstage,
        stage_label: st?.label ?? null,
        stage_probability: Number.isFinite(prob as number) ? prob : null,
        is_closed: p.hs_is_closed === "true",
        is_won: p.hs_is_closed_won === "true",
        hubspot_owner_id: p.hubspot_owner_id,
        designer_id: designer?.id ?? null,
        close_date: p.closedate,
        created_in_hubspot_at: p.createdate,
        last_modified_at: p.hs_lastmodifieddate,
        is_aangan_voice_lead: !!leadId,
        raw_properties: p,
      });
      if (lead && mapping && st) leadEvents += await deriveLeadEvents(store, lead, d.id, p, st.pipeline, mapping);
      if (p.hs_lastmodifieddate && (!cursor || Date.parse(p.hs_lastmodifieddate) > Number(cursor))) cursor = String(Date.parse(p.hs_lastmodifieddate));
    }
    await store.upsertHubspotDeals(rows);
    fetched += r.results.length;
    after = r.paging?.next?.after;
    if (!after) break;
  }
  await store.setCursor(cursorName, cursor);
  return { fetched, pages, cursor, leadEvents };
}

async function deriveLeadEvents(
  store: Store,
  lead: LeadRow,
  dealId: string,
  p: Record<string, string | null>,
  pipeline: HubSpotPipeline,
  mapping: PipelineMapping,
): Promise<number> {
  const order = stageOrder(pipeline, p.dealstage);
  const at = (stage: string) => p[`hs_v2_date_entered_${stage}`] ?? p.hs_lastmodifieddate ?? new Date().toISOString();
  const won = p.hs_is_closed_won === "true";
  const closed = p.hs_is_closed === "true";
  let n = 0;
  const add = async (event_type: "consultation_completed" | "deal_opened" | "won" | "lost", occurred_at: string) => {
    if (await store.addLeadEvent({ lead_id: lead.id, call_id: null, event_type, dedupe_key: `lead:${lead.id}`, occurred_at, metadata: { hubspot_deal_id: dealId, stage: p.dealstage }, is_test: lead.is_test }))
      n++;
  };
  // Won deals necessarily passed the earlier stages, even if a stage was skipped in HubSpot.
  // A closed-lost stage usually sorts last, so its position says nothing about progress: for lost
  // deals only the recorded stage-entry dates count.
  const reached = (stage: string) =>
    won || (!closed && order >= stageOrder(pipeline, stage)) || (closed && !!p[`hs_v2_date_entered_${stage}`]);
  if (reached(mapping.stages.consultation_completed)) await add("consultation_completed", at(mapping.stages.consultation_completed));
  if (reached(mapping.stages.deal_open)) await add("deal_opened", at(mapping.stages.deal_open));
  if (won) await add("won", p.closedate ?? p.hs_lastmodifieddate ?? new Date().toISOString());
  else if (closed) await add("lost", p.closedate ?? p.hs_lastmodifieddate ?? new Date().toISOString());
  return n;
}
