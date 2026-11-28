// Mood of Wood — shopify-sync: the E-commerce department's only link to Shopify (READ ONLY).
//
// Three callers (verify_jwt = false because Shopify cannot send a Supabase token; each caller is checked here instead):
//   1. Shopify webhooks   — X-Shopify-Hmac-Sha256 must match HMAC(app client secret, raw body) and the shop must be ours.
//                           Duplicate deliveries are skipped (ecom_webhook_receive); the reply is immediate and the work runs in
//                           the background, re-reading the object from Shopify so the stored copy is always Shopify's latest.
//   2. The 30-minute job  — x-mow-cron must equal the Vault cron secret: incremental sync + retry of failed webhooks.
//   3. Staff (signed in)  — { action: "sync" } for anyone who can open E-commerce; { action: "test" } (connection check +
//                           webhook registration) for Management. Identity comes from the verified JWT only.
// Credentials are read from Vault through ecom_get_credentials() (service role) and never leave this function.
// Stock: this function only copies Shopify's quantities into the database; it never changes stock anywhere.

import { buildCorsHeaders, handlePreflight } from "../_shared/cors.ts";
import { adminClient, extractBearerToken, userScopedClient, verifyCaller } from "../_shared/clients.ts";
import {
  createShopify, fetchLevel, fetchLevelsPage, fetchLocations, fetchOrder, fetchOrderIdsPage, fetchProduct, fetchProductsPage, gid,
  Q, registerWebhooks, REQUIRED_SCOPES, safeEqual, type Creds, type Shopify, ShopifyError, verifyWebhook,
} from "./shopify.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
const background = (p: Promise<unknown>) => {
  const guarded = p.catch((e) => console.error("[shopify-sync] background task failed:", (e as Error).message));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(guarded); else return guarded;
};
const TIME_BUDGET_MS = 110_000;   // the platform stops a function at ~150 s; leave room to record the result

type Db = ReturnType<typeof adminClient>;
type Json = Record<string, any>;

function reply(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...buildCorsHeaders(origin) } });
}
async function rpc<T = any>(db: Db, fn: string, args: Json = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}
async function credentials(db: Db): Promise<Json> {
  return await rpc(db, "ecom_get_credentials");
}
function client(c: Json): Shopify {
  return createShopify(c as Creds);
}

// ------------------------------------------------------------------------------------------------------------------ sync
type Resume = { stage: "locations" | "products" | "inventory" | "orders"; cursor?: string | null; loc?: number; chain_started_at?: string; since?: string | null };

export async function runSync(db: Db, s: Shopify, opts: { kind: "FULL" | "INCREMENTAL"; trigger: string; user: string | null; creds: Json }) {
  const started = await rpc(db, "ecom_sync_start", { p_kind: opts.kind, p_trigger: opts.trigger, p_user: opts.user });
  if (started.busy) return { busy: true };
  const runId = started.run_id as string;
  const t0 = Date.now();
  const runStartedAt = new Date().toISOString();
  const counts: Json = { locations: 0, products: 0, levels: 0, movements: 0, orders: 0, webhook_retries: 0 };
  const firstSync = !opts.creds.baseline_at;
  const full = started.kind === "FULL" || firstSync || !opts.creds.last_success_sync_at;
  const invSource = firstSync ? "INITIAL_SYNC" : opts.trigger === "SCHEDULE" ? "SCHEDULED_SYNC" : "MANUAL_SYNC";
  // incremental: everything Shopify changed since the last successful sync started, with a 10-minute overlap
  const since = full ? null : new Date(new Date(opts.creds.last_success_sync_at).getTime() - 10 * 60_000).toISOString();
  const state: Resume = started.resume ?? { stage: "locations", chain_started_at: runStartedAt, since };
  const q = state.since ? `updated_at:>='${state.since}'` : null;
  const outOfTime = () => Date.now() - t0 > TIME_BUDGET_MS;
  try {
    if (state.stage === "locations") {
      counts.locations = await rpc(db, "ecom_ingest_locations", { p_locations: await fetchLocations(s) });
      state.stage = "products"; state.cursor = null;
    }
    if (state.stage === "products") {
      do {
        const page = await fetchProductsPage(s, state.cursor ?? null, q);
        if (page.products.length) counts.products += await rpc(db, "ecom_ingest_products", { p_products: page.products });
        state.cursor = page.next;
        if (state.cursor && outOfTime()) return await partial();
      } while (state.cursor);
      state.stage = "inventory"; state.loc = 0; state.cursor = null;
    }
    if (state.stage === "inventory") {
      // inventory is always read in full (a quantity change does not change a product's updated_at); unchanged values write nothing
      const { data: locs } = await db.from("ecom_locations").select("shopify_id").eq("is_active", true).order("shopify_id");
      const ids = (locs || []).map((l: Json) => l.shopify_id as string);
      for (let i = state.loc ?? 0; i < ids.length; i++) {
        state.loc = i;
        do {
          const page = await fetchLevelsPage(s, ids[i], state.cursor ?? null);
          if (page.levels.length) {
            const r = await rpc(db, "ecom_ingest_inventory", { p_levels: page.levels, p_source: invSource });
            counts.levels += r.levels; counts.movements += r.movements;
          }
          state.cursor = page.next;
          if (outOfTime()) { if (!state.cursor) { state.loc = i + 1; } return await partial(); }
        } while (state.cursor);
      }
      state.stage = "orders"; state.cursor = null;
    }
    if (state.stage === "orders") {
      do {
        const page = await fetchOrderIdsPage(s, state.cursor ?? null, q);
        for (const id of page.ids) {
          const o = await fetchOrder(s, id);
          if (o) { await rpc(db, "ecom_ingest_orders", { p_orders: [o] }); counts.orders++; }
        }
        state.cursor = page.next;
        if (state.cursor && outOfTime()) return await partial();
      } while (state.cursor);
    }
    if (opts.trigger === "SCHEDULE") counts.webhook_retries = await retryFailedWebhooks(db, s, () => outOfTime());
    // the next incremental sync starts from when this whole (possibly resumed) sync began
    await rpc(db, "ecom_sync_finish", { p_run: runId, p_status: "OK", p_counts: counts, p_error: null, p_resume: null,
                                       p_since: state.chain_started_at ?? runStartedAt });
    return { ok: true, run_id: runId, counts };
  } catch (e) {
    const msg = (e as Error).message;
    await rpc(db, "ecom_sync_finish", { p_run: runId, p_status: "FAILED", p_counts: counts, p_error: msg, p_resume: null, p_since: null });
    return { ok: false, run_id: runId, error: msg };
  }
  async function partial() {
    await rpc(db, "ecom_sync_finish", { p_run: runId, p_status: "PARTIAL", p_counts: counts,
      p_error: "Stopped to stay within the time limit; the next sync continues from here", p_resume: state, p_since: null });
    return { ok: true, partial: true, run_id: runId, counts };
  }
}

// ------------------------------------------------------------------------------------------------------------------ webhooks
async function processWebhook(db: Db, s: Shopify, topic: string, p: Json) {
  switch (topic) {
    case "orders/create": case "orders/updated": case "orders/cancelled": case "orders/fulfilled": case "orders/paid":
    case "refunds/create": case "fulfillments/create": case "fulfillments/update": {
      const orderId = topic.startsWith("orders/") ? (p.admin_graphql_api_id || gid("Order", p.id)) : gid("Order", p.order_id);
      const o = await fetchOrder(s, orderId);
      if (o) await rpc(db, "ecom_ingest_orders", { p_orders: [o] });
      return;
    }
    case "products/create": case "products/update": {
      const prod = await fetchProduct(s, p.admin_graphql_api_id || gid("Product", p.id));
      if (prod) await rpc(db, "ecom_ingest_products", { p_products: [prod] });
      return;
    }
    case "products/delete":
      await rpc(db, "ecom_mark_product_deleted", { p_product_id: gid("Product", p.id) });
      return;
    case "inventory_levels/update": case "inventory_levels/connect": {
      const lvl = await fetchLevel(s, gid("InventoryItem", p.inventory_item_id), gid("Location", p.location_id));
      if (lvl) await rpc(db, "ecom_ingest_inventory", { p_levels: [lvl], p_source: "WEBHOOK" });
      return;
    }
    case "inventory_levels/disconnect":
      await rpc(db, "ecom_remove_inventory_level", { p_item: gid("InventoryItem", p.inventory_item_id), p_location: gid("Location", p.location_id), p_source: "WEBHOOK" });
      return;
    case "locations/create": case "locations/update":
      await rpc(db, "ecom_ingest_locations", { p_locations: await fetchLocations(s) });
      return;
    default:
      return;
  }
}

// What each stored webhook needs to be re-read (failed ones are retried by the 30-minute job).
function payloadFromStored(topic: string, objectId: string | null): Json {
  const tail = (objectId || "").split("/").pop() || objectId;
  if (topic.startsWith("orders/")) return { admin_graphql_api_id: objectId };
  if (topic === "refunds/create" || topic.startsWith("fulfillments/")) return { order_id: tail };
  if (topic.startsWith("products/")) return { id: tail, admin_graphql_api_id: objectId };
  if (topic.startsWith("inventory_levels/")) { const [item, loc] = String(objectId || "").split("|"); return { inventory_item_id: item, location_id: loc }; }
  return {};
}
function objectIdFor(topic: string, p: Json): string | null {
  if (topic.startsWith("orders/")) return p.admin_graphql_api_id || (p.id ? gid("Order", p.id) : null);
  if (topic === "refunds/create" || topic.startsWith("fulfillments/")) return p.order_id ? gid("Order", p.order_id) : null;
  if (topic.startsWith("products/")) return p.admin_graphql_api_id || (p.id ? gid("Product", p.id) : null);
  if (topic.startsWith("inventory_levels/")) return `${p.inventory_item_id}|${p.location_id}`;
  if (topic.startsWith("locations/")) return p.admin_graphql_api_id || null;
  return null;
}

async function retryFailedWebhooks(db: Db, s: Shopify, outOfTime: () => boolean) {
  const rows: Json[] = await rpc(db, "ecom_webhooks_to_retry");
  let n = 0;
  for (const r of rows || []) {
    if (outOfTime()) break;
    if (!(await rpc(db, "ecom_webhook_receive", { p_key: r.event_key, p_topic: r.topic, p_object: r.object_id, p_triggered: r.triggered_at }))) continue;
    try { await processWebhook(db, s, r.topic, payloadFromStored(r.topic, r.object_id)); await rpc(db, "ecom_webhook_done", { p_key: r.event_key, p_status: "PROCESSED", p_error: null }); n++; }
    catch (e) { await rpc(db, "ecom_webhook_done", { p_key: r.event_key, p_status: "FAILED", p_error: (e as Error).message }); }
  }
  return n;
}

async function handleWebhook(req: Request): Promise<Response> {
  const raw = new Uint8Array(await req.arrayBuffer()) as Uint8Array<ArrayBuffer>;
  const db = adminClient();
  const c = await credentials(db);
  const shop = (req.headers.get("X-Shopify-Shop-Domain") || "").toLowerCase();
  if (!c?.shop_domain || shop !== c.shop_domain || !(await verifyWebhook(raw, req.headers.get("X-Shopify-Hmac-Sha256"), c.client_secret))) {
    return new Response("unauthorized", { status: 401 });
  }
  const topic = (req.headers.get("X-Shopify-Topic") || "").toLowerCase();
  const key = req.headers.get("X-Shopify-Event-Id") || req.headers.get("X-Shopify-Webhook-Id");
  if (!topic || !key) return new Response("missing headers", { status: 400 });
  let payload: Json = {};
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response("bad json", { status: 400 }); }
  const triggered = req.headers.get("X-Shopify-Triggered-At");
  const isNew = await rpc(db, "ecom_webhook_receive", { p_key: key, p_topic: topic, p_object: objectIdFor(topic, payload), p_triggered: triggered || null });
  if (!isNew) return new Response("duplicate", { status: 200 });
  // answer Shopify within its 5-second limit; the work continues in the background (failures are retried every 30 minutes)
  background((async () => {
    try { await processWebhook(db, client(c), topic, payload); await rpc(db, "ecom_webhook_done", { p_key: key, p_status: "PROCESSED", p_error: null }); }
    catch (e) { await rpc(db, "ecom_webhook_done", { p_key: key, p_status: "FAILED", p_error: (e as Error).message }); }
  })());
  return new Response("ok", { status: 200 });
}

// ------------------------------------------------------------------------------------------------------------------ test
async function testConnection(db: Db, c: Json) {
  try {
    const s = client(c);
    const d = await s.gql(Q.shop);
    const scopes: string[] = (d.currentAppInstallation?.accessScopes || []).map((x: Json) => x.handle);
    const missing = REQUIRED_SCOPES.filter((x) => !scopes.includes(x));
    let webhooks = { total: 0, created: 0, problems: [] as string[] };
    if (!missing.length) webhooks = await registerWebhooks(s, c.functions_url);
    await rpc(db, "ecom_record_test", { p_ok: !missing.length, p_error: missing.length ? `Missing Shopify permissions: ${missing.join(", ")}` : null,
      p_shop: { name: d.shop?.name, timezone: d.shop?.ianaTimezone, currency: d.shop?.currencyCode, scopes, webhooks: webhooks.total } });
    return { ok: !missing.length, shop: d.shop?.name, missing_scopes: missing, webhooks };
  } catch (e) {
    const msg = e instanceof ShopifyError ? e.message : `Connection failed: ${(e as Error).message}`;
    await rpc(db, "ecom_record_test", { p_ok: false, p_shop: {}, p_error: msg });
    return { ok: false, error: msg };
  }
}

// ------------------------------------------------------------------------------------------------------------------ entry
Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  const origin = req.headers.get("origin");
  try {
    if (req.headers.get("X-Shopify-Hmac-Sha256")) return await handleWebhook(req);

    if (req.headers.get("x-mow-cron")) {
      const db = adminClient();
      const c = await credentials(db);
      if (!c?.cron_secret || !safeEqual(c.cron_secret, req.headers.get("x-mow-cron") || "")) return new Response("unauthorized", { status: 401 });
      background(runSync(db, client(c), { kind: "INCREMENTAL", trigger: "SCHEDULE", user: null, creds: c }));
      return new Response("started", { status: 202 });
    }

    // staff
    const token = extractBearerToken(req);
    const user = token ? await verifyCaller(token) : null;
    if (!user) return reply({ error: "Please sign in again" }, 401, origin);
    const asUser = userScopedClient(token!);
    const { data: canAccess } = await asUser.rpc("ecom_can_access");
    if (!canAccess) return reply({ error: "You do not have access to E-commerce" }, 403, origin);
    const body = await req.json().catch(() => ({}));
    const db = adminClient();
    const c = await credentials(db);
    if (!c?.shop_domain || c.status === "NOT_CONFIGURED") return reply({ error: "Shopify is not connected yet. Management can add it in Shopify Connection Settings." }, 409, origin);

    if (body.action === "test") {
      const { data: canConfigure } = await asUser.rpc("ecom_can_configure");
      if (!canConfigure) return reply({ error: "Only Management can test the Shopify connection" }, 403, origin);
      const result = await testConnection(db, c);
      if (result.ok && !c.baseline_at) background(runSync(db, client(c), { kind: "FULL", trigger: "INITIAL", user: user.id, creds: c }));
      return reply({ ...result, initial_sync_started: result.ok && !c.baseline_at }, 200, origin);
    }
    if (body.action === "sync") {
      if (c.status !== "CONNECTED" && c.status !== "ERROR") return reply({ error: "Test the connection first" }, 409, origin);
      const kind = body.full ? "FULL" : "INCREMENTAL";
      background(runSync(db, client(c), { kind, trigger: c.baseline_at ? "MANUAL" : "INITIAL", user: user.id, creds: c }));
      return reply({ started: true, kind }, 202, origin);
    }
    return reply({ error: "Unknown action" }, 400, origin);
  } catch (e) {
    console.error("[shopify-sync] error:", (e as Error).message);
    return reply({ error: "Something went wrong talking to Shopify. Please try again." }, 500, origin);
  }
});
