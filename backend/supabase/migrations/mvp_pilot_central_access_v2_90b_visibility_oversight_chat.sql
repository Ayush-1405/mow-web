-- v2_90b -- uses the v2_90a helpers.
--   1. staff_can_view_task / staff_record_attachment: confidential (Accounts/Finance) records are gated by the restricted-finance CAPABILITY,
--      not by a hard-coded list of role codes. Management / Super Admin / Accounts roles keep exactly the access they had (seeded TRUE).
--   2. Destructive / user-management RPCs additionally require their capability (delete records, manage users).
--   3. Interior audit_log: Director/Management no longer need a lazily-created Interior profile to read it.
--   4. Chat oversight: Management can VIEW organization work conversations WITHOUT becoming a participant. The read is only possible
--      inside a logged "oversight session" (chat_oversight_open), so the audit trail cannot be bypassed by querying the table directly.
--      Being a participant (unread, notifications, posting) stays a separate thing: chat_management_open (reason + visible notice).

-- Idempotent in-place function patch: refuses to run if the anchor text is not found (so a drifted function is never silently skipped).
create or replace function pg_temp.patch_fn(p_sig regprocedure, p_regex text, p_to text, p_already text default null) returns void language plpgsql as $$
declare d text; n text;
begin
  d := pg_get_functiondef(p_sig);
  if position(coalesce(p_already, p_to) in d) > 0 then return; end if;
  if d !~* p_regex then raise exception 'patch anchor not found in %: %', p_sig, left(p_regex, 80); end if;
  n := regexp_replace(d, p_regex, replace(p_to, '\', '\\'), 'i');
  execute n;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Confidential-domain guard through the capability
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.staff_task_is_confidential(t public.staff_tasks)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.departments d where d.id in (t.from_department_id, t.to_department_id) and d.is_confidential_domain);
$$;

create or replace function public.staff_can_view_task(t public.staff_tasks)
returns boolean language sql stable security definer set search_path = public as $$
  select public.staff_current_user_ok() and (
    -- Director / Management / Super Admin: every operational task in the organization (confidential ones only with the finance capability)
    (public.staff_has_global_oversight()
       and (not public.staff_task_is_confidential(t) or public.staff_has_capability('can_view_restricted_finance')))
    or (
      (not public.staff_task_is_confidential(t) or public.staff_has_capability('can_view_restricted_finance'))
      and (
        t.assigned_by = auth.uid() or t.assigned_to = auth.uid() or t.current_owner_id = auth.uid() or t.verifier_id = auth.uid()
        or exists (select 1 from public.staff_task_assignees a where a.task_id = t.id and a.user_id = auth.uid() and a.is_active)
        -- Department Head: tasks OWNED by their authorized department; plus Bridge Tasks they sent out.
        or (public.staff_is_dept_head() and (
              public.staff_dept_in_hod_scope(t.to_department_id)
              or (t.is_bridge and public.staff_dept_in_hod_scope(t.from_department_id))))
        -- Supervisor: tasks owned by their own department (incl. Bridge Tasks routed to it). NOT other departments.
        or (public.staff_is_supervisor() and t.to_department_id = public.staff_current_department_id())
        or (public.staff_is_accounts_head() and (t.from_department_id = public.staff_current_department_id() or t.to_department_id = public.staff_current_department_id()))
        -- Project team members see the project's tasks ONLY while those tasks belong to the member's own department
        or (t.project_id is not null and t.to_department_id = public.staff_current_department_id() and public.interior_is_project_member(t.project_id))
      )
    )
  );
$$;

select pg_temp.patch_fn('public.staff_record_attachment(text, uuid, text, text, text, text, bigint, integer)'::regprocedure,
  'if coalesce\(v_confidential, false\) and not \(public\.staff_is_management\(\) or public\.staff_is_super_admin\(\) or public\.staff_is_accounts_head\(\) or public\.staff_current_role_code\(\) in \(''accounts_employee'',''cfo''\)\) then',
  'if coalesce(v_confidential, false) and not public.staff_has_capability(''can_view_restricted_finance'') then');

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. Destructive / user-management actions need their explicit capability (management + sysadmin hold them today, so nothing changes
--    until an administrator revokes one). The creator / department-head paths of these RPCs are untouched.
-- ---------------------------------------------------------------------------------------------------------------------------------
select pg_temp.patch_fn('public.staff_delete_task(uuid)'::regprocedure,
  'public\.staff_is_management\(\)\s+OR\s+public\.staff_is_super_admin\(\)',
  '(public.staff_has_global_oversight() AND public.staff_has_capability(''can_delete_records''))');

select pg_temp.patch_fn('public.staff_delete_interior_project(uuid)'::regprocedure,
  'public\.staff_is_management\(\)\s+OR\s+public\.staff_is_super_admin\(\)',
  '(public.staff_has_global_oversight() AND public.staff_has_capability(''can_delete_records''))');

select pg_temp.patch_fn('public.staff_delete_user(uuid, text, text, uuid)'::regprocedure,
  'public\.staff_is_management\(\)\s+OR\s+public\.staff_is_super_admin\(\)',
  '(public.staff_has_global_oversight() and public.staff_has_capability(''can_manage_users''))');

select pg_temp.patch_fn('public.staff_update_user_role(uuid, text)'::regprocedure,
  'IF v_caller_role NOT IN \(''sysadmin'', ''management''\) THEN',
  'IF v_caller_role NOT IN (''sysadmin'', ''management'') OR NOT public.staff_has_capability(''can_manage_users'') THEN');

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. Interior audit log + the Management & Department Heads channel membership use the same central definition
-- ---------------------------------------------------------------------------------------------------------------------------------
drop policy if exists "managers read audit" on public.audit_log;
create policy "managers read audit" on public.audit_log for select to authenticated using (
  (public.staff_current_user_ok() and public.staff_has_global_oversight())
  or exists (select 1 from public.profiles pr
              where pr.auth_id = (select auth.uid()) and pr.active = true
                and lower(pr.role) = any (array['director', 'interior department head', 'head', 'department head', 'interior head'])));

create or replace function public.chat_sync_management()
returns uuid language plpgsql security definer set search_path = public as $$
declare v_conv uuid; v_users uuid[]; v_roles text[];
begin
  insert into public.chat_conversations (type, title) values ('management', 'Management & Department Heads')
  on conflict (type) where type = 'management' do update set title = excluded.title returning id into v_conv;
  select array_agg(up.id), array_agg(case when public.staff_role_family(ro.code) is not null then 'management' else 'department_head' end)
    into v_users, v_roles
    from public.user_profiles up join public.roles ro on ro.id = up.role_id
   where up.is_active and (public.staff_role_family(ro.code) is not null or ro.code = 'dept_head');
  perform public.chat_reconcile(v_conv, coalesce(v_users, '{}'), coalesce(v_roles, '{}'), 'management channel', false);
  return v_conv;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. Chat oversight (view) vs participation (member / notifications / posting)
-- ---------------------------------------------------------------------------------------------------------------------------------
-- A conversation about Accounts/Finance (its department, or the task it is about) is restricted.
create or replace function public.chat_is_restricted(p_conv uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chat_conversations c
      left join public.departments d on d.id = c.department_id
      left join public.staff_tasks t on t.id = c.task_id
      left join public.departments td on td.id in (t.from_department_id, t.to_department_id)
     where c.id = p_conv and (coalesce(d.is_confidential_domain, false) or coalesce(td.is_confidential_domain, false)));
$$;

-- May the caller READ this conversation as an overseer? Direct (private) and AI-assistant chats are never in scope; restricted chats need
-- the finance capability; and an oversight SESSION (a chat_access_log row from chat_oversight_open in the last 12 h) must exist.
create or replace function public.chat_can_oversee(p_conv uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.staff_has_global_oversight()
    and public.staff_current_user_ok()
    and public.staff_has_capability('can_view_all_operational_chats')
    and exists (select 1 from public.chat_conversations c
                 where c.id = p_conv and c.management_visible and c.type not in ('direct', 'ai_assistant') and c.migration_status is null)
    and (not public.chat_is_restricted(p_conv) or public.staff_has_capability('can_view_restricted_finance'))
    and exists (select 1 from public.chat_access_log l
                 where l.conversation_id = p_conv and l.user_id = auth.uid() and l.action = 'management_view'
                   and l.created_at > now() - interval '12 hours');
$$;

-- Opens a view-only oversight session and records it (chat_access_log + staff_audit_log with the actor's role). Does NOT add the caller as
-- a participant: no member list entry, no "joined" notice, no unread counts, no notifications, no posting.
create or replace function public.chat_oversight_open(p_conversation uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.chat_conversations%rowtype; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.staff_assert_operational();
  if not (public.staff_has_global_oversight() and public.staff_has_capability('can_view_all_operational_chats')) then raise exception 'Not authorized'; end if;
  select * into c from public.chat_conversations
   where id = p_conversation and management_visible and type not in ('direct', 'ai_assistant') and migration_status is null;
  if c.id is null then raise exception 'Conversation not found'; end if;
  if public.chat_is_restricted(p_conversation) and not public.staff_has_capability('can_view_restricted_finance') then
    raise exception 'This conversation is restricted';
  end if;
  if not exists (select 1 from public.chat_access_log l where l.conversation_id = p_conversation and l.user_id = auth.uid()
                    and l.action = 'management_view' and l.created_at > now() - interval '30 minutes') then
    insert into public.chat_access_log (conversation_id, user_id, action, reason) values (p_conversation, auth.uid(), 'management_view', v_reason);
    perform public.staff_write_audit('chat_conversation', p_conversation, 'MANAGEMENT_VIEW', null,
      jsonb_build_object('type', c.type, 'title', c.title, 'mode', 'read_only'), c.department_id, v_reason);
  end if;
  return jsonb_build_object('conversation_id', p_conversation, 'read_only', not public.chat_is_participant(p_conversation),
                            'expires_at', now() + interval '12 hours');
end $$;

create or replace function public.chat_can_read_msg(p_conv uuid, p_task uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.staff_current_user_ok() and (public.chat_msg_visible_to(p_conv, p_task, auth.uid()) or public.chat_can_oversee(p_conv));
$$;

drop policy if exists chat_conversations_select on public.chat_conversations;
create policy chat_conversations_select on public.chat_conversations for select to authenticated
  using (public.chat_is_participant(id) or public.chat_can_oversee(id));

-- details: an overseer may load the header/context of a conversation they are not in (read-only; i_can_post stays false)
select pg_temp.patch_fn('public.chat_conversation_details(uuid)'::regprocedure,
  'if not public\.chat_is_participant\(p_conversation\) then raise exception ''Conversation not found''; end if;',
  'if not (public.chat_is_participant(p_conversation) or public.chat_can_oversee(p_conversation)) then raise exception ''Conversation not found''; end if;');
select pg_temp.patch_fn('public.chat_conversation_details(uuid)'::regprocedure,
  'select p\.scope into v_scope from public\.chat_participants p where p\.conversation_id = p_conversation and p\.user_id = v_me;',
  'select p.scope into v_scope from public.chat_participants p where p.conversation_id = p_conversation and p.user_id = v_me; v_scope := coalesce(v_scope, ''full'');');
select pg_temp.patch_fn('public.chat_conversation_details(uuid)'::regprocedure,
  '''notice'', case when v_scope = ''task'' then',
  '''oversight'', not public.chat_is_participant(p_conversation), ''notice'', case when not public.chat_is_participant(p_conversation) then ''Management oversight: you are viewing this conversation read-only. You have not joined it and will not receive its notifications.'' when v_scope = ''task'' then');

-- directory: hide restricted conversations from people without the finance capability, and say which rows can be viewed read-only
select pg_temp.patch_fn('public.chat_management_directory(text, text)'::regprocedure,
  'and cc\.migration_status is null',
  'and cc.migration_status is null and (not public.chat_is_restricted(cc.id) or public.staff_has_capability(''can_view_restricted_finance''))');
select pg_temp.patch_fn('public.chat_management_directory(text, text)'::regprocedure,
  '''is_active'', c\.is_active,',
  '''oversight_allowed'', c.type <> ''direct'', ''is_active'', c.is_active,');
select pg_temp.patch_fn('public.chat_management_directory(text, text)'::regprocedure,
  'public\.staff_is_management\(\)\s+or\s+public\.staff_is_super_admin\(\)',
  '(public.staff_has_global_oversight() and public.staff_has_capability(''can_view_all_operational_chats''))');
-- joining as a participant (the older, reason-required path) is also blocked for restricted chats without the capability
select pg_temp.patch_fn('public.chat_management_open(uuid, text)'::regprocedure,
  'raise exception ''Conversation not found''; end if;',
  'raise exception ''Conversation not found''; end if; if public.chat_is_restricted(p_conversation) and not public.staff_has_capability(''can_view_restricted_finance'') then raise exception ''This conversation is restricted''; end if;');
select pg_temp.patch_fn('public.chat_management_open(uuid, text)'::regprocedure,
  'public\.staff_is_management\(\)\s+or\s+public\.staff_is_super_admin\(\)',
  '(public.staff_has_global_oversight() and public.staff_has_capability(''can_view_all_operational_chats''))');

revoke execute on function public.staff_task_is_confidential(public.staff_tasks), public.chat_is_restricted(uuid), public.chat_can_oversee(uuid),
  public.chat_oversight_open(uuid, text) from public, anon;
grant execute on function public.staff_task_is_confidential(public.staff_tasks), public.chat_is_restricted(uuid), public.chat_can_oversee(uuid),
  public.chat_oversight_open(uuid, text) to authenticated;
