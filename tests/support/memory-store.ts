import { randomUUID } from "node:crypto";
import { SEED_ARTICLES } from "@/domain/knowledge/seed";
import {
  OverlapError,
  type AppointmentRow,
  type CallRow,
  type DesignerRow,
  type GoogleCredentialRow,
  type HubspotDealUpsert,
  type JobRow,
  type LeadRow,
  type PublishedArticle,
  type Store,
} from "@/server/store/types";

/**
 * In-memory Store mirroring the database constraints the workflows rely on:
 * unique provider call ids, one lead per phone, appointment idempotency keys, one live
 * appointment per lead, no overlapping live appointments per designer, deduped lead events,
 * jobs and exceptions.
 */
export function memoryStore() {
  const now = () => new Date().toISOString();
  const calls = new Map<string, CallRow>();
  const transcripts = new Map<string, { transcript: string | null; turns: unknown }>();
  const leads = new Map<string, LeadRow>();
  const quals: Record<string, unknown>[] = [];
  const events: { lead_id: string | null; call_id: string | null; event_type: string; dedupe_key: string; occurred_at: string; metadata?: unknown }[] = [];
  const designers = new Map<string, DesignerRow>();
  const creds = new Map<string, GoogleCredentialRow>();
  const appts = new Map<string, AppointmentRow>();
  const jobs = new Map<string, JobRow>();
  const exceptions = new Map<string, Record<string, unknown> & { id: string; status: string }>();
  const integrationEvents = new Map<string, { id: string; status: string; [k: string]: unknown }>();
  const health: { provider: string; ok: boolean; operation: string; error?: string | null }[] = [];
  const settings = new Map<string, unknown>();
  const unanswered = new Map<string, { id: string; question: string; normalized: string; occurrences: number; status: string }>();
  const costs: Record<string, unknown>[] = [];
  const deals = new Map<string, HubspotDealUpsert>();
  const cursors = new Map<string, string | null>();
  const audits: unknown[] = [];
  const policy: { call_id: string | null; kind: string }[] = [];
  const messages = new Map<string, Record<string, unknown> & { id: string; dedupe_key: string }>();
  let articles: PublishedArticle[] = SEED_ARTICLES.map((a, i) => ({
    id: `art-${i}`, slug: a.slug, category: a.category, title: a.title, keywords: a.keywords, audience: "customer",
    versionId: `ver-${i}`, version: 1, spokenAnswer: a.spokenAnswer,
  }));

  const callDefaults = (): Omit<CallRow, "id" | "provider" | "provider_call_id"> => ({
    call_type: "unknown", caller_phone: null, caller_phone_normalized: null, started_at: now(), answered: null, ended_at: null,
    duration_seconds: null, status: "in_progress", failure_reason: null, summary: null, recording_reference: null, provider_metadata: {},
    intake: {}, processing_status: "pending", processing_error: null, lead_id: null, related_call_id: null, production_call: true, is_test: false, created_at: now(),
  });
  const leadDefaults = (): Omit<LeadRow, "id"> => ({
    name: null, phone: null, phone_normalized: null, email: null, location: null, locality: null, service_zone: null, project_segment: null,
    project_type: null, project_scope: null, property_area_sqft: null, current_property_state: null, timeline: null, required_completion_date: null,
    budget_volunteered: false, budget_notes: null, decision_maker_status: null, is_rented: null, qualification_status: "not_evaluated",
    qualification_reasons: [], uncertainties: [], hubspot_contact_id: null, hubspot_deal_id: null, hubspot_sync_status: "not_required",
    hubspot_last_synced_at: null, assigned_designer_id: null, first_call_id: null, last_call_id: null, source: "phone_voice_ai", is_test: false,
    created_at: now(), updated_at: now(),
  });
  const live = (a: AppointmentRow) => a.status === "pending" || a.status === "confirmed";

  const store: Store = {
    async getCall(id) { return calls.get(id) ?? null; },
    async getCallByProviderId(p, pid) { return [...calls.values()].find((c) => c.provider === p && c.provider_call_id === pid) ?? null; },
    async ensureCall(p, pid, init) {
      const ex = await store.getCallByProviderId(p, pid);
      if (ex) return { call: ex, created: false };
      const c: CallRow = { ...callDefaults(), ...init, id: randomUUID(), provider: p, provider_call_id: pid } as CallRow;
      calls.set(c.id, c);
      return { call: c, created: true };
    },
    async updateCall(id, patch) { const c = { ...calls.get(id)!, ...patch }; calls.set(id, c); return c; },
    async findRecentCallFromPhone(phone, since, exclude) {
      return [...calls.values()].filter((c) => c.caller_phone_normalized === phone && c.id !== exclude && (c.started_at ?? "") >= since).sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0] ?? null;
    },
    async saveTranscript(id, transcript, turns) { transcripts.set(id, { transcript, turns }); },
    async getTranscript(id) { return transcripts.get(id) ?? null; },

    async getLead(id) { return leads.get(id) ?? null; },
    async findLeadByPhone(p) { return [...leads.values()].find((l) => l.phone_normalized === p && !l.is_test) ?? null; },
    async findLeadByEmail(e) { return [...leads.values()].find((l) => l.email?.toLowerCase() === e.toLowerCase()) ?? null; },
    async insertLead(row) {
      if (row.phone_normalized && [...leads.values()].some((l) => l.phone_normalized === row.phone_normalized && !l.is_test && !row.is_test)) throw new Error("23505 leads_phone_unique");
      const l = { ...leadDefaults(), ...row, id: randomUUID() } as LeadRow;
      leads.set(l.id, l);
      return l;
    },
    async updateLead(id, patch) { const l = { ...leads.get(id)!, ...patch, updated_at: now() }; leads.set(id, l); return l; },
    async insertQualification(row) { quals.push({ ...row, created_at: now() }); },
    async latestQualificationForCall(callId) {
      const q = quals.filter((x) => x.call_id === callId).at(-1);
      return q ? { status: q.status as string, criteria: q.criteria } : null;
    },
    async addLeadEvent(e) {
      if (events.some((x) => x.event_type === e.event_type && x.dedupe_key === e.dedupe_key)) return false;
      events.push({ ...e, occurred_at: e.occurred_at ?? now() });
      return true;
    },

    async listBookableDesigners() { return [...designers.values()].filter((d) => d.active && d.booking_enabled && d.calendar_id); },
    async getDesigner(id) { return designers.get(id) ?? null; },
    async getDesignerByHubspotOwner(o) { return [...designers.values()].find((d) => d.hubspot_owner_id === o) ?? null; },
    async getGoogleCredential(id) { return creds.get(id) ?? null; },
    async updateGoogleCredential(id, patch) { creds.set(id, { ...creds.get(id)!, ...patch }); },
    async countUpcomingAppointments(d, from) { return [...appts.values()].filter((a) => a.designer_id === d && live(a) && a.start_at >= from).length; },

    async getAppointment(id) { return appts.get(id) ?? null; },
    async getAppointmentByIdempotencyKey(k) { return [...appts.values()].find((a) => a.idempotency_key === k) ?? null; },
    async getLiveAppointmentForLead(l) { return [...appts.values()].find((a) => a.lead_id === l && live(a)) ?? null; },
    async insertAppointment(row) {
      const byKey = await store.getAppointmentByIdempotencyKey(row.idempotency_key);
      if (byKey) return byKey;
      const status = row.status ?? "pending";
      if (status === "pending" || status === "confirmed") {
        if (await store.getLiveAppointmentForLead(row.lead_id)) return (await store.getLiveAppointmentForLead(row.lead_id))!;
        const clash = [...appts.values()].some((a) => live(a) && a.designer_id === row.designer_id && a.start_at < row.end_at && row.start_at < a.end_at);
        if (clash) throw new OverlapError();
      }
      const a: AppointmentRow = {
        id: randomUUID(), call_id: null, designer_id: null, calendar_provider: "google", provider_calendar_id: null, provider_event_id: null,
        timezone: "Asia/Kolkata", meeting_type: "site_visit", status: "pending", failure_reason: null, confirmation_email_status: "not_sent",
        confirmation_email_sent_at: null, confirmation_email_provider_id: null, rescheduled_from_id: null, is_test: false, created_at: now(), ...row,
      } as AppointmentRow;
      appts.set(a.id, a);
      return a;
    },
    async updateAppointment(id, patch) { const a = { ...appts.get(id)!, ...patch }; appts.set(id, a); return a; },

    async enqueueJob(type, payload, key, runAfter) {
      if ([...jobs.values()].some((j) => j.idempotency_key === key)) return null;
      const j: JobRow = { id: randomUUID(), type, payload, idempotency_key: key, status: "pending", attempts: 0, max_attempts: 6, run_after: runAfter ?? now(), last_error: null };
      jobs.set(j.id, j);
      return j;
    },
    async claimJobs(limit, types) {
      const ready = [...jobs.values()].filter((j) => (j.status === "pending" || j.status === "failed") && j.run_after <= now() && j.attempts < j.max_attempts && (!types || types.includes(j.type))).slice(0, limit);
      return ready.map((j) => { const n = { ...j, status: "running" as const, attempts: j.attempts + 1 }; jobs.set(j.id, n); return n; });
    },
    async completeJob(id) { jobs.set(id, { ...jobs.get(id)!, status: "succeeded" }); },
    async failJob(id, error, retryAt) { jobs.set(id, { ...jobs.get(id)!, status: retryAt ? "failed" : "dead", last_error: error, run_after: retryAt ?? jobs.get(id)!.run_after }); },
    async getJobByKey(k) { return [...jobs.values()].find((j) => j.idempotency_key === k) ?? null; },
    async resetJob(k) { const j = await store.getJobByKey(k); if (j) jobs.set(j.id, { ...j, status: "pending", attempts: 0, run_after: now() }); },

    async upsertException(e) {
      const ex = [...exceptions.values()].find((x) => x.dedupe_key === e.dedupe_key);
      if (ex) { exceptions.set(ex.id, { ...ex, detail: e.detail, status: ex.status === "resolved" ? "open" : ex.status }); return ex.id; }
      const id = randomUUID();
      exceptions.set(id, { severity: "normal", ...e, id, status: "open" });
      return id;
    },
    async recordIntegrationEvent(e) {
      const k = `${e.provider}:${e.external_event_id}`;
      const ex = integrationEvents.get(k);
      if (ex) return { id: ex.id, duplicate: true, status: ex.status };
      const row = { ...e, id: randomUUID(), status: "received" };
      integrationEvents.set(k, row);
      return { id: row.id, duplicate: false, status: row.status };
    },
    async updateIntegrationEvent(id, patch) {
      for (const [k, v] of integrationEvents) if (v.id === id) integrationEvents.set(k, { ...v, ...patch });
    },
    async recordIntegrationHealth(provider, ok, operation, error) { health.push({ provider, ok, operation, error }); },

    async getSetting<T>(k: string) { return (settings.get(k) as T) ?? null; },
    async listPublishedArticles() { return articles; },
    async logUnansweredQuestion(q) {
      const ex = [...unanswered.values()].find((u) => u.normalized === q.normalized && (u.status === "unresolved" || u.status === "in_review"));
      if (ex) { ex.occurrences++; return { id: ex.id, created: false }; }
      const id = randomUUID();
      unanswered.set(id, { id, question: q.question, normalized: q.normalized, occurrences: 1, status: "unresolved" });
      return { id, created: true };
    },
    async insertCostEvent(e) { if (!costs.some((c) => c.provider === e.provider && c.external_id === e.external_id && e.external_id)) costs.push(e as unknown as Record<string, unknown>); },
    async upsertHubspotDeals(rows) { rows.forEach((r) => deals.set(r.hubspot_deal_id, r)); },
    async getHubspotDeal(id) { return deals.get(id) ?? null; },
    async findLeadByHubspotDeal(id) { return [...leads.values()].find((l) => l.hubspot_deal_id === id) ?? null; },
    async getCursor(n) { return cursors.get(n) ?? null; },
    async setCursor(n, c, err) { if (!err) cursors.set(n, c); },
    async insertTeamMessage(m) {
      const ex = [...messages.values()].find((x) => x.dedupe_key === m.dedupe_key);
      if (ex) return { id: ex.id, created: false };
      const id = randomUUID();
      messages.set(id, { ...m, id, status: "open", delivered_via: null });
      return { id, created: true };
    },
    async markTeamMessageDelivered(id, via) { messages.set(id, { ...messages.get(id)!, delivered_via: via, delivered_at: now() }); },
    async getTeamMessage(id) { return (messages.get(id) as never) ?? null; },
    async findDesignerByName(name) {
      const first = name.trim().split(/\s+/)[0]?.toLowerCase();
      const hits = [...designers.values()].filter((d) => d.active && d.name.toLowerCase().startsWith(first ?? "\u0000"));
      return hits.length === 1 ? hits[0] : null;
    },
    async getException(id) { return (exceptions.get(id) as never) ?? null; },
    async updateException(id, patch) { exceptions.set(id, { ...exceptions.get(id)!, ...patch } as never); },
    async markExceptionNotified(id) { const e = exceptions.get(id); if (e && !e.notified_at) exceptions.set(id, { ...e, notified_at: now() }); },
    async recordPolicyEvent(e) { policy.push(e); },
    async audit(e) { audits.push(e); },
  };

  return {
    store,
    calls, transcripts, leads, quals, events, designers, creds, appts, jobs, exceptions, integrationEvents, health, settings, unanswered, costs, deals, cursors, audits, policy, messages,
    setArticles(a: PublishedArticle[]) { articles = a; },
    addDesigner(d: Partial<DesignerRow> = {}): DesignerRow {
      const row: DesignerRow = { id: randomUUID(), name: "Asha Kulkarni", email: "asha@example.com", hubspot_owner_id: "101", calendar_id: "asha@example.com", google_credential_id: "cred-1", active: true, booking_enabled: true, ...d };
      designers.set(row.id, row);
      return row;
    },
  };
}
export type MemoryStore = ReturnType<typeof memoryStore>;
