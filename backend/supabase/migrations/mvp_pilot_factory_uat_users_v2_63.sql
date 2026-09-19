-- mvp_pilot_factory_uat_users_v2_63
--
-- 10 clearly-labelled UAT test accounts (checked against existing
-- employees first -- zero user_profiles rows exist for the FACTORY
-- department today, confirmed live; these are net-new, not duplicates of
-- any real employee). Structure mirrors an existing real auth.users/
-- auth.identities row exactly (columns/shape inspected read-only first,
-- no real password hash ever read or reused). One shared temporary
-- password, must_change_password=true so every account is forced to set
-- its own password on first login. No invitation email is sent by this
-- migration (plain SQL insert, not the staff-create-user Edge Function --
-- nothing here calls any email/SMS provider).
--
-- Inserting user_profiles fires the existing trg_user_profiles_sync_interior
-- trigger, which creates a matching `profiles` row automatically -- this is
-- what makes these accounts show up correctly in listInteriorPeople()'s
-- department_name-scoped dropdowns (FactoryJobOrders.jsx etc.), exactly
-- the same path every real employee already goes through.

do $$
declare
  v_password text := 'Uat@Factory2026!';
  v_factory_dept uuid := '797b412e-d43e-43ea-970c-bc79f350e5f5';
  v_interior_dept uuid := 'cbfa0069-1fe4-4377-9b7b-b240134b007f';
  v_godown_dept uuid := '028d415a-dac0-4c47-9108-cf64db06f4e7';
  v_dispatch_dept uuid := 'e2d87621-7d15-456a-8601-4a9d3701c869';
  v_role_dept_head uuid := 'ec3f3376-28ec-4890-9245-c8401aa257d9';
  v_role_supervisor uuid := '0759c8ee-20e3-464b-88b5-e232bc1e75d7';
  v_role_employee uuid := '90054991-2ead-4bcf-a3ee-394f15038a15';
  v_role_management uuid := '414e1827-c313-4247-ada4-97b059707cf6';
  v_users jsonb := '[
    {"email":"uat.factory.head@mowinternal.test","name":"UAT Factory Head","code":"UAT-FAC-001","dept":"factory","role":"dept_head"},
    {"email":"uat.production.planner@mowinternal.test","name":"UAT Production Planner","code":"UAT-FAC-002","dept":"factory","role":"supervisor"},
    {"email":"uat.factory.supervisor@mowinternal.test","name":"UAT Factory Supervisor","code":"UAT-FAC-003","dept":"factory","role":"supervisor"},
    {"email":"uat.factory.worker1@mowinternal.test","name":"UAT Factory Worker 1","code":"UAT-FAC-004","dept":"factory","role":"employee"},
    {"email":"uat.factory.worker2@mowinternal.test","name":"UAT Factory Worker 2","code":"UAT-FAC-005","dept":"factory","role":"employee"},
    {"email":"uat.qc.employee@mowinternal.test","name":"UAT QC Employee","code":"UAT-FAC-006","dept":"factory","role":"employee"},
    {"email":"uat.inventory.employee@mowinternal.test","name":"UAT Inventory Employee","code":"UAT-GDN-001","dept":"godown","role":"employee"},
    {"email":"uat.dispatch.employee@mowinternal.test","name":"UAT Dispatch Employee","code":"UAT-DSP-001","dept":"dispatch","role":"employee"},
    {"email":"uat.interior.user@mowinternal.test","name":"UAT Interior User","code":"UAT-INT-001","dept":"interior","role":"employee"},
    {"email":"uat.management.user@mowinternal.test","name":"UAT Management User","code":"UAT-MGT-001","dept":null,"role":"management"}
  ]'::jsonb;
  v_row jsonb;
  v_new_id uuid;
  v_dept_id uuid;
  v_role_id uuid;
begin
  for v_row in select * from jsonb_array_elements(v_users) loop
    -- Idempotent: skip if this exact UAT email already exists (safe to
    -- re-run this migration without creating duplicates).
    if exists (select 1 from auth.users where email = v_row->>'email') then
      continue;
    end if;

    v_new_id := gen_random_uuid();
    v_dept_id := case v_row->>'dept'
      when 'factory' then v_factory_dept
      when 'interior' then v_interior_dept
      when 'godown' then v_godown_dept
      when 'dispatch' then v_dispatch_dept
      else null
    end;
    v_role_id := case v_row->>'role'
      when 'dept_head' then v_role_dept_head
      when 'supervisor' then v_role_supervisor
      when 'management' then v_role_management
      else v_role_employee
    end;

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous, created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000', v_new_id, 'authenticated', 'authenticated',
      v_row->>'email', crypt(v_password, gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{"email_verified":true}'::jsonb,
      false, false, now(), now()
    );

    insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at)
    values (
      gen_random_uuid(), v_new_id, v_new_id::text, 'email',
      jsonb_build_object('sub', v_new_id::text, 'email', v_row->>'email', 'email_verified', true, 'phone_verified', false),
      now(), now()
    );

    insert into public.user_profiles (
      id, employee_code, full_name, role_id, department_id, language_pref,
      must_change_password, is_active, joining_date
    ) values (
      v_new_id, v_row->>'code', v_row->>'name', v_role_id, v_dept_id, 'en',
      true, true, current_date
    );
  end loop;
end $$;
