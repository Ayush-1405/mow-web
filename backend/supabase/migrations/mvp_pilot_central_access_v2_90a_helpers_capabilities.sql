-- v2_90a -- ONE central definition of "who has organization-wide (Director / Management) visibility" plus an explicit capability layer.
--
-- Before this migration the rule `staff_is_management() OR staff_is_super_admin()` was repeated in ~47 RLS policies / functions and
-- ~40 places in the UI, each comparing a raw role-code string. This migration keeps every existing policy working but makes the
-- definition live in ONE place (staff_role_family) and adds capabilities (role_permissions) so sensitive / destructive powers are
-- separately grantable instead of being implied by "is management".
--
-- Nothing here widens access for an existing user: management and sysadmin keep exactly what they had; the capability seeds mirror the
-- pre-existing behaviour (management/sysadmin hold restricted-finance today -- v2_43 -- so they are seeded TRUE and are now revocable).
-- Payroll / sensitive-HR have no module in this database, so they are seeded FALSE for every role (explicitly restricted).

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Role normalisation. Handles case, spaces, slashes, hyphens ("Management / Director", "Managing-Director", "Super Admin" ...).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.staff_norm_role(p text)
returns text language sql immutable parallel safe set search_path = public as $$
  select nullif(btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '_', 'g'), '_'), '');
$$;

-- 'management' | 'super_admin' | null.  Any future / legacy alias only needs to be added HERE.
create or replace function public.staff_role_family(p_code text)
returns text language sql immutable parallel safe set search_path = public as $$
  select case public.staff_norm_role(p_code)
    when 'management' then 'management'
    when 'director' then 'management'
    when 'management_director' then 'management'
    when 'managing_director' then 'management'
    when 'ceo' then 'management'
    when 'central_tower' then 'management'
    when 'management_control_tower' then 'management'
    when 'control_tower' then 'management'
    when 'sysadmin' then 'super_admin'
    when 'super_admin' then 'super_admin'
    when 'system_administrator' then 'super_admin'
    else null
  end;
$$;

-- Same semantics as before (active user's role), now through the single family map. staff_current_role_code() is unchanged:
-- an inactive / deleted user has no role code, so a disabled Director loses access on the very next request (JWT is not trusted).
create or replace function public.staff_is_management()
returns boolean language sql stable security definer set search_path = public as $$
  select public.staff_role_family(public.staff_current_role_code()) = 'management';
$$;

create or replace function public.staff_is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.staff_role_family(public.staff_current_role_code()) = 'super_admin';
$$;

-- Director / Management / Super Admin: organization-wide OPERATIONAL visibility. (Not a grant of finance, payroll or HR -- see below.)
create or replace function public.staff_has_global_oversight()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.staff_role_family(public.staff_current_role_code()) is not null, false);
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. Capabilities (role_permissions was created earlier but never used; RLS on, no policies => only these definer functions read it).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.staff_has_capability(p_cap text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select rp.is_allowed
      from public.user_profiles up
      join public.role_permissions rp on rp.role_id = up.role_id
     where up.id = auth.uid() and up.is_active and rp.permission_key = p_cap and rp.is_active
     limit 1
  ), false);
$$;

-- What the browser may show. Computed here from the database role, never from anything the client supplies.
create or replace function public.staff_my_capabilities()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_code text; v_caps jsonb;
begin
  if not public.staff_current_user_ok() then
    return jsonb_build_object('role_code', null, 'family', null, 'global_oversight', false, 'capabilities', '{}'::jsonb);
  end if;
  v_code := public.staff_current_role_code();
  select coalesce(jsonb_object_agg(rp.permission_key, rp.is_allowed), '{}'::jsonb) into v_caps
    from public.user_profiles up join public.role_permissions rp on rp.role_id = up.role_id
   where up.id = auth.uid() and rp.is_active;
  return jsonb_build_object('role_code', v_code, 'family', public.staff_role_family(v_code),
                            'global_oversight', public.staff_role_family(v_code) is not null, 'capabilities', v_caps);
end $$;

-- Seed. permission_key list: view_* / oversight, sensitive (finance, payroll, HR, users), and actions.
insert into public.role_permissions (role_id, permission_key, is_allowed, scope, is_active)
select x.role_id, x.key, x.allowed, case when x.allowed then 'all' else 'none' end, true
from (
select r.id as role_id, k.key,
  (case
    -- global operational visibility + oversight chat
    when k.key in ('can_view_all_operational_data', 'can_view_all_departments', 'can_view_all_tasks', 'can_view_all_bridges',
                   'can_view_all_projects', 'can_view_all_job_cards', 'can_view_all_reports', 'can_view_audit_log', 'can_view_all_operational_chats')
      then r.code in ('management', 'sysadmin')
    -- restricted finance: exactly who holds it today (management + sysadmin by v2_43, and the Accounts roles)
    when k.key = 'can_view_restricted_finance' then r.code in ('management', 'sysadmin', 'accounts_head', 'accounts_employee', 'cfo')
    -- no payroll / sensitive HR module exists: nobody holds these until one is built and granted explicitly
    when k.key in ('can_view_payroll', 'can_view_sensitive_hr') then false
    when k.key = 'can_manage_users' then r.code in ('management', 'sysadmin')
    when k.key = 'can_delete_records' then r.code in ('management', 'sysadmin')
    when k.key = 'can_restore_records' then r.code = 'sysadmin'            -- staff_restore_user is Super-Admin-only
    when k.key = 'can_export_data' then r.code in ('management', 'sysadmin', 'dept_head')
    when k.key in ('can_assign', 'can_approve', 'can_change_status', 'can_edit_records') then r.code in ('management', 'sysadmin', 'dept_head')
    when k.key = 'can_comment' then true
    else false
  end) as allowed
from public.roles r
cross join (values
  ('can_view_all_operational_data'), ('can_view_all_departments'), ('can_view_all_tasks'), ('can_view_all_bridges'),
  ('can_view_all_projects'), ('can_view_all_job_cards'), ('can_view_all_reports'), ('can_view_audit_log'), ('can_view_all_operational_chats'),
  ('can_view_restricted_finance'), ('can_view_payroll'), ('can_view_sensitive_hr'), ('can_manage_users'),
  ('can_comment'), ('can_assign'), ('can_approve'), ('can_change_status'), ('can_edit_records'),
  ('can_delete_records'), ('can_restore_records'), ('can_export_data')
) as k(key)
) x
on conflict (role_id, permission_key) do nothing;   -- never overwrite a value an administrator already changed

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. Requested helper names. They take a user id but only ever answer for the CALLER (auth.uid()): a browser can never use them to
--    probe another person's permissions. (Internal SQL that needs another user's scope keeps using the existing *_user_* helpers.)
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.is_management_user(p_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select p_user is not distinct from auth.uid() and public.staff_current_user_ok() and public.staff_has_global_oversight();
$$;

create or replace function public.can_view_department(p_user uuid, p_department uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user is not distinct from auth.uid() and public.staff_current_user_ok() and exists (
    select 1 from public.departments d
     where d.id = p_department and d.is_active
       and case
             when public.staff_has_global_oversight() then (not d.is_confidential_domain or public.staff_has_capability('can_view_restricted_finance'))
             when d.is_control_tower then false
             when d.is_confidential_domain then public.staff_has_capability('can_view_restricted_finance') and d.id = public.staff_current_department_id()
             else public.staff_dept_in_hod_scope(d.id) and (public.staff_is_dept_head() or d.id = public.staff_current_department_id())
           end);
$$;

create or replace function public.can_view_task(p_user uuid, p_task uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user is not distinct from auth.uid() and public.staff_task_visible(p_task);
$$;

create or replace function public.can_view_bridge(p_user uuid, p_bridge uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user is not distinct from auth.uid() and exists (
    select 1 from public.bridges b where b.id = p_bridge
       and public.staff_current_user_ok()
       and (b.from_person_id = auth.uid() or b.to_person_id = auth.uid() or public.staff_task_visible(b.task_id)));
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. Audit rows now say WHICH role acted (the role at the moment of the action, not whatever the user is later changed to).
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.staff_audit_log add column if not exists performed_by_role text;

create or replace function public.staff_write_audit(p_entity_type text, p_entity_id uuid, p_action text, p_old_value jsonb, p_new_value jsonb,
                                                    p_department_id uuid default null, p_remarks text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.staff_audit_log (entity_type, entity_id, action, old_value, new_value, department_id, remarks, performed_by, performed_by_role)
  values (p_entity_type, p_entity_id, p_action, p_old_value, p_new_value, p_department_id, p_remarks, auth.uid(), public.staff_current_role_code());
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. Grants: definer helpers are callable by signed-in users (policies call them); nothing is callable anonymously.
-- ---------------------------------------------------------------------------------------------------------------------------------
revoke execute on function public.staff_has_global_oversight(), public.staff_has_capability(text), public.staff_my_capabilities(),
  public.is_management_user(uuid), public.can_view_department(uuid, uuid), public.can_view_task(uuid, uuid), public.can_view_bridge(uuid, uuid)
  from public, anon;
grant execute on function public.staff_has_global_oversight(), public.staff_has_capability(text), public.staff_my_capabilities(),
  public.is_management_user(uuid), public.can_view_department(uuid, uuid), public.can_view_task(uuid, uuid), public.can_view_bridge(uuid, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. Lookup indexes used by the helpers / policies above.
-- ---------------------------------------------------------------------------------------------------------------------------------
create index if not exists chat_access_log_session_idx on public.chat_access_log (conversation_id, user_id, action, created_at desc);
create index if not exists chat_access_log_user_idx on public.chat_access_log (user_id, created_at desc);
create index if not exists user_profiles_active_role_idx on public.user_profiles (role_id) where is_active;
create index if not exists staff_audit_log_actor_idx on public.staff_audit_log (performed_by, performed_at desc);
create index if not exists staff_audit_log_entity_idx on public.staff_audit_log (entity_type, entity_id, performed_at desc);
