// Mood of Wood — Staff Pilot — notifications, two layers:
//
// 1. Foreground/backgrounded realtime popup (showBrowserNotification, called from App.jsx's Supabase Realtime subscription): fires the
//    instant a row lands in `notifications` while this tab/installed app is open, on every open device/tab at once.
// 2. True Web Push (subscribeToPush below): registers this device with the browser's push service so a notification arrives even with the
//    app fully closed/swiped away. The send happens server-side -- a Postgres trigger on `notifications` calls the send-push Edge Function
//    (high urgency), which delivers to every subscribed device via VAPID-signed Web Push. sw.js's `push` listener shows it.
//
// Permission MUST be asked from a user gesture (a tap): iPhone Safari and current Chrome silently ignore or auto-block a permission request
// made on page load, which is why some people never received anything. enablePushNotifications() is therefore only called from a button.
//
// Once a service worker controls the page, Chrome on Android throws `Illegal constructor` on `new Notification()`, so everything goes through
// ServiceWorkerRegistration.showNotification().
export function isNotificationSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

export function isStandaloneApp() {
  if (typeof window === "undefined") return false;
  return !!(window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true);
}

// iPhone/iPad only deliver Web Push to an app that was added to the Home Screen and is opened from there.
function isIOSDevice() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

// "unsupported" | "needs-install" | "denied" | "default" | "granted-unsubscribed" | "granted"
export async function getPushStatus() {
  if (typeof window === "undefined") return "unsupported";
  const pushCapable = "serviceWorker" in navigator && "PushManager" in window && isNotificationSupported();
  if (!pushCapable) return isIOSDevice() && !isStandaloneApp() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "default";
  try {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.pushManager.getSubscription()) ? "granted" : "granted-unsubscribed";
  } catch {
    return "granted-unsubscribed";
  }
}

export async function requestNotificationPermission() {
  if (!isNotificationSupported()) return "unsupported";
  if (Notification.permission === "granted" || Notification.permission === "denied") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

// `id` is used as the notification `tag` so the same row arriving twice (realtime popup AND the push) replaces rather than stacks; never
// throws -- a failed popup must never break the realtime handler that triggered it.
export async function showBrowserNotification({ id, title, body, url }) {
  if (!isNotificationSupported() || Notification.permission !== "granted") return;
  const options = { body, tag: id, data: { url: url || "/" }, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", vibrate: [200, 100, 200] };
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
    // ignored
  }
}

// Web Push's applicationServerKey wants a raw Uint8Array, but VAPID public keys travel as base64url text.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Subscribes this device to Web Push and saves the subscription so the send-push Edge Function can find it. Safe to call as often as you
// like (app load, every return to the app): it reuses the existing subscription and just re-saves it, which also heals a subscription the
// push service rotated or the server deleted as expired. Returns true when the device is registered.
export async function subscribeToPush(supabase) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  if (!isNotificationSupported() || Notification.permission !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      const { data: publicKey, error: keyErr } = await supabase.rpc("push_get_vapid_public_key");
      if (keyErr || !publicKey) return false;
      subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    }
    const json = subscription.toJSON();
    // Routed through an RPC so it can safely reassign a shared device's subscription to whoever is currently logged in.
    const { error } = await supabase.rpc("push_upsert_subscription", {
      p_endpoint: json.endpoint,
      p_p256dh: json.keys?.p256dh,
      p_auth: json.keys?.auth,
      p_user_agent: navigator.userAgent,
    });
    return !error;
  } catch {
    return false;
  }
}

// Called from a button tap: asks for permission, then registers the device. Resolves to the new getPushStatus() value.
export async function enablePushNotifications(supabase) {
  const perm = await requestNotificationPermission();
  if (perm === "granted") await subscribeToPush(supabase);
  return getPushStatus();
}

// Sends the signed-in user a real notification through the whole pipeline (row -> trigger -> edge function -> push service -> device).
export function sendTestNotification(supabase) {
  return supabase.rpc("push_send_test");
}
