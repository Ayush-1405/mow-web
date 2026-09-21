-- Voice instruction (v2_92): recording linked to a task, who may attach / see / remove it, replacement, archiving, limits.
-- Runs against REAL users and a REAL task, impersonating each through SET LOCAL ROLE authenticated + request.jwt.claims, and ALWAYS rolls back
-- (the report is in the error message). Storage objects are faked with rows in storage.objects inside the same transaction.

do $t$
declare
  v_log text := ''; v_task uuid; v_assigner uuid; v_assignee uuid; v_other uuid; v_mgmt uuid; v_second uuid;
  p1 text; p2 text; p3 text; v_att uuid; v_att2 uuid; n int; v_name text; v_err text; v_dept_from uuid; v_dept_to uuid;
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  -- a real, non-confidential, active task with an assigner and a different assignee
  select t.id, t.assigned_by, t.assigned_to, t.from_department_id, t.to_department_id into v_task, v_assigner, v_assignee, v_dept_from, v_dept_to
    from staff_tasks t join user_profiles a on a.id = t.assigned_by and a.is_active and not a.must_change_password
                       join user_profiles b on b.id = t.assigned_to and b.is_active and not b.must_change_password
   where t.is_active and t.assigned_by <> t.assigned_to and not public.staff_task_is_confidential(t)
     and not exists (select 1 from roles r where r.id = a.role_id and r.code in ('management', 'sysadmin'))
   order by t.created_at desc limit 1;
  -- an unrelated ordinary employee (not on this task, not in its departments)
  select up.id into v_other from user_profiles up join roles r on r.id = up.role_id
   where up.is_active and not up.must_change_password and r.code = 'employee' and up.id not in (v_assigner, v_assignee)
     and up.department_id is distinct from v_dept_from and up.department_id is distinct from v_dept_to limit 1;
  select up.id into v_mgmt from user_profiles up join roles r on r.id = up.role_id where up.is_active and not up.must_change_password and r.code = 'management' limit 1;
  select up.id into v_second from user_profiles up where up.is_active and not up.must_change_password and up.id not in (v_assigner, v_assignee, coalesce(v_other, v_assigner), v_mgmt)
     and up.department_id = v_dept_to limit 1;
  v_log := public.zz_chk(v_log, 'fixture: task, assigner, assignee, unrelated user, management user found', v_task is not null and v_assigner is not null and v_assignee is not null and v_other is not null and v_mgmt is not null);
  delete from staff_attachments where entity_id = v_task and file_type = 'voice';

  -- three recordings "uploaded" by the assigner: the way a browser reports it (with codecs), plus a second one, plus a too-big one
  p1 := v_assigner::text || '/voice/1000-aaaa.webm'; p2 := v_assigner::text || '/voice/2000-bbbb.webm'; p3 := v_assigner::text || '/voice/3000-cccc.webm';
  insert into storage.objects (bucket_id, name, owner, metadata) values
    ('staff-attachments', p1, v_assigner, '{"mimetype":"audio/webm","size":300000}'),
    ('staff-attachments', p2, v_assigner, '{"mimetype":"audio/webm","size":250000}'),
    ('staff-attachments', p3, v_assigner, '{"mimetype":"audio/webm","size":6000000}');

  ---------------------------------------------------------------- linking
  perform set_config('request.jwt.claims', json_build_object('sub', v_assigner, 'role', 'authenticated')::text, true); set local role authenticated;
  begin v_att := public.staff_record_attachment('task', v_task, 'voice', p1, 'voice-message.webm', 'audio/webm;codecs=opus', 300000, 12, 'instruction');
        v_log := public.zz_chk(v_log, 'assigner links a recording declared "audio/webm;codecs=opus" (stored as audio/webm) -- the old mime mismatch is gone', v_att is not null);
  exception when others then v_log := public.zz_chk(v_log, 'assigner links a recording declared with codecs: ' || sqlerrm, false); end;
  begin perform public.staff_record_attachment('task', v_task, 'voice', p1, 'voice-message.webm', 'audio/webm', 300000, 12, 'instruction');
        v_log := public.zz_chk(v_log, 'linking the same stored object twice returns the same row (no duplicate audio)', (select count(*) from staff_attachments where storage_path = p1) = 1);
  exception when others then v_log := public.zz_chk(v_log, 'idempotent re-link: ' || sqlerrm, false); end;
  begin perform public.staff_record_attachment('task', v_task, 'voice', p3, 'big.webm', 'audio/webm', 6000000, 30, 'instruction'); v_log := public.zz_chk(v_log, 'a voice file over 5 MB is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a voice file over 5 MB is refused (' || sqlerrm || ')', sqlerrm ilike '%5 MB%'); end;
  begin perform public.staff_record_attachment('task', v_task, 'voice', p2, 'v.webm', 'audio/webm', 250000, 75, 'instruction'); v_log := public.zz_chk(v_log, 'a voice message over 60 s is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a voice message over 60 s is refused', sqlerrm ilike '%60 seconds%'); end;
  begin perform public.staff_record_attachment('task', v_task, 'voice', p2, 'v.webm', 'video/mp4', 250000, 5, 'instruction'); v_log := public.zz_chk(v_log, 'a non-audio type is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a non-audio type is refused', true); end;
  begin perform public.staff_record_attachment('task', v_task, 'voice', v_other::text || '/voice/x.webm', 'v.webm', 'audio/webm', 250000, 5, 'instruction'); v_log := public.zz_chk(v_log, 'a path under someone else''s prefix is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a path under someone else''s prefix is refused', sqlerrm ilike '%own upload prefix%'); end;
  begin perform public.staff_record_attachment('task', v_task, 'pdf', p2, 'a.pdf', 'application/pdf', 250000, null, 'instruction'); v_log := public.zz_chk(v_log, 'only a VOICE recording can be an instruction', false);
  exception when others then v_log := public.zz_chk(v_log, 'only a VOICE recording can be an instruction', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'stored row: bucket, purpose, size, duration, uploader, mime', (select count(*) from staff_attachments where id = v_att and storage_bucket = 'staff-attachments' and purpose = 'instruction'
      and file_size = 300000 and duration_seconds = 12 and uploaded_by = v_assigner and file_type = 'voice' and is_active) = 1);
  v_log := public.zz_chk(v_log, 'linking wrote an ATTACH audit row with the acting role', (select count(*) from staff_audit_log where entity_id = v_task and action = 'ATTACH' and performed_by = v_assigner and performed_by_role is not null) >= 1);

  -- the assignee (not the assigner, not a manager) cannot attach an INSTRUCTION to someone else's task
  insert into storage.objects (bucket_id, name, owner, metadata) values ('staff-attachments', v_assignee::text || '/voice/9-zzzz.webm', v_assignee, '{"mimetype":"audio/webm","size":1000}');
  perform set_config('request.jwt.claims', json_build_object('sub', v_assignee, 'role', 'authenticated')::text, true); set local role authenticated;
  begin perform public.staff_record_attachment('task', v_task, 'voice', v_assignee::text || '/voice/9-zzzz.webm', 'v.webm', 'audio/webm', 1000, 5, 'instruction'); v_log := public.zz_chk(v_log, 'the assignee cannot add a voice INSTRUCTION to the task', false);
  exception when others then v_log := public.zz_chk(v_log, 'the assignee cannot add a voice INSTRUCTION to the task (' || sqlerrm || ')', sqlerrm ilike '%assigned this task%'); end;
  begin v_att2 := public.staff_record_attachment('task', v_task, 'voice', v_assignee::text || '/voice/9-zzzz.webm', 'note.webm', 'audio/webm', 1000, 5, null);
        v_log := public.zz_chk(v_log, 'the assignee CAN still add an ordinary voice note (completion proof / note)', v_att2 is not null);
  exception when others then v_log := public.zz_chk(v_log, 'assignee ordinary voice note: ' || sqlerrm, false); end;
  reset role;

  ---------------------------------------------------------------- visibility
  perform set_config('request.jwt.claims', json_build_object('sub', v_assignee, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*), max(recorded_by_name) into n, v_name from staff_task_voice_instructions(array[v_task]);
  v_log := public.zz_chk(v_log, 'primary assignee sees the instruction (with the recorder''s name: ' || coalesce(v_name, 'null') || ')', n = 1 and v_name is not null);
  select count(*) into n from staff_attachments where id = v_att;
  v_log := public.zz_chk(v_log, 'assignee can read the attachment row (playback authorization)', n = 1);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgmt, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into n from staff_task_voice_instructions(array[v_task]);
  v_log := public.zz_chk(v_log, 'management (global view) sees the instruction of a task it is not on', n = 1);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into n from staff_task_voice_instructions(array[v_task]);
  v_log := public.zz_chk(v_log, 'an unrelated employee gets NOTHING from the batch query', n = 0);
  select count(*) into n from staff_attachments where id = v_att;
  v_log := public.zz_chk(v_log, 'an unrelated employee cannot read the attachment row directly (so cannot get a signed URL either)', n = 0);
  reset role;

  if v_second is not null then
    begin
      insert into staff_task_assignees (task_id, user_id, assignment_role, is_active) values (v_task, v_second, 'secondary', true);
      perform set_config('request.jwt.claims', json_build_object('sub', v_second, 'role', 'authenticated')::text, true); set local role authenticated;
      select count(*) into n from staff_task_voice_instructions(array[v_task]);
      v_log := public.zz_chk(v_log, 'second assignee sees the instruction', n = 1);
      reset role;
    exception when others then reset role; v_log := v_log || 'SKIP  second-assignee fixture: ' || sqlerrm || E'\n'; end;
  end if;

  ---------------------------------------------------------------- replacement: one active instruction per task
  perform set_config('request.jwt.claims', json_build_object('sub', v_assigner, 'role', 'authenticated')::text, true); set local role authenticated;
  v_att2 := public.staff_record_attachment('task', v_task, 'voice', p2, 'voice-message2.webm', 'audio/webm', 250000, 8, 'instruction');
  reset role;
  select count(*) into n from staff_attachments where entity_id = v_task and purpose = 'instruction' and is_active;
  v_log := public.zz_chk(v_log, 'recording a new instruction replaces the old one: exactly ONE active', n = 1 and (select is_active from staff_attachments where id = v_att2));
  v_log := public.zz_chk(v_log, 'the replaced recording is archived (who / when / why), not lost', (select count(*) from staff_attachments where id = v_att and not is_active and removed_at is not null and removed_by = v_assigner and removal_reason ilike '%replaced%') = 1);
  v_log := public.zz_chk(v_log, 'replacement is audited', (select count(*) from staff_audit_log where entity_id = v_task and action = 'ATTACH_REPLACE') >= 1);

  ---------------------------------------------------------------- removal
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  begin perform public.staff_remove_attachment(v_att2, 'nope'); v_log := public.zz_chk(v_log, 'an unrelated employee cannot remove it', false);
  exception when others then v_log := public.zz_chk(v_log, 'an unrelated employee cannot remove it', true); end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_assigner, 'role', 'authenticated')::text, true); set local role authenticated;
  perform public.staff_remove_attachment(v_att2, 'wrong recording');
  reset role;
  v_log := public.zz_chk(v_log, 'the assigner can remove it: archived + audited', (select count(*) from staff_attachments where id = v_att2 and not is_active and removal_reason = 'wrong recording') = 1
      and (select count(*) from staff_audit_log where entity_id = v_task and action = 'ATTACH_REMOVE' and performed_by = v_assigner) >= 1);
  perform set_config('request.jwt.claims', json_build_object('sub', v_assignee, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into n from staff_task_voice_instructions(array[v_task]);
  v_log := public.zz_chk(v_log, 'once removed, the instruction no longer appears for the assignee', n = 0);
  reset role;

  ---------------------------------------------------------------- task deletion archives its attachments
  insert into staff_attachments (entity_type, entity_id, file_type, storage_path, original_filename, mime_type, file_size, duration_seconds, uploaded_by, purpose)
    values ('task', v_task, 'voice', v_assigner::text || '/voice/4000-dddd.webm', 'x.webm', 'audio/webm', 100, 3, v_assigner, 'instruction');
  perform set_config('request.jwt.claims', json_build_object('sub', v_assigner, 'role', 'authenticated')::text, true); set local role authenticated;
  perform public.staff_delete_task(v_task);
  reset role;
  v_log := public.zz_chk(v_log, 'deleting the task archives its voice attachment (kept for audit, hidden from lists)',
    (select count(*) from staff_attachments where entity_id = v_task and is_active) = 0 and (select count(*) from staff_attachments where entity_id = v_task and removal_reason = 'task deleted') >= 1);

  raise exception E'VOICE-INSTRUCTION-REPORT (rolled back)\n%', v_log;
end $t$;
