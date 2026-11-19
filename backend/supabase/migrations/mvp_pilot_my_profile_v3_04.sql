-- My Profile: every user adds their own mobile number (also their login id, see v3_03) and keeps personal details up to
-- date; Management and Department Heads open anyone's profile in their scope to see official details, personal details
-- and a work summary in one place.
--
-- Personal details are private to the person, their Department Head(s) and Management. Nobody writes the tables directly:
-- the person saves their own through staff_save_my_profile(); official fields (name, code, role, department) stay with
-- User Management.

begin;

create table if not exists public.staff_personal_details (
  user_id uuid primary key references public.user_profiles(id) on delete cascade,
  alternate_phone text check (alternate_phone is null or length(regexp_replace(alternate_phone, '[^0-9]', '', 'g')) between 10 and 13),
  personal_email text check (personal_email is null or personal_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  date_of_birth date check (date_of_birth is null or date_of_birth between date '1940-01-01' and current_date),
  address text,
  city text,
  blood_group text check (blood_group is null or blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  emergency_contact_name text,
  emergency_contact_phone text check (emergency_contact_phone is null or length(regexp_replace(emergency_contact_phone, '[^0-9]', '', 'g')) between 10 and 13),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.user_profiles(id)
);

alter table public.staff_personal_details enable row level security;
revoke all on public.staff_personal_details from anon, authenticated;
grant select on public.staff_personal_details to authenticated;

-- The person themselves, a Department Head over their department, or Management.
create or replace function public.staff_can_view_person(p_user_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.staff_current_user_ok() and (
      p_user_id = auth.uid()
      or public.staff_has_global_oversight()
      or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope((select department_id from public.user_profiles where id = p_user_id)))
  ), false);
$$;

drop policy if exists staff_personal_details_select on public.staff_personal_details;
create policy staff_personal_details_select on public.staff_personal_details for select to authenticated
  using (public.staff_can_view_person(user_id));

-- The first-open gate: a user with no mobile number adds it here. Checked for shape and for belonging to someone else.
create or replace function public.staff_set_my_phone(p_phone text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_phone text := nullif(btrim(coalesce(p_phone, '')), ''); v_owner text; v_old text;
begin
  perform public.staff_assert_operational();
  if v_phone is null or length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 10 and 13 then
    raise exception 'Enter a mobile number with 10 to 13 digits';
  end if;
  select full_name into v_owner from public.user_profiles
   where id <> auth.uid() and not is_deleted and public.staff_phone_key(phone) = public.staff_phone_key(v_phone);
  if v_owner is not null then raise exception 'This mobile number is already used by another user'; end if;
  select phone into v_old from public.user_profiles where id = auth.uid();
  update public.user_profiles set phone = v_phone, updated_at = now() where id = auth.uid();
  perform public.staff_write_audit('user_profile', auth.uid(), 'SET_OWN_PHONE', jsonb_build_object('phone', v_old), jsonb_build_object('phone', v_phone),
    (select department_id from public.user_profiles where id = auth.uid()), null);
end $$;

-- Everything on the profile page in one call: official details, personal details and a work summary.
create or replace function public.staff_get_profile(p_user_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'auth' as $$
declare v_id uuid := coalesce(p_user_id, auth.uid()); v_out jsonb;
begin
  if not public.staff_can_view_person(v_id) then raise exception 'You cannot view this profile'; end if;
  select jsonb_build_object(
    'id', up.id, 'employee_code', up.employee_code, 'full_name', up.full_name, 'phone', up.phone,
    'role', r.name_en, 'role_code', r.code, 'department', d.name_en, 'department_code', d.code,
    'location', l.name_en, 'joining_date', up.joining_date, 'reports_to', boss.full_name, 'language_pref', up.language_pref,
    'is_active', up.is_active, 'created_at', up.created_at, 'last_sign_in_at', au.last_sign_in_at,
    'is_self', up.id = auth.uid(),
    'personal', coalesce((select to_jsonb(pd) - 'user_id' from public.staff_personal_details pd where pd.user_id = up.id), '{}'::jsonb),
    'stats', jsonb_build_object(
      'tasks_open', (select count(*) from public.staff_tasks t left join public.status_master s on s.id = t.status_id
                      where t.is_active and t.assigned_to = up.id and coalesce(s.code, '') not in ('COMPLETED', 'VERIFIED', 'CLOSED')),
      'tasks_done_30d', (select count(*) from public.staff_tasks t join public.status_master s on s.id = t.status_id
                      where t.is_active and t.assigned_to = up.id and s.code in ('COMPLETED', 'VERIFIED', 'CLOSED')
                        and coalesce(t.completed_at, t.updated_at) >= now() - interval '30 days'),
      'tasks_overdue', (select count(*) from public.staff_tasks t left join public.status_master s on s.id = t.status_id
                      where t.is_active and t.assigned_to = up.id and coalesce(s.code, '') not in ('COMPLETED', 'VERIFIED', 'CLOSED')
                        and t.due_date < (now() at time zone 'Asia/Kolkata')::date),
      'purchase_requests', (select count(*) from public.purchase_requests pr where pr.requester_user_id = up.id),
      'logins_30d', (select count(*) from public.login_attempts la where la.success and la.attempted_at >= now() - interval '30 days'
                      and (la.employee_code = up.employee_code or la.employee_code = 'PHONE:' || public.staff_phone_key(up.phone)))
    ))
  into v_out
  from public.user_profiles up
  join public.roles r on r.id = up.role_id
  left join public.departments d on d.id = up.department_id
  left join public.locations l on l.id = up.home_location_id
  left join public.user_profiles boss on boss.id = up.reports_to
  left join auth.users au on au.id = up.id
  where up.id = v_id;
  if v_out is null then raise exception 'User not found'; end if;
  return v_out;
end $$;

-- The person saves their own mobile number and personal details. Empty values clear a field.
create or replace function public.staff_save_my_profile(p_phone text, p_details jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_old jsonb; v text;
begin
  perform public.staff_assert_operational();
  if (select coalesce(phone, '') from public.user_profiles where id = auth.uid()) is distinct from coalesce(nullif(btrim(coalesce(p_phone, '')), ''), '') then
    perform public.staff_set_my_phone(p_phone);
  end if;
  select to_jsonb(pd) into v_old from public.staff_personal_details pd where pd.user_id = auth.uid();
  insert into public.staff_personal_details as pd (user_id, alternate_phone, personal_email, date_of_birth, address, city, blood_group,
    emergency_contact_name, emergency_contact_phone, updated_at, updated_by)
  values (auth.uid(),
    nullif(btrim(coalesce(p_details->>'alternate_phone', '')), ''), nullif(lower(btrim(coalesce(p_details->>'personal_email', ''))), ''),
    nullif(btrim(coalesce(p_details->>'date_of_birth', '')), '')::date, nullif(btrim(coalesce(p_details->>'address', '')), ''),
    nullif(btrim(coalesce(p_details->>'city', '')), ''), nullif(btrim(coalesce(p_details->>'blood_group', '')), ''),
    nullif(btrim(coalesce(p_details->>'emergency_contact_name', '')), ''), nullif(btrim(coalesce(p_details->>'emergency_contact_phone', '')), ''),
    now(), auth.uid())
  on conflict (user_id) do update set alternate_phone = excluded.alternate_phone, personal_email = excluded.personal_email,
    date_of_birth = excluded.date_of_birth, address = excluded.address, city = excluded.city, blood_group = excluded.blood_group,
    emergency_contact_name = excluded.emergency_contact_name, emergency_contact_phone = excluded.emergency_contact_phone,
    updated_at = now(), updated_by = auth.uid();
  perform public.staff_write_audit('user_profile', auth.uid(), 'UPDATE_OWN_DETAILS', v_old,
    (select to_jsonb(pd) from public.staff_personal_details pd where pd.user_id = auth.uid()),
    (select department_id from public.user_profiles where id = auth.uid()), null);
exception
  when check_violation then raise exception 'Please check the phone numbers (10 to 13 digits), email, date of birth and blood group';
  when invalid_datetime_format or datetime_field_overflow then raise exception 'Date of birth is not a valid date';
end $$;

revoke all on function public.staff_can_view_person(uuid), public.staff_set_my_phone(text), public.staff_get_profile(uuid),
  public.staff_save_my_profile(text, jsonb) from public, anon;
grant execute on function public.staff_can_view_person(uuid), public.staff_set_my_phone(text), public.staff_get_profile(uuid),
  public.staff_save_my_profile(text, jsonb) to authenticated;

commit;
