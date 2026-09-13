-- Interior Projects ownership restructure: Project Manager -> Lead Executive,
-- new Executive Assistant field, employee-directory sync fix, 3D Designer
-- de-required, and safe Pruthvi Vaghela reassignment + deactivation.

-- 1. New generic role for auto-synced profiles with no manually-chosen
--    functional role yet (additive to the existing 7-value CHECK).
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role = any (array['director','head','pm','designer','execution','purchase','crm','employee']));

-- 2. New ownership fields -- same id space as the existing
--    project_manager_id/designer_id/execution_id (profiles.id).
alter table public.projects
  add column if not exists lead_executive_id uuid references public.profiles(id),
  add column if not exists executive_assistant_id uuid references public.profiles(id);

update public.projects
  set lead_executive_id = project_manager_id
  where lead_executive_id is null and project_manager_id is not null;

-- 3. Keep lead_executive_id and the legacy project_manager_id synchronised
--    regardless of which one a given write path sets, so no future code
--    path can accidentally create two different owners.
create or replace function public.trg_sync_project_owner_fields() returns trigger
  language plpgsql as $$
begin
  if new.lead_executive_id is not null and new.project_manager_id is null then
    new.project_manager_id := new.lead_executive_id;
  elsif new.project_manager_id is not null and new.lead_executive_id is null then
    new.lead_executive_id := new.project_manager_id;
  elsif new.lead_executive_id is not null and new.project_manager_id is not null and new.lead_executive_id <> new.project_manager_id then
    -- Both set to different values in the same statement -- lead_executive_id
    -- (the new authoritative field) wins, never silently creating two owners.
    new.project_manager_id := new.lead_executive_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_projects_sync_owner_fields on public.projects;
create trigger trg_projects_sync_owner_fields
  before insert or update of lead_executive_id, project_manager_id on public.projects
  for each row execute function public.trg_sync_project_owner_fields();

-- 4. Employee-directory sync: the actual root-cause fix. profiles rows were
--    only ever created lazily, the first time a person opened an Interior
--    screen (interior_ensure_profile(), InteriorProfileGate.jsx) -- and
--    that RPC raises unless a functional role was already hand-picked for
--    anyone who isn't management/dept_head. This trigger keeps a matching
--    profiles row in sync automatically from the moment a user_profiles
--    account exists, with no login and no functional-role prompt required.
create or replace function public.interior_sync_profile_from_user_profile() returns trigger
  language plpgsql security definer set search_path to 'public' as $function$
declare
  v_interior_dept uuid;
  v_role_code text;
  v_mapped_role text;
begin
  select id into v_interior_dept from public.departments where code = 'INTERIOR';
  if new.department_id is distinct from v_interior_dept then
    return new;
  end if;

  select r.code into v_role_code from public.roles r where r.id = new.role_id;
  v_mapped_role := case
    when v_role_code = 'management' then 'director'
    when v_role_code = 'dept_head' then 'head'
    else 'employee'
  end;

  insert into public.profiles (auth_id, name, role, department, active)
  values (new.id, new.full_name, v_mapped_role, 'Interior', new.is_active)
  on conflict (auth_id) do update set
    name = excluded.name,
    active = excluded.active,
    role = case
      when excluded.role in ('director', 'head') then excluded.role
      when public.profiles.role = 'employee' then excluded.role
      else public.profiles.role
    end;

  return new;
end;
$function$;

drop trigger if exists trg_user_profiles_sync_interior on public.user_profiles;
create trigger trg_user_profiles_sync_interior
  after insert or update of full_name, phone, role_id, department_id, is_active on public.user_profiles
  for each row execute function public.interior_sync_profile_from_user_profile();

-- Backfill: sync every existing Interior-department user_profiles row that
-- doesn't already have a profiles row (anyone hired before this trigger
-- existed who never happened to log into the Interior module).
do $$
declare v_interior_dept uuid; v_row record; v_role_code text; v_mapped_role text;
begin
  select id into v_interior_dept from public.departments where code = 'INTERIOR';
  for v_row in
    select up.* from public.user_profiles up
    where up.department_id = v_interior_dept
      and not exists (select 1 from public.profiles p where p.auth_id = up.id)
  loop
    select r.code into v_role_code from public.roles r where r.id = v_row.role_id;
    v_mapped_role := case
      when v_role_code = 'management' then 'director'
      when v_role_code = 'dept_head' then 'head'
      else 'employee'
    end;
    insert into public.profiles (auth_id, name, role, department, active)
    values (v_row.id, v_row.full_name, v_mapped_role, 'Interior', v_row.is_active)
    on conflict (auth_id) do nothing;
  end loop;
end $$;

-- 5. Single reusable active-employee source (listActiveInteriorEmployees()).
create or replace function public.interior_list_active_employees() returns table(
  id uuid, auth_id uuid, name text, employee_code text, role text,
  role_label_en text, role_label_gu text, department_name text, active boolean
)
language sql stable security definer set search_path to 'public' as $function$
  select distinct on (p.id)
    p.id, p.auth_id, p.name, up.employee_code, p.role,
    r.name_en, r.name_gu, p.department, p.active
  from public.profiles p
  left join public.user_profiles up on up.id = p.auth_id
  left join public.roles r on r.id = up.role_id
  where p.active = true
  order by p.id, p.name;
$function$;

-- 6. RLS: project membership now also recognises lead_executive_id /
--    executive_assistant_id (additive -- every existing access path stays).
create or replace function public.interior_is_project_member(p_project_id uuid) returns boolean
  language sql stable security definer set search_path to 'public' as $function$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id
      and public.interior_current_profile_id() in (
        p.project_manager_id, p.designer_id, p.execution_id, p.lead_executive_id, p.executive_assistant_id
      )
  ) or exists (
    select 1 from public.project_members pm
    where pm.project_id = p_project_id and pm.profile_id = public.interior_current_profile_id()
  );
$function$;

-- 7. Pruthvi Vaghela -- resolved by unique confirmed profile ID (verified
--    live: exactly one match, employee code MOW-INT-007). His staff-pilot
--    account is already inactive; his Interior profile was not -- this is
--    the exact mismatch bug this migration's sync trigger fixes going
--    forward, closed here for the one existing case that predates it.
--    Reassign his 3 currently-owned projects to the Interior Department
--    Head (Ekagree Paliwal) before deactivating, with an audit trail --
--    performed_by recorded as the Department Head, under whose authority
--    this reassignment is made.
do $$
declare
  v_pruthvi uuid := 'dab100c3-740c-472f-8382-f16d2af100ca';
  v_ekagree uuid := '53f141fe-b2b7-4178-ae1f-009ca3df5bfa';
  v_performed_by uuid := 'c410e150-3e9e-479e-b1b2-93edc5ffd02f';
  v_proj record;
begin
  for v_proj in select id, project_code from public.projects where project_manager_id = v_pruthvi loop
    insert into public.interior_pilot_audit_log (table_name, record_id, action, detail, project_id, performed_by)
    values ('projects', v_proj.id, 'reassign_owner', jsonb_build_object(
      'from_lead_executive', v_pruthvi, 'to_lead_executive', v_ekagree,
      'reason', 'Pruthvi Vaghela deactivated -- account already inactive in the staff-pilot system'
    ), v_proj.id, v_performed_by);
  end loop;

  update public.projects
    set lead_executive_id = v_ekagree, project_manager_id = v_ekagree
    where project_manager_id = v_pruthvi;

  update public.profiles set active = false where id = v_pruthvi;
end $$;

-- 8. Realtime: profiles wasn't in the publication yet -- needed so an
--    open employee dropdown updates live when the sync trigger above (or
--    a manual profile edit) writes a row, with no refresh/relogin.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'profiles') then
    execute 'alter publication supabase_realtime add table public.profiles';
  end if;
end $$;
