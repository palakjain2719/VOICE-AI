-- Operational views: review lanes, team messages, designer handoff, to-dos, AI summaries,
-- and the KPI / demand aggregates behind the Today and KPIs pages.
set search_path = aangan, public, extensions;

alter type app_role add value if not exists 'designer';

-- Designers can sign in and see their own view.
alter table designers add column if not exists app_user_id uuid references app_users (id) on delete set null;
create unique index if not exists designers_app_user_unique on designers (app_user_id) where app_user_id is not null;

-- ---------------------------------------------------------------------------
-- Review lanes: who has to act on an exception
-- ---------------------------------------------------------------------------
alter table exceptions add column if not exists lane text
  check (lane in ('designer', 'admin', 'callback', 'complaint'));
alter table exceptions add column if not exists notified_at timestamptz;
alter table exceptions add column if not exists decision text
  check (decision in ('approved', 'rejected', 'routed_admin', 'routed_callback', 'routed_designer'));

create or replace function exception_default_lane() returns trigger language plpgsql as $$
begin
  if new.lane is null then
    new.lane := case new.kind
      when 'ambiguous_qualification' then 'designer'
      when 'complaint' then 'complaint'
      when 'failed_call' then 'callback'
      when 'follow_up_required' then 'callback'
      when 'missing_information' then 'callback'
      when 'booking_not_completed' then 'callback'
      else 'admin'
    end;
  end if;
  return new;
end $$;
drop trigger if exists exceptions_default_lane on exceptions;
create trigger exceptions_default_lane before insert on exceptions for each row execute function exception_default_lane();
update exceptions set lane = case kind
  when 'ambiguous_qualification' then 'designer' when 'complaint' then 'complaint'
  when 'failed_call' then 'callback' when 'follow_up_required' then 'callback'
  when 'missing_information' then 'callback' when 'booking_not_completed' then 'callback' else 'admin' end
where lane is null;
create index if not exists exceptions_lane_idx on exceptions (lane, status);

-- ---------------------------------------------------------------------------
-- Leads: designer handoff time, decline category, transparent fit score
-- ---------------------------------------------------------------------------
alter table leads add column if not exists handoff_at timestamptz;
alter table leads add column if not exists handoff_channel text;
alter table leads add column if not exists decline_category text
  check (decline_category in ('category', 'area', 'budget', 'timeline', 'engagement'));
-- Criteria passed ×20 + unclear ×10 (0–100). Explained in the UI; not a revenue estimate.
alter table leads add column if not exists fit_score integer check (fit_score between 0 and 100);

-- ---------------------------------------------------------------------------
-- Messages left for the team (existing clients, callers asking for a named designer)
-- ---------------------------------------------------------------------------
create table if not exists team_messages (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls (id) on delete set null,
  caller_name text,
  caller_phone text,
  message_type text not null default 'other'
    check (message_type in ('project_update', 'designer_request', 'callback_request', 'other')),
  for_designer_id uuid references designers (id) on delete set null,
  for_name text,
  about text not null,
  callback_window text,
  delivered_via text,          -- 'email' when the recipient was emailed; null = dashboard only
  delivered_at timestamptz,
  status text not null default 'open' check (status in ('open', 'done')),
  done_by uuid references app_users (id),
  done_at timestamptz,
  dedupe_key text not null unique,
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists team_messages_status_idx on team_messages (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Personal to-do list and dismissed suggestions
-- ---------------------------------------------------------------------------
create table if not exists todos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references app_users (id) on delete cascade,
  title text not null check (length(title) between 1 and 300),
  due_date date,
  href text,
  suggestion_key text,
  done boolean not null default false,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists todos_owner_idx on todos (owner_id, done, created_at desc);

create table if not exists suggestion_dismissals (
  owner_id uuid not null references app_users (id) on delete cascade,
  suggestion_key text not null,
  until date not null,
  primary key (owner_id, suggestion_key)
);

-- ---------------------------------------------------------------------------
-- AI summaries (Gemini rewording of counted facts; numbers validated before storing)
-- ---------------------------------------------------------------------------
create table if not exists ai_summaries (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'overview',
  period_label text not null,
  bullets jsonb not null,       -- [{text, href}]
  facts jsonb not null,         -- the counted values the bullets were written from
  generated_by text not null,   -- 'gemini:<model>' or 'rules'
  created_at timestamptz not null default now()
);
create index if not exists ai_summaries_scope_idx on ai_summaries (scope, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS for the new tables
-- ---------------------------------------------------------------------------
alter table team_messages enable row level security;
alter table team_messages force row level security;
alter table todos enable row level security;
alter table todos force row level security;
alter table suggestion_dismissals enable row level security;
alter table suggestion_dismissals force row level security;
alter table ai_summaries enable row level security;
alter table ai_summaries force row level security;

drop policy if exists team_messages_staff_read on team_messages;
create policy team_messages_staff_read on team_messages for select to authenticated using (is_staff());
drop policy if exists team_messages_ops_update on team_messages;
create policy team_messages_ops_update on team_messages for update to authenticated using (has_role('operator')) with check (has_role('operator'));
drop policy if exists todos_owner on todos;
create policy todos_owner on todos for all to authenticated using (owner_id = auth.uid() and is_staff()) with check (owner_id = auth.uid() and is_staff());
drop policy if exists dismissals_owner on suggestion_dismissals;
create policy dismissals_owner on suggestion_dismissals for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists ai_summaries_staff_read on ai_summaries;
create policy ai_summaries_staff_read on ai_summaries for select to authenticated using (is_staff());

grant select, insert, update, delete on team_messages, todos, suggestion_dismissals, ai_summaries to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- KPI aggregates
-- ---------------------------------------------------------------------------
create or replace function dashboard_kpis(
  p_from timestamptz,
  p_to timestamptz,
  p_tz text default 'Asia/Kolkata',
  p_open_minute integer default 600,     -- 10:00
  p_close_minute integer default 1140,   -- 19:00
  p_open_dows integer[] default array[1, 2, 3, 4, 5, 6]  -- Mon–Sat (0 = Sunday)
) returns jsonb language sql stable security invoker set search_path = aangan, public as $$
  with fc as (
    select c.*, (c.started_at at time zone p_tz) as local_start
      from calls c
     where c.production_call and not c.is_test and c.started_at >= p_from and c.started_at < p_to
  ),
  handed as (
    select extract(epoch from (l.handoff_at - coalesce(c.ended_at, c.started_at))) as secs
      from leads l join calls c on c.id = l.last_call_id
     where not l.is_test and l.handoff_at >= p_from and l.handoff_at < p_to
  ),
  backlog as (
    select lane, count(*) as n, max(extract(epoch from (now() - created_at)) / 3600) as oldest_h
      from exceptions
     where not is_test and status in ('open', 'in_review') and lane in ('designer', 'admin', 'callback')
     group by lane
  ),
  due as (
    select count(*) as n from appointments a
     where not a.is_test and a.start_at >= p_from and a.start_at < least(p_to, now())
       and a.status in ('confirmed', 'completed', 'no_show')
  ),
  ev as (
    select event_type, count(distinct lead_id) as n from lead_events
     where not is_test and occurred_at >= p_from and occurred_at < p_to group by event_type
  )
  select jsonb_build_object(
    'calls', (select count(*) from fc),
    'after_hours', (select count(*) from fc where not (
        extract(dow from local_start)::int = any (p_open_dows)
        and (extract(hour from local_start) * 60 + extract(minute from local_start)) >= p_open_minute
        and (extract(hour from local_start) * 60 + extract(minute from local_start)) < p_close_minute)),
    'avg_duration_seconds', (select round(avg(duration_seconds)) from fc where answered and duration_seconds is not null),
    'over_5_min', (select count(*) from fc where duration_seconds > 300),
    'handoff_median_seconds', (select round(percentile_cont(0.5) within group (order by secs)) from handed),
    'handoffs', (select count(*) from handed),
    'backlog', coalesce((select jsonb_object_agg(lane, jsonb_build_object('count', n, 'oldest_hours', round(oldest_h::numeric, 1))) from backlog), '{}'::jsonb),
    'complaint_alert_median_seconds', (select round(percentile_cont(0.5) within group (order by extract(epoch from (notified_at - created_at)))) from exceptions
        where kind = 'complaint' and not is_test and notified_at is not null and created_at >= p_from and created_at < p_to),
    'complaints', (select count(*) from exceptions where kind = 'complaint' and not is_test and created_at >= p_from and created_at < p_to),
    'consultations_due', (select n from due),
    'consultations_completed', coalesce((select n from ev where event_type = 'consultation_completed'), 0),
    'won', coalesce((select n from ev where event_type = 'won'), 0),
    'reviews_created', (select count(*) from exceptions where not is_test and lane = 'designer' and created_at >= p_from and created_at < p_to),
    'reviews_decided', (select count(*) from exceptions where not is_test and lane = 'designer' and created_at >= p_from and created_at < p_to and status in ('resolved', 'dismissed'))
  );
$$;

create or replace function dashboard_demand(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security invoker set search_path = aangan, public as $$
  with l as (
    select * from leads where not is_test and created_at >= p_from and created_at < p_to
  )
  select jsonb_build_object(
    'localities', coalesce((select jsonb_agg(row_to_json(t)) from (
        select coalesce(nullif(initcap(locality), ''), 'Not given') as label, count(*) as n
          from l group by 1 order by n desc, label limit 8) t), '[]'::jsonb),
    'declines', coalesce((select jsonb_agg(row_to_json(t)) from (
        select decline_category as label, count(*) as n
          from l where qualification_status = 'red' and decline_category is not null
         group by 1 order by n desc) t), '[]'::jsonb),
    'project_mix', coalesce((select jsonb_agg(row_to_json(t)) from (
        select coalesce(nullif(project_segment, 'unknown'), 'unknown') as label, count(*) as n
          from l group by 1 order by n desc) t), '[]'::jsonb)
  );
$$;

grant execute on function dashboard_kpis(timestamptz, timestamptz, text, integer, integer, integer[]) to authenticated, service_role;
grant execute on function dashboard_demand(timestamptz, timestamptz) to authenticated, service_role;
