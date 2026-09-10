-- Auto-delete every notification (read or unread) older than 2 days.
-- Runs daily via pg_cron, same pattern as staff_send_daily_task_reminders.
CREATE OR REPLACE FUNCTION public.staff_purge_old_notifications()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.notifications WHERE created_at < now() - interval '2 days';
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_purge_old_notifications() FROM PUBLIC;

-- 4:00 AM UTC = 9:30 AM IST — a few minutes after the existing daily task
-- reminder job (3:30 AM UTC), so the two never run at the exact same tick.
SELECT cron.schedule(
  'staff-purge-old-notifications',
  '0 4 * * *',
  $$SELECT public.staff_purge_old_notifications();$$
);
