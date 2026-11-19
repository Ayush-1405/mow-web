-- Sign in with the employee code OR the mobile number. Both are unique per person: employee codes already were
-- (user_profiles_employee_code_*); mobile numbers become unique here, compared on their last 10 digits so
-- "+91 98765 43210", "098765 43210" and "9876543210" are the same number. Deleted users don't hold on to a number.

begin;

-- The comparable form of a phone number: its last 10 digits, or null if it has fewer than 10.
create or replace function public.staff_phone_key(p text)
returns text language sql immutable set search_path to 'public' as $$
  select case when length(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g')) >= 10
              then right(regexp_replace(p, '[^0-9]', '', 'g'), 10) end;
$$;

alter table public.user_profiles drop constraint if exists user_profiles_phone_format_check;
alter table public.user_profiles add constraint user_profiles_phone_format_check
  check (phone is null or length(regexp_replace(phone, '[^0-9]', '', 'g')) between 10 and 13);

create unique index if not exists user_profiles_phone_key_idx on public.user_profiles (public.staff_phone_key(phone))
  where phone is not null and not is_deleted;

-- Used only by the staff-login Edge Function (service role). Letters mean an employee code; otherwise 10+ digits mean a
-- phone number. An exact employee-code match always wins, so an all-digit employee code still works.
create or replace function public.resolve_employee_login(p_employee_code text)
returns table(auth_user_id uuid, auth_email text, is_active boolean, must_change_password boolean)
language sql security definer set search_path to 'public', 'auth' as $$
  select up.id, au.email, up.is_active, up.must_change_password
    from public.user_profiles up join auth.users au on au.id = up.id
   where up.employee_code = upper(btrim(p_employee_code))
      or (btrim(p_employee_code) !~ '[A-Za-z]' and public.staff_phone_key(p_employee_code) is not null
          and not up.is_deleted and public.staff_phone_key(up.phone) = public.staff_phone_key(p_employee_code))
   order by (up.employee_code = upper(btrim(p_employee_code))) desc
   limit 1;
$$;
revoke all on function public.resolve_employee_login(text) from public, anon, authenticated;
grant execute on function public.resolve_employee_login(text) to service_role;

-- Profile edits: the number is checked for shape and for belonging to someone else before saving, with a readable message.
create or replace function public.staff_update_user_profile(p_user_id uuid, p_full_name text, p_phone text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_caller_role text := public.staff_current_role_code();
  v_target public.user_profiles%rowtype;
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_owner text;
begin
  perform public.staff_assert_operational();
  if p_full_name is null or btrim(p_full_name) = '' then
    raise exception 'Full name is required';
  end if;

  select * into v_target from public.user_profiles where id = p_user_id;
  if v_target.id is null then raise exception 'User not found'; end if;

  if not coalesce(v_caller_role = 'management'
      or (v_caller_role = 'dept_head' and public.staff_dept_in_hod_scope(v_target.department_id)), false) then
    raise exception 'You are not authorized to edit this user';
  end if;

  if v_phone is not null then
    if length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 10 and 13 then
      raise exception 'Phone number must have 10 to 13 digits';
    end if;
    select full_name into v_owner from public.user_profiles
     where id <> p_user_id and not is_deleted and public.staff_phone_key(phone) = public.staff_phone_key(v_phone);
    if v_owner is not null then raise exception 'This phone number is already used by %', v_owner; end if;
  end if;

  update public.user_profiles set full_name = btrim(p_full_name), phone = v_phone where id = p_user_id;

  perform public.staff_write_audit('user_profile', p_user_id, 'UPDATE_PROFILE',
    jsonb_build_object('full_name', v_target.full_name, 'phone', v_target.phone),
    jsonb_build_object('full_name', p_full_name, 'phone', v_phone),
    v_target.department_id);
end $$;

-- staff-create-user asks this (as service role) before creating the Auth user, so a taken number is refused up front.
create or replace function public.staff_phone_in_use(p_phone text)
returns text language sql stable security definer set search_path to 'public' as $$
  select full_name from public.user_profiles
   where not is_deleted and public.staff_phone_key(phone) = public.staff_phone_key(p_phone) limit 1;
$$;
revoke all on function public.staff_phone_in_use(text) from public, anon, authenticated;
grant execute on function public.staff_phone_in_use(text) to service_role;

commit;
