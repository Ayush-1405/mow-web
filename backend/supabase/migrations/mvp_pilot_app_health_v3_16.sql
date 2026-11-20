-- v3_16: the app records its own problems, so the scheduled Claude "app doctor" routine can find, fix and propose them.
--   app_error_reports: one OPEN row per distinct problem (fingerprint), with a count and first/last seen; written only through
--   app_report_error() (browser crashes, failed database calls, failed uploads) and app_health_check() (hourly, server side).
--   Readable by Management only. Numbers and e-mail addresses are masked before storing. No row is ever deleted here.
begin;

create table if not exists public.app_error_reports (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null,
  source text not null check (source in ('browser', 'server')),
  kind text not null,
  page text,
  message text not null,
  detail text,
  app_version text,
  user_agent text,
  first_user_id uuid,
  department_id uuid,
  occurrences integer not null default 1,
  users_affected integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  status text not null default 'OPEN' check (status in ('OPEN', 'FIX_PROPOSED', 'FIXED', 'IGNORED')),
  status_note text,
  status_changed_at timestamptz
);
create unique index if not exists app_error_reports_open_uidx on public.app_error_reports (fingerprint) where status in ('OPEN', 'FIX_PROPOSED');
create index if not exists app_error_reports_last_seen_idx on public.app_error_reports (last_seen desc);

-- who has hit which problem (for users_affected and the per-user limit); kept small: one row per user per problem
create table if not exists public.app_error_report_users (
  report_id uuid not null references public.app_error_reports(id) on delete cascade,
  user_id uuid not null,
  first_at timestamptz not null default now(),
  primary key (report_id, user_id)
);

alter table public.app_error_reports enable row level security;
alter table public.app_error_report_users enable row level security;
drop policy if exists app_error_reports_select on public.app_error_reports;
create policy app_error_reports_select on public.app_error_reports for select to authenticated using (coalesce(public.staff_has_global_oversight(), false));
grant select on public.app_error_reports to authenticated;
revoke insert, update, delete on public.app_error_reports from authenticated, anon;
revoke all on public.app_error_report_users from authenticated, anon;

-- Masks phone numbers, ids, amounts and e-mail addresses so error text carries no personal data.
create or replace function public.app_mask(p text)
returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '<email>', 'g'),
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', 'gi'),
    '\d{4,}', '<n>', 'g');
$$;

create or replace function public.app_record_problem(p_source text, p_kind text, p_page text, p_message text, p_detail text, p_version text, p_agent text, p_user uuid)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_msg text := left(public.app_mask(btrim(p_message)), 1000); v_page text := left(public.app_mask(regexp_replace(coalesce(p_page, ''), '\?.*$', '')), 300);
  v_fp text; v_id uuid; v_new_user boolean := false;
begin
  if coalesce(v_msg, '') = '' then return null; end if;
  v_fp := md5(concat_ws('|', p_source, lower(p_kind), regexp_replace(v_page, '/<id>', '/:id', 'g'), lower(v_msg)));
  select id into v_id from public.app_error_reports where fingerprint = v_fp and status in ('OPEN', 'FIX_PROPOSED') for update;
  if v_id is null then
    insert into public.app_error_reports (fingerprint, source, kind, page, message, detail, app_version, user_agent, first_user_id, department_id)
    values (v_fp, p_source, left(p_kind, 40), v_page, v_msg, left(public.app_mask(p_detail), 4000), left(p_version, 60), left(p_agent, 300), p_user,
            (select department_id from public.user_profiles where id = p_user))
    on conflict do nothing returning id into v_id;
    if v_id is null then select id into v_id from public.app_error_reports where fingerprint = v_fp and status in ('OPEN', 'FIX_PROPOSED'); end if;
    if p_user is not null then insert into public.app_error_report_users (report_id, user_id) values (v_id, p_user) on conflict do nothing; end if;
    return v_id;
  end if;
  if p_user is not null then
    insert into public.app_error_report_users (report_id, user_id) values (v_id, p_user) on conflict do nothing;
    v_new_user := found;
  end if;
  update public.app_error_reports set occurrences = occurrences + 1, users_affected = users_affected + case when v_new_user then 1 else 0 end,
    last_seen = now(), app_version = coalesce(left(p_version, 60), app_version) where id = v_id;
  return v_id;
end $$;

-- Called by the app. Limited to 30 reports per person per hour; never raises (a broken reporter must not break the app).
create or replace function public.app_report_error(p_kind text, p_page text, p_message text, p_detail text default null, p_version text default null, p_agent text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null then return; end if;
  if lower(coalesce(p_kind, '')) not in ('crash', 'unhandled', 'rpc', 'upload', 'render') then return; end if;
  if (select count(*) from public.app_error_report_users u join public.app_error_reports r on r.id = u.report_id
       where u.user_id = auth.uid() and u.first_at > now() - interval '1 hour') >= 30 then return; end if;
  perform public.app_record_problem('browser', lower(p_kind), p_page, p_message, p_detail, p_version, p_agent, auth.uid());
exception when others then return;
end $$;

-- Hourly server-side check: failed background jobs and failed phone pushes.
create or replace function public.app_health_check()
returns integer language plpgsql security definer set search_path to 'public', 'cron' as $$
declare r record; v_n int := 0;
begin
  for r in select j.jobname, d.return_message, count(*) n from cron.job_run_details d join cron.job j on j.jobid = d.jobid
            where d.status = 'failed' and d.start_time > now() - interval '65 minutes' group by 1, 2 loop
    perform public.app_record_problem('server', 'cron', 'cron:' || r.jobname, coalesce(r.return_message, 'failed'), r.n || ' failed run(s) in the last hour', null, null, null);
    v_n := v_n + 1;
  end loop;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'notifications' and column_name = 'delivery_status') then
    for r in execute $q$ select delivery_status, count(*) n from public.notifications where created_at > now() - interval '65 minutes'
                         and delivery_status ilike '%fail%' group by 1 $q$ loop
      if r.n >= 5 then
        perform public.app_record_problem('server', 'push', 'notifications', 'Phone push delivery failing: ' || r.delivery_status, r.n || ' in the last hour', null, null, null);
        v_n := v_n + 1;
      end if;
    end loop;
  end if;
  return v_n;
end $$;

-- Management (and the fix workflow) mark a problem as fix proposed / fixed / ignored, with a note.
create or replace function public.app_set_problem_status(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not coalesce(public.staff_has_global_oversight(), false) then raise exception 'Only Management can change a problem''s status'; end if;
  if p_status not in ('OPEN', 'FIX_PROPOSED', 'FIXED', 'IGNORED') then raise exception 'Unknown status'; end if;
  update public.app_error_reports set status = p_status, status_note = nullif(btrim(coalesce(p_note, '')), ''), status_changed_at = now() where id = p_id;
  if not found then raise exception 'Problem not found'; end if;
end $$;

revoke all on function public.app_record_problem(text, text, text, text, text, text, text, uuid), public.app_health_check(), public.app_mask(text) from public, anon, authenticated;
revoke all on function public.app_report_error(text, text, text, text, text, text), public.app_set_problem_status(uuid, text, text) from public, anon;
grant execute on function public.app_report_error(text, text, text, text, text, text), public.app_set_problem_status(uuid, text, text) to authenticated;

do $do$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'app-health-check';
    perform cron.schedule('app-health-check', '5 * * * *', 'select public.app_health_check();');
  end if;
end $do$;

commit;
