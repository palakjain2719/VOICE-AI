-- Row Level Security, role helpers, job queue, rate limiting and dashboard aggregates.
--
-- Roles:
--   founder  - business dashboards, pipeline, costs, exception queue (read)
--   operator - call analytics incl. transcripts, works the exception queue
--   admin    - everything above plus knowledge base, settings, integrations, users
--
-- Integrations write with the Supabase secret key from trusted server code (bypasses RLS).
-- Browser sessions only ever get what these policies allow.

set search_path = aangan, public, extensions;

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------
create or replace function aangan.has_role(r app_role) returns boolean
language sql stable security definer set search_path = aangan, public as $$
  select exists (
    select 1 from app_users u
    where u.id = auth.uid() and u.active and (r = any (u.roles) or 'admin' = any (u.roles))
  );
$$;

create or replace function aangan.is_staff() returns boolean
language sql stable security definer set search_path = aangan, public as $$
  select exists (
    select 1 from app_users u
    where u.id = auth.uid() and u.active and cardinality(u.roles) > 0
  );
$$;

revoke all on function aangan.has_role(app_role) from public;
revoke all on function aangan.is_staff() from public;
grant execute on function aangan.has_role(app_role) to authenticated;
grant execute on function aangan.is_staff() to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'app_users', 'designers', 'google_credentials', 'oauth_states', 'calls', 'call_transcripts',
    'leads', 'call_qualifications', 'appointments', 'lead_events', 'integration_events', 'jobs',
    'integration_status', 'sync_cursors', 'hubspot_deals', 'exceptions', 'exception_notes',
    'knowledge_articles', 'knowledge_versions', 'unanswered_questions', 'restricted_documents',
    'cost_events', 'app_settings', 'audit_log', 'rate_limit_buckets', 'policy_events'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- google_credentials, oauth_states, rate_limit_buckets: intentionally no policies.
-- Only the server (secret key) may touch them.

-- app_users
create policy app_users_self_read on app_users for select to authenticated
  using (id = auth.uid() or has_role('admin'));
create policy app_users_admin_write on app_users for all to authenticated
  using (has_role('admin')) with check (has_role('admin'));

-- Staff-readable business tables
do $$
declare t text;
begin
  foreach t in array array[
    'designers', 'calls', 'leads', 'call_qualifications', 'appointments', 'lead_events',
    'integration_status', 'sync_cursors', 'hubspot_deals', 'exceptions', 'exception_notes',
    'knowledge_articles', 'knowledge_versions', 'unanswered_questions', 'cost_events', 'app_settings', 'policy_events'
  ] loop
    execute format('create policy %I on %I for select to authenticated using (is_staff())', t || '_staff_read', t);
  end loop;
end $$;

-- Raw conversation content: operators and admins only.
create policy call_transcripts_ops_read on call_transcripts for select to authenticated
  using (has_role('operator'));
create policy integration_events_ops_read on integration_events for select to authenticated
  using (has_role('operator'));
create policy jobs_ops_read on jobs for select to authenticated
  using (has_role('operator'));

-- Exception queue: operators work it.
create policy exceptions_ops_update on exceptions for update to authenticated
  using (has_role('operator')) with check (has_role('operator'));
create policy exception_notes_ops_insert on exception_notes for insert to authenticated
  with check (has_role('operator') and author_id = auth.uid());

-- Admin-managed configuration and knowledge.
do $$
declare t text;
begin
  foreach t in array array['designers', 'knowledge_articles', 'knowledge_versions', 'unanswered_questions', 'app_settings'] loop
    execute format('create policy %I on %I for all to authenticated using (has_role(''admin'')) with check (has_role(''admin''))', t || '_admin_write', t);
  end loop;
end $$;

create policy restricted_documents_admin_read on restricted_documents for select to authenticated
  using (has_role('admin'));
create policy audit_log_admin_read on audit_log for select to authenticated
  using (has_role('admin'));

-- ---------------------------------------------------------------------------
-- Job queue: claim with SKIP LOCKED; reclaim jobs stuck in `running` for 10 minutes.
-- ---------------------------------------------------------------------------
create or replace function aangan.claim_jobs(p_limit integer, p_types text[] default null)
returns setof jobs language sql volatile set search_path = aangan, public as $$
  update jobs j
     set status = 'running', locked_at = now(), attempts = j.attempts + 1
   where j.id in (
     select id from jobs
      where ((status in ('pending', 'failed') and run_after <= now())
             or (status = 'running' and locked_at < now() - interval '10 minutes'))
        and attempts < max_attempts
        and (p_types is null or type = any (p_types))
      order by run_after
      for update skip locked
      limit greatest(p_limit, 0)
   )
  returning j.*;
$$;
revoke all on function aangan.claim_jobs(integer, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixed-window rate limiting shared across serverless instances.
-- Returns true when the hit is allowed.
-- ---------------------------------------------------------------------------
create or replace function aangan.rate_limit_hit(p_bucket text, p_window_seconds integer, p_max integer)
returns boolean language plpgsql volatile set search_path = aangan, public as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  n integer;
begin
  insert into rate_limit_buckets (bucket, window_start, hits) values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update set hits = rate_limit_buckets.hits + 1
  returning hits into n;
  delete from rate_limit_buckets where window_start < now() - interval '1 day';
  return n <= p_max;
end $$;
revoke all on function aangan.rate_limit_hit(text, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Dashboard aggregates (security invoker: RLS applies to the caller)
--
-- Period basis: calls count by started_at; funnel stages count distinct leads whose
-- stage event occurred inside the period. Test fixtures and non-production calls are
-- always excluded.
-- ---------------------------------------------------------------------------
create or replace function aangan.dashboard_funnel(
  p_from timestamptz,
  p_to timestamptz,
  p_designer uuid default null,
  p_project_type text default null,
  p_status qualification_status default null
) returns jsonb language sql stable security invoker set search_path = aangan, public as $$
  with lead_filter as (
    select l.id from leads l
     where not l.is_test
       and (p_designer is null or l.assigned_designer_id = p_designer)
       and (p_project_type is null or l.project_type = p_project_type)
       and (p_status is null or l.qualification_status = p_status)
  ),
  fc as (
    select c.* from calls c
     where c.production_call and not c.is_test
       and c.started_at >= p_from and c.started_at < p_to
       and ((p_designer is null and p_project_type is null and p_status is null)
            or c.lead_id in (select id from lead_filter))
  ),
  latest_q as (
    select distinct on (q.call_id) q.call_id, q.status
      from call_qualifications q join fc on fc.id = q.call_id
     order by q.call_id, q.created_at desc
  ),
  ev as (
    select e.event_type, count(distinct e.lead_id) as n
      from lead_events e
     where not e.is_test and e.occurred_at >= p_from and e.occurred_at < p_to
       and e.lead_id in (select id from lead_filter)
     group by e.event_type
  )
  select jsonb_build_object(
    'incoming', (select count(*) from fc),
    'answered', (select count(*) from fc where answered),
    'failed', (select count(*) from fc where status in ('failed', 'missed')),
    'disconnected', (select count(*) from fc where status = 'disconnected'),
    'new_enquiries_answered', (select count(*) from fc where answered and call_type = 'new_enquiry'),
    'new_enquiries_evaluated', (select count(*) from fc join latest_q on latest_q.call_id = fc.id where fc.answered and fc.call_type = 'new_enquiry' and latest_q.status in ('green', 'amber', 'red')),
    'complaints', (select count(*) from fc where call_type = 'existing_project_complaint'),
    'green', (select count(*) from latest_q where status = 'green'),
    'amber', (select count(*) from latest_q where status = 'amber'),
    'red', (select count(*) from latest_q where status = 'red'),
    'needs_review', (select count(*) from latest_q where status in ('needs_review', 'needs_clarification')),
    'qualified', coalesce((select n from ev where event_type = 'qualified'), 0),
    'booked', coalesce((select n from ev where event_type = 'booked'), 0),
    'consultation_completed', coalesce((select n from ev where event_type = 'consultation_completed'), 0),
    'deal_opened', coalesce((select n from ev where event_type = 'deal_opened'), 0),
    'won', coalesce((select n from ev where event_type = 'won'), 0),
    'lost', coalesce((select n from ev where event_type = 'lost'), 0)
  );
$$;

create or replace function aangan.dashboard_costs(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security invoker set search_path = aangan, public as $$
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
    select provider, usage_type, currency, is_estimate,
           sum(cost_amount) as cost_amount, sum(units) as units, count(*) as events
      from cost_events
     where not is_test and usage_at >= p_from and usage_at < p_to
     group by provider, usage_type, currency, is_estimate
     order by provider, usage_type
  ) t;
$$;

grant execute on function aangan.dashboard_funnel(timestamptz, timestamptz, uuid, text, qualification_status) to authenticated;
grant execute on function aangan.dashboard_costs(timestamptz, timestamptz) to authenticated;
