-- Aangan Studio: core schema
-- Every table uses UUID keys. Live production data is separated from test fixtures by
-- `is_test` (fixtures / regression replays) and `production_call` (calls placed after launch).

-- Aangan lives in its own schema so it can share a Supabase project with other apps
-- (the project's public schema belongs to other applications).
create schema if not exists aangan;
create schema if not exists extensions;
set search_path = aangan, public, extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type app_role as enum ('founder', 'operator', 'admin');
create type call_type as enum (
  'new_enquiry', 'existing_project_complaint', 'existing_lead_follow_up',
  'callback_request', 'general_question', 'unknown'
);
create type call_status as enum ('in_progress', 'completed', 'failed', 'missed', 'disconnected');
create type qualification_status as enum ('green', 'amber', 'red', 'needs_clarification', 'needs_review', 'not_evaluated');
create type appointment_status as enum ('pending', 'confirmed', 'conflict', 'failed', 'cancelled', 'rescheduled', 'completed', 'no_show');
create type email_status as enum ('not_sent', 'queued', 'sent', 'failed', 'not_possible');
create type exception_status as enum ('open', 'in_review', 'resolved', 'dismissed');
create type exception_kind as enum (
  'ambiguous_qualification', 'unanswered_question', 'complaint', 'calendar_failure',
  'email_failure', 'hubspot_failure', 'missing_information', 'pricing_violation',
  'failed_call', 'follow_up_required', 'booking_not_completed'
);
create type job_status as enum ('pending', 'running', 'succeeded', 'failed', 'dead');
create type knowledge_status as enum ('draft', 'in_review', 'approved', 'published', 'rejected', 'archived');

-- ---------------------------------------------------------------------------
-- Users and roles
-- ---------------------------------------------------------------------------
create table app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text,
  roles app_role[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Designers and calendar credentials
-- ---------------------------------------------------------------------------
create table designers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  hubspot_owner_id text,
  calendar_id text,
  google_credential_id uuid,
  active boolean not null default true,
  booking_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- OAuth refresh tokens live here, encrypted (AES-256-GCM with TOKEN_ENCRYPTION_KEY).
-- No RLS policy grants access: only the server (secret key) can read it.
create table google_credentials (
  id uuid primary key default gen_random_uuid(),
  google_account_email text not null unique,
  refresh_token_encrypted text not null,
  access_token_encrypted text,
  access_token_expires_at timestamptz,
  scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'revoked', 'error')),
  last_error text,
  connected_by uuid references app_users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table designers
  add constraint designers_google_credential_fk foreign key (google_credential_id)
  references google_credentials (id) on delete set null;

create table oauth_states (
  state text primary key,
  designer_id uuid references designers (id) on delete cascade,
  created_by uuid references app_users (id),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Calls
-- ---------------------------------------------------------------------------
create table calls (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'vaani',
  provider_call_id text,
  call_type call_type not null default 'unknown',
  caller_phone text,               -- as delivered by provider (Vaani masks numbers)
  caller_phone_normalized text,    -- E.164 when the caller states a callback number
  started_at timestamptz,
  answered boolean,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  status call_status not null default 'in_progress',
  failure_reason text,
  summary text,
  recording_reference text,
  provider_metadata jsonb not null default '{}'::jsonb,
  intake jsonb not null default '{}'::jsonb,   -- structured fields captured live by tools
  processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processing', 'processed', 'failed', 'skipped')),
  processing_error text,
  lead_id uuid,
  related_call_id uuid references calls (id),  -- reconnect after a drop
  production_call boolean not null default true,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calls_provider_call_unique unique (provider, provider_call_id)
);

-- Transcripts are kept apart so founders see aggregates without raw conversation access.
create table call_transcripts (
  call_id uuid primary key references calls (id) on delete cascade,
  transcript text,
  turns jsonb,
  source text not null default 'provider_webhook',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
create table leads (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone text,
  phone_normalized text,
  email text,
  location text,
  locality text,
  service_zone text check (service_zone in ('pune', 'pcmc', 'outside', 'unknown')),
  project_segment text check (project_segment in ('residential', 'commercial', 'unknown')),
  project_type text,
  project_scope text,
  property_area_sqft integer check (property_area_sqft is null or property_area_sqft > 0),
  current_property_state text,
  timeline text,
  required_completion_date date,
  budget_volunteered boolean not null default false,
  budget_notes text,
  decision_maker_status text,
  is_rented boolean,
  qualification_status qualification_status not null default 'not_evaluated',
  qualification_reasons jsonb not null default '[]'::jsonb,
  uncertainties jsonb not null default '[]'::jsonb,
  hubspot_contact_id text,
  hubspot_deal_id text,
  hubspot_sync_status text not null default 'not_required'
    check (hubspot_sync_status in ('not_required', 'pending', 'synced', 'failed')),
  hubspot_last_synced_at timestamptz,
  assigned_designer_id uuid references designers (id),
  first_call_id uuid references calls (id),
  last_call_id uuid references calls (id),
  source text not null default 'phone_voice_ai',
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table calls add constraint calls_lead_fk foreign key (lead_id) references leads (id) on delete set null;
-- One live lead per caller number: reconnects and repeat calls update rather than duplicate.
create unique index leads_phone_unique on leads (phone_normalized) where phone_normalized is not null and is_test = false;

create table call_qualifications (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls (id) on delete cascade,
  lead_id uuid references leads (id) on delete cascade,
  status qualification_status not null,
  criteria jsonb not null,          -- per-criterion pass / fail / unclear with reason codes
  reasons jsonb not null default '[]'::jsonb,
  uncertainties jsonb not null default '[]'::jsonb,
  facts jsonb not null,             -- the validated structured input the rules ran on
  rules_version text not null,
  config_hash text not null,
  evaluated_by text not null default 'rules_engine',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Appointments
-- ---------------------------------------------------------------------------
create table appointments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads (id) on delete cascade,
  call_id uuid references calls (id),
  designer_id uuid references designers (id),
  calendar_provider text not null default 'google',
  provider_calendar_id text,
  provider_event_id text unique,
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text not null default 'Asia/Kolkata',
  meeting_type text not null default 'site_visit',
  status appointment_status not null default 'pending',
  failure_reason text,
  idempotency_key text not null unique,
  confirmation_email_status email_status not null default 'not_sent',
  confirmation_email_sent_at timestamptz,
  confirmation_email_provider_id text,
  rescheduled_from_id uuid references appointments (id),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_time_order check (end_at > start_at)
);
-- No designer can hold two live consultations that overlap.
alter table appointments add constraint appointments_no_overlap
  exclude using gist (designer_id with =, tstzrange(start_at, end_at) with &&)
  where (status in ('pending', 'confirmed'));
-- A lead holds at most one upcoming live consultation.
create unique index appointments_one_live_per_lead on appointments (lead_id)
  where status in ('pending', 'confirmed');

-- ---------------------------------------------------------------------------
-- Funnel events
-- ---------------------------------------------------------------------------
create table lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads (id) on delete cascade,
  call_id uuid references calls (id) on delete cascade,
  event_type text not null check (event_type in (
    'call_answered', 'qualified', 'rejected', 'needs_review', 'booked', 'rescheduled',
    'cancelled', 'consultation_completed', 'deal_opened', 'won', 'lost', 'escalated'
  )),
  occurred_at timestamptz not null default now(),
  dedupe_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  constraint lead_events_dedupe unique (event_type, dedupe_key)
);

-- ---------------------------------------------------------------------------
-- Integration events, job queue, health
-- ---------------------------------------------------------------------------
create table integration_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_type text not null,
  external_event_id text not null,
  direction text not null default 'inbound' check (direction in ('inbound', 'outbound')),
  status text not null default 'received'
    check (status in ('received', 'processing', 'succeeded', 'failed', 'ignored')),
  retry_count integer not null default 0,
  requires_human boolean not null default false,
  related_call_id uuid references calls (id) on delete set null,
  related_lead_id uuid references leads (id) on delete set null,
  external_record_id text,
  payload jsonb not null default '{}'::jsonb,    -- redacted before storage
  safe_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint integration_events_unique unique (provider, external_event_id)
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  status job_status not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 6,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table integration_status (
  provider text primary key,
  configured boolean not null default false,
  last_success_at timestamptz,
  last_success_operation text,
  last_error_at timestamptz,
  last_error text,
  last_checked_at timestamptz,
  details jsonb not null default '{}'::jsonb
);

create table sync_cursors (
  name text primary key,
  cursor text,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text
);

-- ---------------------------------------------------------------------------
-- HubSpot deal mirror (HubSpot stays the source of truth; this is a read cache)
-- ---------------------------------------------------------------------------
create table hubspot_deals (
  hubspot_deal_id text primary key,
  lead_id uuid references leads (id) on delete set null,
  deal_name text,
  amount numeric(14, 2),
  currency text,
  pipeline_id text,
  stage_id text,
  stage_label text,
  stage_probability numeric(5, 4),
  is_closed boolean not null default false,
  is_won boolean not null default false,
  hubspot_owner_id text,
  designer_id uuid references designers (id),
  close_date timestamptz,
  created_in_hubspot_at timestamptz,
  last_modified_at timestamptz,
  is_aangan_voice_lead boolean not null default false,
  raw_properties jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Review / exception queue
-- ---------------------------------------------------------------------------
create table exceptions (
  id uuid primary key default gen_random_uuid(),
  kind exception_kind not null,
  status exception_status not null default 'open',
  severity text not null default 'normal' check (severity in ('low', 'normal', 'high', 'critical')),
  title text not null,
  detail text,
  call_id uuid references calls (id) on delete set null,
  lead_id uuid references leads (id) on delete set null,
  appointment_id uuid references appointments (id) on delete set null,
  job_id uuid references jobs (id) on delete set null,
  unanswered_question_id uuid,
  owner_id uuid references app_users (id),
  due_at timestamptz,
  acknowledged_at timestamptz,
  resolution text,
  resolved_by uuid references app_users (id),
  resolved_at timestamptz,
  retryable boolean not null default false,
  dedupe_key text not null unique,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table exception_notes (
  id uuid primary key default gen_random_uuid(),
  exception_id uuid not null references exceptions (id) on delete cascade,
  author_id uuid references app_users (id),
  body text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Knowledge base (human-approved, versioned)
-- ---------------------------------------------------------------------------
create table knowledge_articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  category text not null check (category in (
    'service', 'service_area', 'timeline', 'faq', 'qualification_policy',
    'pricing_policy', 'fallback', 'escalation_policy', 'brand_voice', 'closure'
  )),
  title text not null,
  audience text not null default 'customer' check (audience in ('customer', 'internal')),
  keywords text[] not null default '{}',
  published_version_id uuid,
  status knowledge_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table knowledge_versions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references knowledge_articles (id) on delete cascade,
  version integer not null,
  spoken_answer text not null,     -- what the voice agent may say, verbatim
  internal_notes text,
  status knowledge_status not null default 'draft',
  source_reference text,           -- e.g. services.md §Timelines, or unanswered question id
  test_results jsonb,
  created_by uuid references app_users (id),
  approved_by uuid references app_users (id),
  approved_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  constraint knowledge_versions_unique unique (article_id, version)
);
alter table knowledge_articles add constraint knowledge_articles_published_fk
  foreign key (published_version_id) references knowledge_versions (id) on delete set null;

create table unanswered_questions (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls (id) on delete set null,
  question text not null,
  question_normalized text not null,
  occurrences integer not null default 1,
  status text not null default 'unresolved'
    check (status in ('unresolved', 'in_review', 'answered', 'rejected', 'duplicate')),
  proposed_answer text,
  approved_answer text,
  reviewer_id uuid references app_users (id),
  reviewed_at timestamptz,
  knowledge_article_id uuid references knowledge_articles (id),
  knowledge_version_id uuid references knowledge_versions (id),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index unanswered_questions_open_unique on unanswered_questions (question_normalized)
  where status in ('unresolved', 'in_review');
alter table exceptions add constraint exceptions_unanswered_fk foreign key (unanswered_question_id)
  references unanswered_questions (id) on delete set null;

-- Restricted internal documents (e.g. the numeric pricing guide). Admin-only; never
-- loaded into any customer-facing context.
create table restricted_documents (
  slug text primary key,
  title text not null,
  body text not null,
  updated_by uuid references app_users (id),
  updated_at timestamptz not null default now()
);

-- Pricing-policy and other safety events (deflections, blocked or detected disclosures).
create table policy_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls (id) on delete set null,
  kind text not null check (kind in (
    'pricing_request_deflected', 'pricing_disclosure_blocked', 'pricing_disclosure_detected',
    'pricing_scan_unavailable', 'fallback_answer_given'
  )),
  detail jsonb not null default '{}'::jsonb,
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);
create index policy_events_kind_time_idx on policy_events (kind, created_at);

-- ---------------------------------------------------------------------------
-- Costs, settings, audit, rate limits
-- ---------------------------------------------------------------------------
create table cost_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  usage_type text not null,
  units numeric(14, 4),
  unit_label text,
  unit_rate numeric(14, 6),
  cost_amount numeric(14, 4) not null,
  currency text not null default 'INR',
  is_estimate boolean not null,          -- false only when the provider reported the cost
  usage_at timestamptz not null,
  source text not null,                  -- e.g. 'vaani:usage.charged', 'gemini:usage_metadata'
  external_id text,
  call_id uuid references calls (id) on delete set null,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  constraint cost_events_external_unique unique (provider, external_id)
);

create table app_settings (
  key text primary key,
  value jsonb not null,
  version integer not null default 1,
  updated_by uuid references app_users (id),
  updated_at timestamptz not null default now()
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references app_users (id),
  actor_label text,
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create table rate_limit_buckets (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index calls_started_at_idx on calls (started_at desc);
create index calls_status_idx on calls (status);
create index calls_processing_idx on calls (processing_status) where processing_status in ('pending', 'failed');
create index leads_status_idx on leads (qualification_status);
create index leads_designer_idx on leads (assigned_designer_id);
create index leads_hubspot_contact_idx on leads (hubspot_contact_id);
create index leads_hubspot_deal_idx on leads (hubspot_deal_id);
create index leads_email_idx on leads (lower(email));
create index appointments_start_idx on appointments (start_at);
create index appointments_designer_idx on appointments (designer_id, start_at);
create index appointments_email_status_idx on appointments (confirmation_email_status);
create index lead_events_type_time_idx on lead_events (event_type, occurred_at);
create index lead_events_lead_idx on lead_events (lead_id);
create index integration_events_status_idx on integration_events (provider, status);
create index jobs_ready_idx on jobs (status, run_after) where status in ('pending', 'failed');
create index exceptions_status_idx on exceptions (status, kind);
create index exceptions_owner_idx on exceptions (owner_id);
create index hubspot_deals_stage_idx on hubspot_deals (stage_id);
create index hubspot_deals_owner_idx on hubspot_deals (hubspot_owner_id);
create index hubspot_deals_close_idx on hubspot_deals (close_date);
create index cost_events_time_idx on cost_events (usage_at);
create index audit_log_entity_idx on audit_log (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'app_users', 'designers', 'google_credentials', 'calls', 'call_transcripts', 'leads',
    'appointments', 'jobs', 'exceptions', 'knowledge_articles', 'unanswered_questions'
  ] loop
    execute format('create trigger %I_updated_at before update on %I for each row execute function set_updated_at()', t, t);
  end loop;
end $$;
