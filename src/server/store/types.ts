import type { QualificationStatus } from "@/domain/qualification/types";

export type CallType =
  | "new_enquiry" | "existing_project_complaint" | "existing_lead_follow_up"
  | "callback_request" | "general_question" | "unknown";
export type CallStatus = "in_progress" | "completed" | "failed" | "missed" | "disconnected";
export type AppointmentStatus = "pending" | "confirmed" | "conflict" | "failed" | "cancelled" | "rescheduled" | "completed" | "no_show";
export type EmailStatus = "not_sent" | "queued" | "sent" | "failed" | "not_possible";
export type ExceptionKind =
  | "ambiguous_qualification" | "unanswered_question" | "complaint" | "calendar_failure"
  | "email_failure" | "hubspot_failure" | "missing_information" | "pricing_violation"
  | "failed_call" | "follow_up_required" | "booking_not_completed";
export type LeadEventType =
  | "call_answered" | "qualified" | "rejected" | "needs_review" | "booked" | "rescheduled"
  | "cancelled" | "consultation_completed" | "deal_opened" | "won" | "lost" | "escalated";
export type LeadQualificationStatus = QualificationStatus | "not_evaluated";

export interface CallRow {
  id: string;
  provider: string;
  provider_call_id: string | null;
  call_type: CallType;
  caller_phone: string | null;
  caller_phone_normalized: string | null;
  started_at: string | null;
  answered: boolean | null;
  ended_at: string | null;
  duration_seconds: number | null;
  status: CallStatus;
  failure_reason: string | null;
  summary: string | null;
  recording_reference: string | null;
  provider_metadata: Record<string, unknown>;
  intake: Record<string, unknown>;
  processing_status: "pending" | "processing" | "processed" | "failed" | "skipped";
  processing_error: string | null;
  lead_id: string | null;
  related_call_id: string | null;
  production_call: boolean;
  is_test: boolean;
  created_at: string;
}

export interface LeadRow {
  id: string;
  name: string | null;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  location: string | null;
  locality: string | null;
  service_zone: string | null;
  project_segment: string | null;
  project_type: string | null;
  project_scope: string | null;
  property_area_sqft: number | null;
  current_property_state: string | null;
  timeline: string | null;
  required_completion_date: string | null;
  budget_volunteered: boolean;
  budget_notes: string | null;
  decision_maker_status: string | null;
  is_rented: boolean | null;
  qualification_status: LeadQualificationStatus;
  qualification_reasons: unknown[];
  uncertainties: unknown[];
  hubspot_contact_id: string | null;
  hubspot_deal_id: string | null;
  hubspot_sync_status: "not_required" | "pending" | "synced" | "failed";
  hubspot_last_synced_at: string | null;
  assigned_designer_id: string | null;
  handoff_at?: string | null;
  handoff_channel?: string | null;
  decline_category?: "category" | "area" | "budget" | "timeline" | "engagement" | null;
  fit_score?: number | null;
  first_call_id: string | null;
  last_call_id: string | null;
  source: string;
  is_test: boolean;
  created_at: string;
  updated_at: string;
}

export interface DesignerRow {
  id: string;
  name: string;
  email: string | null;
  hubspot_owner_id: string | null;
  calendar_id: string | null;
  google_credential_id: string | null;
  active: boolean;
  booking_enabled: boolean;
}

export interface GoogleCredentialRow {
  id: string;
  google_account_email: string;
  refresh_token_encrypted: string;
  access_token_encrypted: string | null;
  access_token_expires_at: string | null;
  scopes: string[];
  status: "active" | "revoked" | "error";
  last_error: string | null;
}

export interface AppointmentRow {
  id: string;
  lead_id: string;
  call_id: string | null;
  designer_id: string | null;
  calendar_provider: string;
  provider_calendar_id: string | null;
  provider_event_id: string | null;
  start_at: string;
  end_at: string;
  timezone: string;
  meeting_type: string;
  status: AppointmentStatus;
  failure_reason: string | null;
  idempotency_key: string;
  confirmation_email_status: EmailStatus;
  confirmation_email_sent_at: string | null;
  confirmation_email_provider_id: string | null;
  rescheduled_from_id: string | null;
  is_test: boolean;
  created_at: string;
}

export interface JobRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: "pending" | "running" | "succeeded" | "failed" | "dead";
  attempts: number;
  max_attempts: number;
  run_after: string;
  last_error: string | null;
}

export interface ExceptionInput {
  kind: ExceptionKind;
  title: string;
  detail?: string | null;
  severity?: "low" | "normal" | "high" | "critical";
  call_id?: string | null;
  lead_id?: string | null;
  appointment_id?: string | null;
  job_id?: string | null;
  unanswered_question_id?: string | null;
  due_at?: string | null;
  retryable?: boolean;
  lane?: "designer" | "admin" | "callback" | "complaint";
  dedupe_key: string;
  is_test?: boolean;
}

export interface ExceptionRow extends ExceptionInput {
  id: string;
  status: "open" | "in_review" | "resolved" | "dismissed";
  decision?: string | null;
  resolution?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
  notified_at?: string | null;
  created_at?: string;
}

export interface TeamMessageInput {
  call_id: string | null;
  caller_name: string | null;
  caller_phone: string | null;
  message_type: "project_update" | "designer_request" | "callback_request" | "other";
  for_designer_id: string | null;
  for_name: string | null;
  about: string;
  callback_window: string | null;
  dedupe_key: string;
  is_test?: boolean;
}

export interface PublishedArticle {
  id: string;
  slug: string;
  category: string;
  title: string;
  keywords: string[];
  audience: string;
  versionId: string;
  version: number;
  spokenAnswer: string;
}

export interface HubspotDealUpsert {
  hubspot_deal_id: string;
  lead_id: string | null;
  deal_name: string | null;
  amount: number | null;
  currency: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  stage_label: string | null;
  stage_probability: number | null;
  is_closed: boolean;
  is_won: boolean;
  hubspot_owner_id: string | null;
  designer_id: string | null;
  close_date: string | null;
  created_in_hubspot_at: string | null;
  last_modified_at: string | null;
  is_aangan_voice_lead: boolean;
  raw_properties: Record<string, unknown>;
}

export interface CostEventInput {
  provider: string;
  usage_type: string;
  units: number | null;
  unit_label: string | null;
  unit_rate: number | null;
  cost_amount: number;
  currency: string;
  is_estimate: boolean;
  usage_at: string;
  source: string;
  external_id: string | null;
  call_id: string | null;
  is_test?: boolean;
}

export class OverlapError extends Error {
  constructor() {
    super("Appointment overlaps an existing booking for this designer");
  }
}

/** Narrow persistence interface used by workflows. Supabase in production, memory in tests. */
export interface Store {
  // calls
  getCall(id: string): Promise<CallRow | null>;
  getCallByProviderId(provider: string, providerCallId: string): Promise<CallRow | null>;
  /** Insert-or-get by (provider, provider_call_id); never creates duplicates on retries. */
  ensureCall(provider: string, providerCallId: string, init: Partial<CallRow>): Promise<{ call: CallRow; created: boolean }>;
  updateCall(id: string, patch: Partial<CallRow>): Promise<CallRow>;
  findRecentCallFromPhone(phoneNormalized: string, sinceIso: string, excludeCallId: string): Promise<CallRow | null>;
  saveTranscript(callId: string, transcript: string | null, turns: unknown, source: string): Promise<void>;
  getTranscript(callId: string): Promise<{ transcript: string | null; turns: unknown } | null>;

  // leads
  getLead(id: string): Promise<LeadRow | null>;
  findLeadByPhone(phoneNormalized: string): Promise<LeadRow | null>;
  findLeadByEmail(email: string): Promise<LeadRow | null>;
  insertLead(row: Partial<LeadRow>): Promise<LeadRow>;
  updateLead(id: string, patch: Partial<LeadRow>): Promise<LeadRow>;
  insertQualification(row: Record<string, unknown>): Promise<void>;
  latestQualificationForCall(callId: string): Promise<{ status: string; criteria: unknown } | null>;
  addLeadEvent(e: { lead_id: string | null; call_id: string | null; event_type: LeadEventType; dedupe_key: string; occurred_at?: string; metadata?: Record<string, unknown>; is_test?: boolean }): Promise<boolean>;

  // designers & calendar
  listBookableDesigners(): Promise<DesignerRow[]>;
  getDesigner(id: string): Promise<DesignerRow | null>;
  getDesignerByHubspotOwner(ownerId: string): Promise<DesignerRow | null>;
  getGoogleCredential(id: string): Promise<GoogleCredentialRow | null>;
  updateGoogleCredential(id: string, patch: Partial<GoogleCredentialRow>): Promise<void>;
  countUpcomingAppointments(designerId: string, fromIso: string): Promise<number>;

  // appointments
  getAppointment(id: string): Promise<AppointmentRow | null>;
  getAppointmentByIdempotencyKey(key: string): Promise<AppointmentRow | null>;
  getLiveAppointmentForLead(leadId: string): Promise<AppointmentRow | null>;
  /** Throws OverlapError when the designer already holds an overlapping live booking. */
  insertAppointment(row: Partial<AppointmentRow> & { lead_id: string; start_at: string; end_at: string; idempotency_key: string }): Promise<AppointmentRow>;
  updateAppointment(id: string, patch: Partial<AppointmentRow>): Promise<AppointmentRow>;

  // queue
  enqueueJob(type: string, payload: Record<string, unknown>, idempotencyKey: string, runAfter?: string): Promise<JobRow | null>;
  claimJobs(limit: number, types?: string[]): Promise<JobRow[]>;
  completeJob(id: string): Promise<void>;
  failJob(id: string, error: string, retryAt: string | null): Promise<void>;
  getJobByKey(key: string): Promise<JobRow | null>;
  resetJob(key: string): Promise<void>;

  // exceptions & events
  upsertException(e: ExceptionInput): Promise<string>;
  /** Returns false when the (provider, external id) was already recorded (duplicate delivery). */
  recordIntegrationEvent(e: { provider: string; event_type: string; external_event_id: string; direction?: "inbound" | "outbound"; payload?: unknown; related_call_id?: string | null; related_lead_id?: string | null }): Promise<{ id: string; duplicate: boolean; status: string }>;
  updateIntegrationEvent(id: string, patch: { status?: string; safe_error?: string | null; retry_count?: number; requires_human?: boolean; external_record_id?: string | null; processed_at?: string; related_call_id?: string | null }): Promise<void>;
  recordIntegrationHealth(provider: string, ok: boolean, operation: string, error?: string | null, details?: Record<string, unknown>): Promise<void>;

  // settings / knowledge / costs / hubspot mirror / audit
  getSetting<T>(key: string): Promise<T | null>;
  listPublishedArticles(): Promise<PublishedArticle[]>;
  logUnansweredQuestion(q: { question: string; normalized: string; call_id: string | null; is_test?: boolean }): Promise<{ id: string; created: boolean }>;
  insertCostEvent(e: CostEventInput): Promise<void>;
  upsertHubspotDeals(rows: HubspotDealUpsert[]): Promise<void>;
  getHubspotDeal(id: string): Promise<HubspotDealUpsert | null>;
  findLeadByHubspotDeal(dealId: string): Promise<LeadRow | null>;
  getCursor(name: string): Promise<string | null>;
  setCursor(name: string, cursor: string | null, error?: string | null): Promise<void>;
  insertTeamMessage(m: TeamMessageInput): Promise<{ id: string; created: boolean }>;
  markTeamMessageDelivered(id: string, via: string): Promise<void>;
  getTeamMessage(id: string): Promise<(TeamMessageInput & { id: string }) | null>;
  findDesignerByName(name: string): Promise<DesignerRow | null>;
  markExceptionNotified(id: string): Promise<void>;
  getException(id: string): Promise<ExceptionRow | null>;
  updateException(id: string, patch: Partial<ExceptionRow>): Promise<void>;
  recordPolicyEvent(e: { call_id: string | null; kind: "pricing_request_deflected" | "pricing_disclosure_blocked" | "pricing_disclosure_detected" | "pricing_scan_unavailable" | "fallback_answer_given"; detail?: Record<string, unknown>; is_test?: boolean }): Promise<void>;
  audit(e: { actor_id: string | null; actor_label?: string; action: string; entity_type: string; entity_id?: string | null; before?: unknown; after?: unknown }): Promise<void>;
}
