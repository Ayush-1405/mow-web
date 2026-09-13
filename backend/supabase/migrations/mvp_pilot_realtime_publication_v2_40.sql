-- Enables Supabase Realtime for every live operational table the Interior
-- module (and the shared task system) actually uses. Only `bridges`,
-- `notifications`, and `staff_tasks` were previously in the publication --
-- verified live via pg_publication_tables -- which is why none of the
-- Interior screens ever saw another user's/tab's change without a manual
-- reload. Idempotent: checks membership before adding, so it is safe to
-- run again (e.g. if this migration is ever replayed).
do $$
declare t text;
begin
  foreach t in array array[
    'projects', 'project_members', 'site_reports', 'tasks', 'project_materials', 'materials',
    'attachments', 'working_drawing_attachments', 'material_selection_attachments',
    'purchase_requests', 'purchase_checklist_items', 'purchase_checklist_results', 'purchase_attachments',
    'project_requests', 'snags', 'project_changes', 'activity_logs', 'interior_pilot_audit_log',
    'interior_payment_records', 'customer_feedback', 'handovers'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
