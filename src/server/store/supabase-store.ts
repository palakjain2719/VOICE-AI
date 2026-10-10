import "server-only";
import { createAdminClient, type Db as SupabaseClient } from "@/lib/supabase/server";
import { redact } from "@/lib/log";
import {
  OverlapError,
  type AppointmentRow,
  type CallRow,
  type DesignerRow,
  type GoogleCredentialRow,
  type JobRow,
  type LeadRow,
  type PublishedArticle,
  type Store,
} from "./types";

function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${what}: no data`);
  return res.data;
}

function maybe<T>(res: { data: T | null; error: { message: string } | null }, what: string): T | null {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

const UNIQUE_VIOLATION = "23505";
const EXCLUSION_VIOLATION = "23P01";

export function supabaseStore(db: SupabaseClient = createAdminClient()): Store {
  return {
    async getCall(id) {
      return maybe(await db.from("calls").select("*").eq("id", id).maybeSingle<CallRow>(), "getCall");
    },
    async getCallByProviderId(provider, providerCallId) {
      return maybe(
        await db.from("calls").select("*").eq("provider", provider).eq("provider_call_id", providerCallId).maybeSingle<CallRow>(),
        "getCallByProviderId",
      );
    },
    async ensureCall(provider, providerCallId, init) {
      const existing = await this.getCallByProviderId(provider, providerCallId);
      if (existing) return { call: existing, created: false };
      const res = await db
        .from("calls")
        .insert({ ...init, provider, provider_call_id: providerCallId })
        .select("*")
        .single<CallRow>();
      if (res.error?.code === UNIQUE_VIOLATION) {
        const again = await this.getCallByProviderId(provider, providerCallId);
        if (again) return { call: again, created: false };
      }
      return { call: must(res, "ensureCall"), created: true };
    },
    async updateCall(id, patch) {
      return must(await db.from("calls").update(patch).eq("id", id).select("*").single<CallRow>(), "updateCall");
    },
    async findRecentCallFromPhone(phone, sinceIso, excludeCallId) {
      return maybe(
        await db
          .from("calls")
          .select("*")
          .eq("caller_phone_normalized", phone)
          .gte("started_at", sinceIso)
          .neq("id", excludeCallId)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle<CallRow>(),
        "findRecentCallFromPhone",
      );
    },
    async saveTranscript(callId, transcript, turns, source) {
      const res = await db.from("call_transcripts").upsert({ call_id: callId, transcript, turns, source });
      if (res.error) throw new Error(`saveTranscript: ${res.error.message}`);
    },
    async getTranscript(callId) {
      return maybe(
        await db.from("call_transcripts").select("transcript, turns").eq("call_id", callId).maybeSingle<{ transcript: string | null; turns: unknown }>(),
        "getTranscript",
      );
    },

    async getLead(id) {
      return maybe(await db.from("leads").select("*").eq("id", id).maybeSingle<LeadRow>(), "getLead");
    },
    async findLeadByPhone(phone) {
      return maybe(
        await db.from("leads").select("*").eq("phone_normalized", phone).eq("is_test", false).maybeSingle<LeadRow>(),
        "findLeadByPhone",
      );
    },
    async findLeadByEmail(email) {
      return maybe(
        await db.from("leads").select("*").ilike("email", email).eq("is_test", false).order("created_at").limit(1).maybeSingle<LeadRow>(),
        "findLeadByEmail",
      );
    },
    async insertLead(row) {
      return must(await db.from("leads").insert(row).select("*").single<LeadRow>(), "insertLead");
    },
    async updateLead(id, patch) {
      return must(await db.from("leads").update(patch).eq("id", id).select("*").single<LeadRow>(), "updateLead");
    },
    async insertQualification(row) {
      const res = await db.from("call_qualifications").insert(row);
      if (res.error) throw new Error(`insertQualification: ${res.error.message}`);
    },
    async latestQualificationForCall(callId) {
      return maybe(
        await db
          .from("call_qualifications")
          .select("status, criteria")
          .eq("call_id", callId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle<{ status: string; criteria: unknown }>(),
        "latestQualificationForCall",
      );
    },
    async addLeadEvent(e) {
      const res = await db.from("lead_events").insert({ metadata: {}, ...e });
      if (res.error?.code === UNIQUE_VIOLATION) return false;
      if (res.error) throw new Error(`addLeadEvent: ${res.error.message}`);
      return true;
    },

    async listBookableDesigners() {
      return must(
        await db.from("designers").select("*").eq("active", true).eq("booking_enabled", true).not("calendar_id", "is", null).returns<DesignerRow[]>(),
        "listBookableDesigners",
      );
    },
    async getDesigner(id) {
      return maybe(await db.from("designers").select("*").eq("id", id).maybeSingle<DesignerRow>(), "getDesigner");
    },
    async getDesignerByHubspotOwner(ownerId) {
      return maybe(
        await db.from("designers").select("*").eq("hubspot_owner_id", ownerId).limit(1).maybeSingle<DesignerRow>(),
        "getDesignerByHubspotOwner",
      );
    },
    async getGoogleCredential(id) {
      return maybe(await db.from("google_credentials").select("*").eq("id", id).maybeSingle<GoogleCredentialRow>(), "getGoogleCredential");
    },
    async updateGoogleCredential(id, patch) {
      const res = await db.from("google_credentials").update(patch).eq("id", id);
      if (res.error) throw new Error(`updateGoogleCredential: ${res.error.message}`);
    },
    async countUpcomingAppointments(designerId, fromIso) {
      const res = await db
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("designer_id", designerId)
        .in("status", ["pending", "confirmed"])
        .gte("start_at", fromIso);
      if (res.error) throw new Error(`countUpcomingAppointments: ${res.error.message}`);
      return res.count ?? 0;
    },

    async getAppointment(id) {
      return maybe(await db.from("appointments").select("*").eq("id", id).maybeSingle<AppointmentRow>(), "getAppointment");
    },
    async getAppointmentByIdempotencyKey(key) {
      return maybe(await db.from("appointments").select("*").eq("idempotency_key", key).maybeSingle<AppointmentRow>(), "getAppointmentByIdempotencyKey");
    },
    async getLiveAppointmentForLead(leadId) {
      return maybe(
        await db.from("appointments").select("*").eq("lead_id", leadId).in("status", ["pending", "confirmed"]).maybeSingle<AppointmentRow>(),
        "getLiveAppointmentForLead",
      );
    },
    async insertAppointment(row) {
      const res = await db.from("appointments").insert(row).select("*").single<AppointmentRow>();
      if (res.error?.code === EXCLUSION_VIOLATION) throw new OverlapError();
      if (res.error?.code === UNIQUE_VIOLATION) {
        const existing = await this.getAppointmentByIdempotencyKey(row.idempotency_key);
        if (existing) return existing;
        const live = await this.getLiveAppointmentForLead(row.lead_id);
        if (live) return live;
      }
      return must(res, "insertAppointment");
    },
    async updateAppointment(id, patch) {
      return must(await db.from("appointments").update(patch).eq("id", id).select("*").single<AppointmentRow>(), "updateAppointment");
    },

    async enqueueJob(type, payload, idempotencyKey, runAfter) {
      const res = await db
        .from("jobs")
        .upsert(
          { type, payload, idempotency_key: idempotencyKey, ...(runAfter ? { run_after: runAfter } : {}) },
          { onConflict: "idempotency_key", ignoreDuplicates: true },
        )
        .select("*")
        .maybeSingle<JobRow>();
      if (res.error) throw new Error(`enqueueJob: ${res.error.message}`);
      return res.data;
    },
    async claimJobs(limit, types) {
      return (must(await db.rpc("claim_jobs", { p_limit: limit, p_types: types ?? null }), "claimJobs") ?? []) as JobRow[];
    },
    async completeJob(id) {
      const res = await db.from("jobs").update({ status: "succeeded", locked_at: null, last_error: null }).eq("id", id);
      if (res.error) throw new Error(`completeJob: ${res.error.message}`);
    },
    async failJob(id, error, retryAt) {
      const res = await db
        .from("jobs")
        .update(retryAt ? { status: "failed", last_error: error, run_after: retryAt, locked_at: null } : { status: "dead", last_error: error, locked_at: null })
        .eq("id", id);
      if (res.error) throw new Error(`failJob: ${res.error.message}`);
    },
    async getJobByKey(key) {
      return maybe(await db.from("jobs").select("*").eq("idempotency_key", key).maybeSingle<JobRow>(), "getJobByKey");
    },
    async resetJob(key) {
      const res = await db.from("jobs").update({ status: "pending", attempts: 0, run_after: new Date().toISOString(), last_error: null }).eq("idempotency_key", key);
      if (res.error) throw new Error(`resetJob: ${res.error.message}`);
    },

    async upsertException(e) {
      const existing = maybe(
        await db.from("exceptions").select("id, status").eq("dedupe_key", e.dedupe_key).maybeSingle<{ id: string; status: string }>(),
        "upsertException.find",
      );
      if (existing) {
        // Re-open a resolved item if the same problem happens again.
        const patch = existing.status === "resolved" || existing.status === "dismissed" ? { status: "open", detail: e.detail ?? null } : { detail: e.detail ?? null };
        await db.from("exceptions").update(patch).eq("id", existing.id);
        return existing.id;
      }
      const res = await db.from("exceptions").insert({ severity: "normal", ...e }).select("id").single<{ id: string }>();
      if (res.error?.code === UNIQUE_VIOLATION) {
        return must(await db.from("exceptions").select("id").eq("dedupe_key", e.dedupe_key).single<{ id: string }>(), "upsertException.race").id;
      }
      return must(res, "upsertException").id;
    },
    async recordIntegrationEvent(e) {
      const row = { direction: "inbound", ...e, payload: redact(e.payload ?? {}) };
      const res = await db.from("integration_events").insert(row).select("id, status").single<{ id: string; status: string }>();
      if (res.error?.code === UNIQUE_VIOLATION) {
        const ex = must(
          await db.from("integration_events").select("id, status").eq("provider", e.provider).eq("external_event_id", e.external_event_id).single<{ id: string; status: string }>(),
          "recordIntegrationEvent.dup",
        );
        return { id: ex.id, duplicate: true, status: ex.status };
      }
      const created = must(res, "recordIntegrationEvent");
      return { id: created.id, duplicate: false, status: created.status };
    },
    async updateIntegrationEvent(id, patch) {
      const res = await db.from("integration_events").update(patch).eq("id", id);
      if (res.error) throw new Error(`updateIntegrationEvent: ${res.error.message}`);
    },
    async recordIntegrationHealth(provider, ok, operation, error, details) {
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = ok
        ? { provider, configured: true, last_success_at: now, last_success_operation: operation, last_checked_at: now, ...(details ? { details } : {}) }
        : { provider, configured: true, last_error_at: now, last_error: error ?? "unknown error", last_checked_at: now, ...(details ? { details } : {}) };
      await db.from("integration_status").upsert(patch);
    },

    async getSetting<T>(key: string) {
      const row = maybe(await db.from("app_settings").select("value").eq("key", key).maybeSingle<{ value: T }>(), "getSetting");
      return row?.value ?? null;
    },
    async listPublishedArticles() {
      const rows = must(
        await db
          .from("knowledge_articles")
          .select("id, slug, category, title, keywords, audience, published_version_id, knowledge_versions!knowledge_articles_published_fk(id, version, spoken_answer)")
          .eq("status", "published")
          .eq("audience", "customer")
          .not("published_version_id", "is", null),
        "listPublishedArticles",
      ) as unknown as {
        id: string; slug: string; category: string; title: string; keywords: string[]; audience: string;
        knowledge_versions: { id: string; version: number; spoken_answer: string } | null;
      }[];
      return rows
        .filter((r) => r.knowledge_versions)
        .map<PublishedArticle>((r) => ({
          id: r.id,
          slug: r.slug,
          category: r.category,
          title: r.title,
          keywords: r.keywords,
          audience: r.audience,
          versionId: r.knowledge_versions!.id,
          version: r.knowledge_versions!.version,
          spokenAnswer: r.knowledge_versions!.spoken_answer,
        }));
    },
    async logUnansweredQuestion(q) {
      const open = maybe(
        await db
          .from("unanswered_questions")
          .select("id, occurrences")
          .eq("question_normalized", q.normalized)
          .in("status", ["unresolved", "in_review"])
          .maybeSingle<{ id: string; occurrences: number }>(),
        "logUnansweredQuestion.find",
      );
      if (open) {
        await db.from("unanswered_questions").update({ occurrences: open.occurrences + 1 }).eq("id", open.id);
        return { id: open.id, created: false };
      }
      const res = await db
        .from("unanswered_questions")
        .insert({ question: q.question, question_normalized: q.normalized, call_id: q.call_id, is_test: q.is_test ?? false })
        .select("id")
        .single<{ id: string }>();
      return { id: must(res, "logUnansweredQuestion").id, created: true };
    },
    async insertCostEvent(e) {
      const res = await db.from("cost_events").upsert(e, { onConflict: "provider,external_id", ignoreDuplicates: true });
      if (res.error) throw new Error(`insertCostEvent: ${res.error.message}`);
    },
    async upsertHubspotDeals(rows) {
      if (!rows.length) return;
      const res = await db.from("hubspot_deals").upsert(rows.map((r) => ({ ...r, synced_at: new Date().toISOString() })));
      if (res.error) throw new Error(`upsertHubspotDeals: ${res.error.message}`);
    },
    async getHubspotDeal(id) {
      return maybe(await db.from("hubspot_deals").select("*").eq("hubspot_deal_id", id).maybeSingle(), "getHubspotDeal");
    },
    async findLeadByHubspotDeal(dealId) {
      return maybe(await db.from("leads").select("*").eq("hubspot_deal_id", dealId).maybeSingle<LeadRow>(), "findLeadByHubspotDeal");
    },
    async getCursor(name) {
      const row = maybe(await db.from("sync_cursors").select("cursor").eq("name", name).maybeSingle<{ cursor: string | null }>(), "getCursor");
      return row?.cursor ?? null;
    },
    async setCursor(name, cursor, error) {
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = error ? { name, last_error_at: now, last_error: error } : { name, cursor, last_success_at: now, last_error: null };
      const res = await db.from("sync_cursors").upsert(patch);
      if (res.error) throw new Error(`setCursor: ${res.error.message}`);
    },
    async insertTeamMessage(m) {
      const res = await db.from("team_messages").insert(m).select("id").single<{ id: string }>();
      if (res.error?.code === UNIQUE_VIOLATION) {
        return { id: must(await db.from("team_messages").select("id").eq("dedupe_key", m.dedupe_key).single<{ id: string }>(), "insertTeamMessage.dup").id, created: false };
      }
      return { id: must(res, "insertTeamMessage").id, created: true };
    },
    async markTeamMessageDelivered(id, via) {
      const res = await db.from("team_messages").update({ delivered_via: via, delivered_at: new Date().toISOString() }).eq("id", id);
      if (res.error) throw new Error(`markTeamMessageDelivered: ${res.error.message}`);
    },
    async getTeamMessage(id) {
      return maybe(await db.from("team_messages").select("*").eq("id", id).maybeSingle(), "getTeamMessage");
    },
    async findDesignerByName(name) {
      const first = name.trim().split(/\s+/)[0];
      if (!first) return null;
      const rows = maybe(await db.from("designers").select("*").eq("active", true).ilike("name", `${first}%`).limit(2).returns<DesignerRow[]>(), "findDesignerByName") ?? [];
      return rows.length === 1 ? rows[0] : null; // ambiguous names are left for a person to route
    },
    async getException(id) {
      return maybe(await db.from("exceptions").select("*").eq("id", id).maybeSingle(), "getException");
    },
    async updateException(id, patch) {
      const res = await db.from("exceptions").update(patch).eq("id", id);
      if (res.error) throw new Error(`updateException: ${res.error.message}`);
    },
    async markExceptionNotified(id) {
      const res = await db.from("exceptions").update({ notified_at: new Date().toISOString() }).eq("id", id).is("notified_at", null);
      if (res.error) throw new Error(`markExceptionNotified: ${res.error.message}`);
    },
    async recordPolicyEvent(e) {
      const res = await db.from("policy_events").insert({ ...e, detail: redact(e.detail ?? {}) });
      if (res.error) throw new Error(`recordPolicyEvent: ${res.error.message}`);
    },
    async audit(e) {
      await db.from("audit_log").insert({ ...e, before: redact(e.before ?? null), after: redact(e.after ?? null) });
    },
  };
}

let cached: Store | null = null;
export function store(): Store {
  return (cached ??= supabaseStore());
}
