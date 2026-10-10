-- Optional "include test calls" view: every dashboard aggregate takes p_include_test (default false).
-- Test calls from the in-app console stay excluded unless a viewer explicitly turns this on.
set search_path = aangan, public, extensions;

drop function if exists dashboard_funnel(timestamptz, timestamptz, uuid, text, qualification_status);
drop function if exists dashboard_costs(timestamptz, timestamptz);
drop function if exists dashboard_kpis(timestamptz, timestamptz, text, integer, integer, integer[]);
drop function if exists dashboard_demand(timestamptz, timestamptz);

create or replace function dashboard_funnel(
  p_from timestamptz,
  p_to timestamptz,
  p_designer uuid default null,
  p_project_type text default null,
  p_status qualification_status default null,
  p_include_test boolean default false
) returns jsonb language sql stable security invoker set search_path = aangan, public as $$
  with lead_filter as (
    select l.id from leads l
     where (p_include_test or not l.is_test)
       and (p_designer is null or l.assigned_designer_id = p_designer)
       and (p_project_type is null or l.project_type = p_project_type)
       and (p_status is null or l.qualification_status = p_status)
  ),
  fc as (
    select c.* from calls c
     where ((c.production_call and not c.is_test) or (p_include_test and c.is_test))
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
     where (p_include_test or not e.is_test) and e.occurred_at >= p_from and e.occurred_at < p_to
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

create or replace function dashboard_costs(p_from timestamptz, p_to timestamptz, p_include_test boolean default false)
returns jsonb language sql stable security invoker set search_path = aangan, public as $$
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
    select provider, usage_type, currency, is_estimate,
           sum(cost_amount) as cost_amount, sum(units) as units, count(*) as events
      from cost_events
     where (p_include_test or not is_test) and usage_at >= p_from and usage_at < p_to
     group by provider, usage_type, currency, is_estimate
     order by provider, usage_type
  ) t;
$$;

create or replace function dashboard_kpis(
  p_from timestamptz,
  p_to timestamptz,
  p_tz text default 'Asia/Kolkata',
  p_open_minute integer default 600,     -- 10:00
  p_close_minute integer default 1140,   -- 19:00
  p_open_dows integer[] default array[1, 2, 3, 4, 5, 6],  -- Mon–Sat (0 = Sunday)
  p_include_test boolean default false
) returns jsonb language sql stable security invoker set search_path = aangan, public as $$
  with fc as (
    select c.*, (c.started_at at time zone p_tz) as local_start
      from calls c
     where ((c.production_call and not c.is_test) or (p_include_test and c.is_test)) and c.started_at >= p_from and c.started_at < p_to
  ),
  handed as (
    select extract(epoch from (l.handoff_at - coalesce(c.ended_at, c.started_at))) as secs
      from leads l join calls c on c.id = l.last_call_id
     where (p_include_test or not l.is_test) and l.handoff_at >= p_from and l.handoff_at < p_to
  ),
  backlog as (
    select lane, count(*) as n, max(extract(epoch from (now() - created_at)) / 3600) as oldest_h
      from exceptions
     where (p_include_test or not is_test) and status in ('open', 'in_review') and lane in ('designer', 'admin', 'callback')
     group by lane
  ),
  due as (
    select count(*) as n from appointments a
     where (p_include_test or not a.is_test) and a.start_at >= p_from and a.start_at < least(p_to, now())
       and a.status in ('confirmed', 'completed', 'no_show')
  ),
  ev as (
    select event_type, count(distinct lead_id) as n from lead_events
     where (p_include_test or not is_test) and occurred_at >= p_from and occurred_at < p_to group by event_type
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
        where kind = 'complaint' and (p_include_test or not is_test) and notified_at is not null and created_at >= p_from and created_at < p_to),
    'complaints', (select count(*) from exceptions where kind = 'complaint' and (p_include_test or not is_test) and created_at >= p_from and created_at < p_to),
    'consultations_due', (select n from due),
    'consultations_completed', coalesce((select n from ev where event_type = 'consultation_completed'), 0),
    'won', coalesce((select n from ev where event_type = 'won'), 0),
    'reviews_created', (select count(*) from exceptions where (p_include_test or not is_test) and lane = 'designer' and created_at >= p_from and created_at < p_to),
    'reviews_decided', (select count(*) from exceptions where (p_include_test or not is_test) and lane = 'designer' and created_at >= p_from and created_at < p_to and status in ('resolved', 'dismissed'))
  );
$$;

create or replace function dashboard_demand(p_from timestamptz, p_to timestamptz, p_include_test boolean default false)
returns jsonb language sql stable security invoker set search_path = aangan, public as $$
  with l as (
    select * from leads where (p_include_test or not is_test) and created_at >= p_from and created_at < p_to
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

grant execute on function dashboard_funnel(timestamptz, timestamptz, uuid, text, qualification_status, boolean) to authenticated, service_role;
grant execute on function dashboard_costs(timestamptz, timestamptz, boolean) to authenticated, service_role;
grant execute on function dashboard_kpis(timestamptz, timestamptz, text, integer, integer, integer[], boolean) to authenticated, service_role;
grant execute on function dashboard_demand(timestamptz, timestamptz, boolean) to authenticated, service_role;
