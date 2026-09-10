// Mood of Wood — Staff Pilot — browser-native push notifications.
//
// Shows a system-level notification the instant a row lands in
// `notifications` via Supabase Realtime, on every open device/tab signed
// in as this user (each one holds its own independent Realtime
// subscription, so this fires everywhere the app is open at once).
//
// This is the Notification API, NOT Web Push: it only fires while this
// browser tab is open (foreground or backgrounded), not when the browser
// itself is fully closed. True closed-browser push would need a service
// worker, VAPID keys, and a server-side sender — a separate, larger piece
// of infrastructure than this pilot currently has.

export function isNotificationSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function requestNotificationPermission() {
  if (!isNotificationSupported()) return "unsupported";
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

// `id` is used as the notification `tag` so a duplicate Realtime delivery
// of the same row replaces rather than stacks; never throws — some
// browsers (e.g. iOS Safari outside an installed PWA) reject
// `new Notification(...)` synchronously, and a failed popup should never
// break the realtime handler that triggered it.
export function showBrowserNotification({ id, title, body }) {
  if (!isNotificationSupported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, tag: id });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // ignored — see comment above
  }
}
