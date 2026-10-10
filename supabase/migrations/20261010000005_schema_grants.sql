-- API access for the dedicated schema. Supabase only applies its default grants to `public`, so the
-- `aangan` schema grants them explicitly. RLS (migration 2) still decides which rows each role sees.
set search_path = aangan, public, extensions;

grant usage on schema aangan to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema aangan to authenticated, service_role;
grant select on all tables in schema aangan to anon;
grant usage, select on all sequences in schema aangan to authenticated, service_role;
grant execute on all functions in schema aangan to authenticated, service_role;

alter default privileges in schema aangan grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema aangan grant execute on functions to authenticated, service_role;

-- Queue and rate-limiter functions are server-only.
revoke execute on function aangan.claim_jobs(integer, text[]) from public, anon, authenticated;
revoke execute on function aangan.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
revoke execute on function aangan.handle_new_auth_user() from public, anon, authenticated;
