-- v2_88 -- staff_list_assignable_users(): "column reference "id" is ambiguous" (the OUT column `id` clashed with departments.id in the
-- department checks), so every call failed with HTTP 400 and the Factory task form / Factory Tasks staff filter got no people.
-- Only the name-resolution directive is added; the authorization logic is unchanged. Applied to the live project.
do $$
declare v_old text; v_new text;
begin
  v_old := pg_get_functiondef('public.staff_list_assignable_users(uuid)'::regprocedure);
  if position('#variable_conflict' in v_old) > 0 then return; end if;
  v_new := replace(v_old, E'AS $function$\ndeclare', E'AS $function$\n#variable_conflict use_column\ndeclare');
  if v_new = v_old then raise exception 'staff_list_assignable_users patch did not apply'; end if;
  execute v_new;
end $$;
