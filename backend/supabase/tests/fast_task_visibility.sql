-- v3_18: for EVERY user on the database, the new policies show exactly the same tasks, assignees, bridges, task messages and
-- attachments as the original rules (staff_can_view_task / staff_task_visible, evaluated directly). Read-only; always rolls back.
do $t$
declare
  u record; v_log text := ''; n_users int := 0; n_bad int := 0;
  o_t uuid[]; n_t uuid[]; o_a uuid[]; n_a uuid[]; o_b uuid[]; n_b uuid[]; o_m uuid[]; n_m uuid[]; o_f uuid[]; n_f uuid[];
begin
  for u in select id, full_name from user_profiles order by full_name loop
    perform set_config('request.jwt.claims', json_build_object('sub', u.id, 'role', 'authenticated')::text, true);
    -- original rules, evaluated directly (as the table owner, no policy involved)
    select coalesce(array_agg(id order by id), '{}') into o_t from staff_tasks t where staff_can_view_task(t);
    select coalesce(array_agg(id order by id), '{}') into o_a from staff_task_assignees a where a.user_id = u.id or staff_task_visible(a.task_id);
    select coalesce(array_agg(id order by id), '{}') into o_b from bridges b
      where staff_current_user_ok() and (b.from_person_id = u.id or b.to_person_id = u.id or staff_task_visible(b.task_id));
    select coalesce(array_agg(id order by id), '{}') into o_m from task_messages m where staff_current_user_ok() and staff_task_visible(m.task_id);
    select coalesce(array_agg(id order by id), '{}') into o_f from staff_attachments f where staff_current_user_ok() and (
      f.uploaded_by = u.id or staff_is_management() or staff_is_super_admin() or (f.entity_type = 'task' and staff_task_visible(f.entity_id))
      or (f.entity_type = 'bridge' and exists (select 1 from bridges b where b.id = f.entity_id and (b.from_person_id = u.id or b.to_person_id = u.id or staff_task_visible(b.task_id)))));
    -- new policies, as the signed-in user
    set local role authenticated;
    select coalesce(array_agg(id order by id), '{}') into n_t from staff_tasks;
    select coalesce(array_agg(id order by id), '{}') into n_a from staff_task_assignees;
    select coalesce(array_agg(id order by id), '{}') into n_b from bridges;
    select coalesce(array_agg(id order by id), '{}') into n_m from task_messages;
    select coalesce(array_agg(id order by id), '{}') into n_f from staff_attachments;
    reset role;
    n_users := n_users + 1;
    if o_t <> n_t or o_a <> n_a or o_b <> n_b or o_m <> n_m or o_f <> n_f then
      n_bad := n_bad + 1;
      v_log := v_log || 'FAIL  ' || u.full_name || format(' tasks %s/%s assignees %s/%s bridges %s/%s messages %s/%s files %s/%s',
        cardinality(o_t), cardinality(n_t), cardinality(o_a), cardinality(n_a), cardinality(o_b), cardinality(n_b), cardinality(o_m), cardinality(n_m), cardinality(o_f), cardinality(n_f)) || E'\n';
    end if;
  end loop;
  v_log := v_log || case when n_bad = 0 then 'PASS  ' else 'FAIL  ' end || format('%s users: identical tasks, assignees, bridges, task messages and attachments (%s differ)', n_users, n_bad) || E'\n';
  raise exception E'\n%', v_log;
end $t$;
