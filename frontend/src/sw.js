// Custom service worker (injectManifest strategy — see vite.config.js).
// generateSW's auto-built worker couldn't run a `notificationclick`
// handler, so tapping a phone/tablet tray notification (shown via
// registration.showNotification() in lib/pushNotifications.js) just
// dismissed it instead of opening/focusing the app. Own service worker
// source is the only way to add that listener.
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";

self.skipWaiting();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// This is a live ERP — task/project data must always come from the
// network, never a stale cache, so every Supabase call bypasses the SW's
// cache entirely (same intent as the generateSW config this replaced).
registerRoute(
  ({ url }) => ["/rest", "/auth", "/storage", "/functions"].some((p) => url.pathname.startsWith(p)),
  new NetworkOnly(),
);

// Same "app shell opens even with no signal" behavior generateSW's
// navigateFallback gave us — every other SPA route falls back to the
// precached index.html.
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html")));

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// The actual "notification arrives even with the app fully closed" piece:
// the browser's push service wakes this service worker with the payload
// send-push (the Edge Function, see mvp_pilot_web_push_v2_2l.sql) sent,
// and only from inside the SW can a notification be shown with no page
// open at all — page-context code (lib/pushNotifications.js) never runs
// in that situation.
self.addEventListener("push", (event) => {
  let data = { title: "Mood of Wood", body: "You have a new notification." };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Non-JSON payload (shouldn't happen — send-push always sends JSON) — fall back to the generic title/body above rather than dropping
    // the notification entirely.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // The notification id is the tag: if the open app already showed this same notification from its realtime popup, this REPLACES it
      // instead of stacking a duplicate.
      tag: data.id || undefined,
      vibrate: [200, 100, 200],
      data: { url: data.url || "/" },
    }),
  );
});

// Tapping a notification: if the app is already open, hand it the target route so it navigates INSTANTLY (no reload) and focus it;
// otherwise open the app straight at that route.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = allClients.find((c) => c.visibilityState === "visible") || allClients[0];
      if (client) {
        client.postMessage({ type: "mow-navigate", url: targetUrl });
        if ("focus" in client) await client.focus();
        return;
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});

// The browser's push service occasionally rotates a device's subscription. Re-subscribe right away and tell any open app to re-save it; if
// no app is open, the next time it is opened (or brought to the foreground) subscribeToPush() re-saves it.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const options = event.oldSubscription?.options;
        if (options) await self.registration.pushManager.subscribe(options);
      } catch {
        // permission revoked, or the key changed — the app's own re-subscribe path will sort it out
      }
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      allClients.forEach((c) => c.postMessage({ type: "mow-push-resync" }));
    })(),
  );
});
