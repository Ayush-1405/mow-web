// send-push — delivers a real Web Push notification (shows in the phone/
// tablet OS notification tray even when the app is fully closed) to every
// device the recipient has subscribed from.
//
// Called ONLY from the notifications_push_trigger Postgres trigger (see
// migration mvp_pilot_web_push_v2_2l.sql) via pg_net, fire-and-forget —
// never from the browser directly. verify_jwt is disabled for exactly
// that reason: the caller is Postgres, not a signed-in user, so there is
// no user JWT to verify. Authentication instead checks a shared secret
// (x-push-secret header) against app_secrets.PUSH_TRIGGER_SECRET, the
// standard pattern for a DB-trigger-invoked Edge Function.
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const providedSecret = req.headers.get("x-push-secret");
  const { data: secretRow } = await supabase
    .from("app_secrets")
    .select("value")
    .eq("key", "PUSH_TRIGGER_SECRET")
    .maybeSingle();
  if (!providedSecret || !secretRow || providedSecret !== secretRow.value) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const recipientId = body.recipient_id as string | null;
  const titleEn = (body.title_en as string) || "New notification";
  const titleGu = (body.title_gu as string) || titleEn;
  const entityType = body.entity_type as string | null;
  const entityId = body.entity_id as string | null;

  if (!recipientId) {
    return new Response(JSON.stringify({ skipped: "no recipient_id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const [{ data: vapidRows }, { data: subs }, { data: profile }] = await Promise.all([
    supabase.from("app_secrets").select("key, value").in("key", ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]),
    supabase.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", recipientId),
    supabase.from("user_profiles").select("language_pref").eq("id", recipientId).maybeSingle(),
  ]);

  if (!subs || subs.length === 0) {
    return new Response(JSON.stringify({ sent: 0, reason: "no subscriptions" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const vapid = Object.fromEntries((vapidRows || []).map((r: { key: string; value: string }) => [r.key, r.value]));
  webpush.setVapidDetails(vapid.VAPID_SUBJECT, vapid.VAPID_PUBLIC_KEY, vapid.VAPID_PRIVATE_KEY);

  const bodyText = profile?.language_pref === "gu" ? titleGu : titleEn;
  const payload = JSON.stringify({
    title: "Mood of Wood",
    body: bodyText,
    url: "/",
    entity_type: entityType,
    entity_id: entityId,
  });

  let sent = 0;
  const stale: string[] = [];
  await Promise.all(
    (subs as { id: string; endpoint: string; p256dh: string; auth: string }[]).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
        sent++;
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          stale.push(s.id);
        }
      }
    }),
  );

  if (stale.length > 0) {
    await supabase.from("push_subscriptions").delete().in("id", stale);
  }

  return new Response(JSON.stringify({ sent, removed: stale.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
