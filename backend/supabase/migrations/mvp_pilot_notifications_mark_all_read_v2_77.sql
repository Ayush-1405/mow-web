-- mvp_pilot_notifications_mark_all_read_v2_77
--
-- "Mark all read" for the Notifications screen. Same rules as
-- staff_mark_notification_read: only the caller's own rows, operational
-- users only. Returns how many rows changed. Additive; touches no data.

create or replace function public.staff_mark_all_notifications_read()
returns integer
language plpgsql security definer set search_path to 'public' as $function$
declare v_count integer;
begin
  perform public.staff_assert_operational();
  update public.notifications set is_read = true, read_at = now()
  where recipient_id = auth.uid() and is_read = false;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
revoke all on function public.staff_mark_all_notifications_read() from public;
grant execute on function public.staff_mark_all_notifications_read() to authenticated;
