-- Company information on official documents, and no compulsory Management approval for normal Procurement orders.
--
-- * company_profile: one row with the company's name, address, contact, email and GSTIN, edited by Management in
--   "Company & settings" and printed on every official order form / PDF. Nothing is pre-filled: an empty field prints
--   nothing.
-- * Approval threshold: v3_01 seeded a fixed Rs 25,000 limit above which Procurement needed Management's approval. That
--   hard-coded figure is removed: by default normal orders go Department Head -> Procurement -> order placed with no
--   Management step. Management may set an optional threshold (proc_set_approval_limit); only orders above it then
--   need their approval. Emergency purchases keep their own Management approval.
-- * proc_set_approval_limit wrote its audit row with an empty entity id (staff_audit_log.entity_id is NOT NULL), so it
--   could never succeed; fixed here.

begin;

create table if not exists public.company_profile (
  id boolean primary key default true check (id),
  company_name text,
  address_line text,
  city text,
  state text,
  pin_code text,
  phone text,
  email text,
  gstin text,
  updated_by uuid references public.user_profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.company_profile (id) values (true) on conflict (id) do nothing;

alter table public.company_profile enable row level security;
revoke all on public.company_profile from anon, authenticated;
grant select on public.company_profile to authenticated;
drop policy if exists company_profile_select on public.company_profile;
create policy company_profile_select on public.company_profile for select to authenticated using (public.staff_current_user_ok());

-- Management edits the company information. Blank fields are stored as empty (printed as nothing).
create or replace function public.staff_set_company_profile(p_profile jsonb)
returns public.company_profile language plpgsql security definer set search_path to 'public' as $$
declare v_old public.company_profile; v_new public.company_profile; v_gst text; v_pin text; v_email text; v_phone text;
  v_any_dept uuid := (select id from public.departments where code = 'CONTROL_TOWER');
begin
  perform public.staff_assert_operational();
  if not coalesce(public.staff_has_global_oversight(), false) then raise exception 'Only Management can change the company information'; end if;
  v_gst := upper(nullif(btrim(coalesce(p_profile->>'gstin', '')), ''));
  v_pin := nullif(btrim(coalesce(p_profile->>'pin_code', '')), '');
  v_email := nullif(btrim(coalesce(p_profile->>'email', '')), '');
  v_phone := nullif(btrim(coalesce(p_profile->>'phone', '')), '');
  if v_gst is not null and v_gst !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$' then raise exception 'GST number is not valid (15 characters, e.g. 24ABCDE1234F1Z5)'; end if;
  if v_pin is not null and v_pin !~ '^[1-9][0-9]{5}$' then raise exception 'PIN code must be 6 digits'; end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Email is not valid'; end if;
  if v_phone is not null and length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 10 and 13 then raise exception 'Contact number must have 10 to 13 digits'; end if;
  select * into v_old from public.company_profile where id for update;
  update public.company_profile set
    company_name = nullif(btrim(coalesce(p_profile->>'company_name', '')), ''), address_line = nullif(btrim(coalesce(p_profile->>'address_line', '')), ''),
    city = nullif(btrim(coalesce(p_profile->>'city', '')), ''), state = nullif(btrim(coalesce(p_profile->>'state', '')), ''),
    pin_code = v_pin, phone = v_phone, email = v_email, gstin = v_gst, updated_by = auth.uid(), updated_at = now()
   where id returning * into v_new;
  perform public.staff_write_audit('company_profile', coalesce(v_any_dept, public.factory_procurement_dept_id()), 'UPDATE', to_jsonb(v_old), to_jsonb(v_new),
    v_any_dept, 'Company information changed');
  return v_new;
end $$;

-- Optional, Management-configured threshold (null = no Management step). Same as v3_01 except the audit row now has an id.
create or replace function public.proc_set_approval_limit(p_approver text, p_max_amount numeric)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_old numeric;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.staff_has_global_oversight(), false) then raise exception 'Only Management can change approval limits'; end if;
  if p_max_amount is not null and p_max_amount <= 0 then raise exception 'The limit must be more than zero'; end if;
  select max_amount into v_old from public.procurement_approval_limits where approver = p_approver for update;
  if not found then raise exception 'Unknown approver level %', p_approver; end if;
  update public.procurement_approval_limits set max_amount = p_max_amount, updated_by = auth.uid(), updated_at = now() where approver = p_approver;
  perform public.staff_write_audit('procurement_approval_limit', public.factory_procurement_dept_id(), 'SET_LIMIT', jsonb_build_object('approver', p_approver, 'max_amount', v_old),
    jsonb_build_object('approver', p_approver, 'max_amount', p_max_amount), public.factory_procurement_dept_id());
end $$;

-- Remove the hard-coded Rs 25,000 seeded by v3_01: no Management step for normal orders until Management sets one.
-- (Only the untouched seed value is cleared; a limit Management set themselves is kept.)
update public.procurement_approval_limits set max_amount = null, updated_at = now()
 where approver = 'PROCUREMENT_HEAD' and max_amount = 25000 and updated_by is null;

revoke all on function public.staff_set_company_profile(jsonb) from public, anon;
grant execute on function public.staff_set_company_profile(jsonb) to authenticated;

commit;
