import { supabase } from "./supabase";

// One reusable Realtime subscription helper, used everywhere instead of
// hand-rolled channel code. RLS is what actually scopes which rows a given
// subscriber receives (same as this app's existing staff_tasks/notifications
// channels, which pass no client-side filter and rely on RLS entirely) -- a
// `filter` string here (e.g. `project_id=eq.<uuid>`) is a convenience to cut
// down needless event delivery for a specific screen, never the security
// boundary. Returns a cleanup function; always call it from a useEffect's
// return so the channel is torn down on unmount/dependency change.
export function subscribeTable(channelName, table, filter, onEvent) {
  const channel = supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      filter ? { event: "*", schema: "public", table, filter } : { event: "*", schema: "public", table },
      onEvent,
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// Insert-or-replace by id -- used by a realtime INSERT/UPDATE handler so the
// same record arriving twice (e.g. this tab's own optimistic refetch racing
// a realtime event) never produces a duplicate row.
export function upsertById(list, record, idKey = "id") {
  return list.some((r) => r[idKey] === record[idKey])
    ? list.map((r) => (r[idKey] === record[idKey] ? record : r))
    : [record, ...list];
}

export function removeById(list, id, idKey = "id") {
  return list.filter((r) => r[idKey] !== id);
}
