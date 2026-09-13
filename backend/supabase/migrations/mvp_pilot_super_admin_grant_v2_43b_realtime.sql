-- user_profiles wasn't in the realtime publication -- needed so an already
-- logged-in user's role/department/active-status change (like this
-- migration's own Super Admin grant) is picked up by the current session
-- without a forced logout/login, per the explicit "refresh in-session"
-- requirement. Session/App.jsx subscribes to the caller's own row.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'user_profiles') then
    execute 'alter publication supabase_realtime add table public.user_profiles';
  end if;
end $$;
