-- app_secrets had RLS enabled with intentionally zero policies (locking
-- out anon/authenticated), but that also left it with no base GRANT for
-- ANY role — including service_role, which bypasses RLS but still needs
-- an ordinary table GRANT like any other role. The send-push Edge
-- Function (running as service_role) was getting a flat "permission
-- denied for table app_secrets" as a result. Only service_role needs
-- read access here; anon/authenticated stay locked out via RLS as before.
grant select on public.app_secrets to service_role;
