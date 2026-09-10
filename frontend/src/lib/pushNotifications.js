// Mood of Wood — Staff Pilot — push notifications, two layers:
//
// 1. Foreground/backgrounded realtime popup (showBrowserNotification,
//    called from App.jsx's Supabase Realtime subscription): fires the
//    instant a row lands in `notifications` while this tab/installed app
//    is open, on every open device/tab at once.
// 2. True Web Push (subscribeToPush, below): registers this device with
//    the browser's push service so a notification arrives even with the
//    app fully closed/swiped away. The actual send happens server-side —
//    a Postgres trigger on `notifications` (migration
//    mvp_pilot_web_push_v2_2l.sql) calls the send-push Edge Function,
//    which delivers to every subscribed device via VAPID-signed Web Push.
//    This file only handles the subscribe side; sw.js's `push` event
//    listener is what actually shows the notification when one arrives
//    with the app closed.
//
// IMPORTANT: once a service worker is registered and controlling the page
// (true for every device since the PWA/"Add to Home Screen" feature was
// added — see vite-plugin-pwa in vite.config.js), Chrome on Android
// throws `TypeError: Illegal constructor` on a plain `new Notification()`
// call and REQUIRES `ServiceWorkerRegistration.showNotification()`
// instead — this was the actual cause of "notifications don't work on
// phone/tablet" (desktop Chrome tolerates the old constructor either way,
// which is why it could look fine there). Always go through the SW
// registration; fall back to the constructor only on the rare browser
// with Notification support but no service worker.
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
// browsers (e.g. iOS Safari outside an installed PWA) reject notifications
// entirely, and a failed popup should never break the realtime handler
// that triggered it.
export async function showBrowserNotification({ id, title, body, url }) {
  if (!isNotificationSupported() || Notification.permission !== "granted") return;
  const options = { body, tag: id, data: { url: url || "/" }, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png" };
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if (reg) {
        await reg.showNotification(title, options);
        return;
      }
    }
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); n.close(); };
  } catch {
    // ignored — see comment above
  }
}

// Web Push's applicationServerKey wants a raw Uint8Array, but VAPID public
// keys travel as base64url text — this is the standard conversion (MDN's
// own push-notifications guide uses this exact snippet).
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Subscribes this device to Web Push and saves the subscription so the
// send-push Edge Function can find it. Safe to call every app load — it
// reuses an existing subscription instead of creating duplicates, and
// no-ops quietly if the platform doesn't support Push (e.g. iOS Safari
// outside an installed home-screen app) or permission isn't granted yet.
export async function subscribeToPush(supabase) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (!isNotificationSupported() || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      const { data: publicKey, error: keyErr } = await supabase.rpc("push_get_vapid_public_key");
      if (keyErr || !publicKey) return;
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const json = subscription.toJSON();
    await supabase.from("push_subscriptions").upsert(
      {
        endpoint: json.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
        user_agent: navigator.userAgent,
      },
      { onConflict: "endpoint" },
    );
  } catch {
    // Never block app boot on a push-subscribe failure (e.g. the user
    // dismissed the browser's own subscribe prompt).
  }
}
