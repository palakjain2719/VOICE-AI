-- Every Supabase Auth user gets an app_users row with NO roles: they can sign in but see nothing
-- until an admin grants founder / operator / admin. Bootstrap the first admin with:
--   update app_users set roles = '{admin}' where email = 'you@example.com';

set search_path = aangan, public, extensions;
create or replace function aangan.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = aangan, public as $$
begin
  insert into app_users (id, email) values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger aangan_on_auth_user_created
  after insert on auth.users
  for each row execute function aangan.handle_new_auth_user();
