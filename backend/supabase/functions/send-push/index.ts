// send-push — delivers a real Web Push notification (shows in the phone/tablet OS notification tray even when the app is fully closed) to
// every device the recipient has subscribed from.
//
// Called ONLY from the notifications_push_trigger Postgres trigger (see migration mvp_pilot_web_push_v2_2l.sql / v2_91) via pg_net,
// fire-and-forget — never from the browser directly. verify_jwt is disabled for exactly that reason: the caller is Postgres, not a signed-in
// user, so there is no user JWT to verify. Authentication instead checks a shared secret (x-push-secret header) against
// app_secrets.PUSH_TRIGGER_SECRET, the standard pattern for a DB-trigger-invoked Edge Function.
//
// Speed / reliability (v2_91):
//  - urgency "high": without it Android (Doze) and iOS treat the push as low priority and may hold it back for minutes -- the reported "slow
//    notifications when the app is closed". TTL 24h so a phone that is briefly offline still gets it.
//  - the secret + VAPID keys are cached per warm instance (they almost never change), so a push costs 2 DB reads instead of 4.
//  - every push failure other than an expired subscription is now logged (before, they were swallowed silently), and the notification row's
//    delivery_status is set to 'failed' when no device could be reached.
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Config = { secret: string; subject: string; publicKey: string; privateKey: string; at: number };
let cache: Config | null = null;
const CACHE_MS = 5 * 60 * 1000;

async function loadConfig(force = false): Promise<Config | null> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const { data } = await supabase
    .from("app_secrets")
    .select("key, value")
    .in("key", ["PUSH_TRIGGER_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]);
  const m = Object.fromEntries((data || []).map((r: { key: string; value: string }) => [r.key, r.value]));
  if (!m.PUSH_TRIGGER_SECRET || !m.VAPID_PUBLIC_KEY || !m.VAPID_PRIVATE_KEY) return null;
  cache = { secret: m.PUSH_TRIGGER_SECRET, subject: m.VAPID_SUBJECT, publicKey: m.VAPID_PUBLIC_KEY, privateKey: m.VAPID_PRIVATE_KEY, at: Date.now() };
  webpush.setVapidDetails(cache.subject, cache.publicKey, cache.privateKey);
  return cache;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const provided = req.headers.get("x-push-secret");
  let cfg = await loadConfig();
  if (!provided || !cfg || provided !== cfg.secret) {
    cfg = await loadConfig(true); // the secret may have been rotated since this instance cached it
    if (!provided || !cfg || provided !== cfg.secret) return new Response("Unauthorized", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const notificationId = (body.id as string | null) || null;
  const recipientId = body.recipient_id as string | null;
  const titleEn = (body.title_en as string) || "New notification";
  const titleGu = (body.title_gu as string) || titleEn;
  if (!recipientId) return json({ skipped: "no recipient_id" });

  const [{ data: subs }, { data: profile }] = await Promise.all([
    supabase.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", recipientId),
    supabase.from("user_profiles").select("language_pref").eq("id", recipientId).maybeSingle(),
  ]);
  if (!subs || subs.length === 0) return json({ sent: 0, reason: "no subscriptions" });

  const payload = JSON.stringify({
    title: "Mood of Wood",
    body: profile?.language_pref === "gu" ? titleGu : titleEn,
    url: (body.url as string) || "/",
    id: notificationId,
    entity_type: body.entity_type ?? null,
    entity_id: body.entity_id ?? null,
  });

  let sent = 0;
  const stale: string[] = [];
  await Promise.all(
    (subs as { id: string; endpoint: string; p256dh: string; auth: string }[]).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400, urgency: "high" });
        sent++;
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          stale.push(s.id);
        } else {
          console.error("send-push: delivery failed", { status: statusCode, host: new URL(s.endpoint).host, message: (err as Error)?.message });
        }
      }
    }),
  );

  if (stale.length > 0) await supabase.from("push_subscriptions").delete().in("id", stale);
  // Only failures are written back: an UPDATE fires a Realtime event to the recipient's open apps, so doing it for every successful push
  // would add traffic for no benefit.
  if (notificationId && sent === 0) {
    await supabase.from("notifications").update({ delivery_status: "failed" }).eq("id", notificationId);
  }
  return json({ sent, removed: stale.length });
});
