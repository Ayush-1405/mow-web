// deno test shopify-sync/shopify_test.ts -- the Shopify client against a fake Shopify (no network, no real store)
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createShopify, fetchOrder, fetchProductsPage, normaliseOrder, Q, registerWebhooks, safeEqual, ShopifyError, verifyWebhook, withFragments,
} from "./shopify.ts";

const CREDS = { shop_domain: "zz-test.myshopify.com", api_version: "2026-10", auth_mode: "ACCESS_TOKEN" as const, access_token: "shpat_zz" };
const noSleep = async (_ms: number) => {};
type Call = { url: string; body: any; headers: Record<string, string> };
function fakeFetch(replies: ((c: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const c: Call = { url: String(url), body: init?.body && typeof init.body === "string" ? JSON.parse(init.body) : init?.body, headers: Object.fromEntries(new Headers(init?.headers).entries()) };
    calls.push(c);
    const r = replies.shift();
    if (!r) throw new Error("unexpected call");
    return r(c);
  }) as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

Deno.test("sends the token only in the Shopify header, to the configured API version", async () => {
  const { f, calls } = fakeFetch([() => json({ data: { shop: { name: "ZZ" } } })]);
  const s = createShopify(CREDS, f, noSleep);
  assertEquals((await s.gql(Q.shop)).shop.name, "ZZ");
  assertEquals(calls[0].url, "https://zz-test.myshopify.com/admin/api/2026-10/graphql.json");
  assertEquals(calls[0].headers["x-shopify-access-token"], "shpat_zz");
});

Deno.test("refuses a store address that is not *.myshopify.com", () => {
  let err = null;
  try { createShopify({ ...CREDS, shop_domain: "evil.example.com" }, fetch, noSleep); } catch (e) { err = e; }
  assert(err instanceof ShopifyError);
});

Deno.test("retries 429 / 5xx / network errors, then succeeds", async () => {
  const { f, calls } = fakeFetch([
    () => json({}, 429, { "Retry-After": "1" }),
    () => json({}, 503),
    () => { throw new TypeError("connection reset"); },
    () => json({ data: { ok: 1 } }),
  ]);
  assertEquals((await createShopify(CREDS, f, noSleep).gql("query { ok }")).ok, 1);
  assertEquals(calls.length, 4);
});

Deno.test("waits and retries when Shopify reports THROTTLED", async () => {
  const waits: number[] = [];
  const { f } = fakeFetch([
    () => json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { requestedQueryCost: 500, throttleStatus: { currentlyAvailable: 100, restoreRate: 100, maximumAvailable: 1000 } } } }),
    () => json({ data: { ok: 1 } }),
  ]);
  assertEquals((await createShopify(CREDS, f, async (ms) => { waits.push(ms); }).gql("query { ok }")).ok, 1);
  assert(waits.some((w) => w >= 4000), "waited for the bucket to refill (400 points at 100/s)");
});

Deno.test("a refused token is a clear, non-retried error", async () => {
  const { f, calls } = fakeFetch([() => json({ errors: "Invalid API key" }, 401)]);
  await assertRejects(() => createShopify(CREDS, f, noSleep).gql("query { ok }"), ShopifyError, "refused");
  assertEquals(calls.length, 1);
});

Deno.test("client credentials: exchanges ID + secret for a token, renews it once on 401", async () => {
  const { f, calls } = fakeFetch([
    () => json({ access_token: "tok1", expires_in: 86399 }),
    () => json({}, 401),
    () => json({ access_token: "tok2", expires_in: 86399 }),
    () => json({ data: { ok: 1 } }),
  ]);
  const s = createShopify({ ...CREDS, auth_mode: "CLIENT_CREDENTIALS", access_token: null, client_id: "cid", client_secret: "csec" }, f, noSleep);
  assertEquals((await s.gql("query { ok }")).ok, 1);
  assertEquals(calls[0].url, "https://zz-test.myshopify.com/admin/oauth/access_token");
  assertEquals(String(calls[0].body), "grant_type=client_credentials&client_id=cid&client_secret=csec");
  assertEquals(calls[3].headers["x-shopify-access-token"], "tok2");
});

Deno.test("errors only on the customer field (no protected-data access) do not block an order", async () => {
  const order = { id: "gid://shopify/Order/1", name: "#1001", createdAt: "2026-11-28T05:00:00Z", updatedAt: "2026-11-28T05:00:00Z", customer: null,
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [] }, fulfillments: [], refunds: [] };
  const { f } = fakeFetch([() => json({ data: { order }, errors: [{ message: "Access denied for customer field", path: ["order", "customer"] }] })]);
  const o = await fetchOrder(createShopify(CREDS, f, noSleep), "gid://shopify/Order/1");
  assertEquals(o?.name, "#1001");
  assertEquals(o?.customer_name, null);
});

Deno.test("products are paged with the cursor; a product with more than 50 variants fetches the rest", async () => {
  const v = (i: number) => ({ id: `gid://shopify/ProductVariant/${i}`, title: `V${i}`, sku: `SKU-${i}`, price: "10.00", position: i, inventoryItem: { id: `gid://shopify/InventoryItem/${i}`, tracked: true } });
  const { f, calls } = fakeFetch([
    () => json({ data: { products: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [{ id: "gid://shopify/Product/1", title: "Sofa", status: "ACTIVE",
      media: { nodes: [{ preview: { image: { url: "https://cdn/1.jpg" } } }] }, variants: { pageInfo: { hasNextPage: true, endCursor: "v50" }, nodes: [v(1)] } }] } } }),
    () => json({ data: { product: { variants: { pageInfo: { hasNextPage: false }, nodes: [v(2)] } } } }),
  ]);
  const page = await fetchProductsPage(createShopify(CREDS, f, noSleep), null, null);
  assertEquals(page.next, "c1");
  assertEquals(page.products[0].variants.map((x) => x.sku), ["SKU-1", "SKU-2"]);
  assertEquals(page.products[0].image_url, "https://cdn/1.jpg");
  assertEquals(page.products[0].variants_complete, true);
  assertEquals(calls[1].body.variables, { id: "gid://shopify/Product/1", after: "v50" });
});

Deno.test("each query carries exactly the fragments it uses (GraphQL rejects unused ones)", () => {
  for (const [name, q] of Object.entries(Q)) {
    const full = withFragments(q);
    for (const frag of ["P", "V", "L"]) {
      const defined = full.includes(`fragment ${frag} on`);
      const used = full.includes(`...${frag}`);
      assertEquals(defined, used, `${name}: fragment ${frag} defined=${defined} used=${used}`);
    }
  }
});

Deno.test("orders: payment and fulfilment kept separate; tracking, fulfilled lines and restocked refunds normalised", () => {
  const o = normaliseOrder({
    id: "gid://shopify/Order/9", name: "#1009", displayFinancialStatus: "PAID", displayFulfillmentStatus: "PARTIALLY_FULFILLED",
    totalPriceSet: { shopMoney: { amount: "2500.00", currencyCode: "INR" } },
    lineItems: { nodes: [{ id: "L1", quantity: 3, currentQuantity: 3, unfulfilledQuantity: 2, variant: { id: "V1", inventoryItem: { id: "I1" } } }] },
    fulfillments: [{ id: "F1", status: "SUCCESS", displayStatus: "IN_TRANSIT", trackingInfo: [{ company: "Delhivery", number: "AWB1", url: "https://t/1" }],
      fulfillmentLineItems: { nodes: [{ quantity: 1, lineItem: { id: "L1" } }] } }],
    refunds: [{ id: "R1", refundLineItems: { nodes: [{ quantity: 1, restockType: "RETURN", restocked: true, location: { id: "LOC1" }, lineItem: { id: "L1", variant: { inventoryItem: { id: "I1" } } } }] } }],
  });
  assertEquals([o.financial_status, o.fulfillment_status, o.total, o.currency], ["PAID", "PARTIALLY_FULFILLED", 2500, "INR"]);
  assertEquals(o.fulfillments[0].tracking[0].number, "AWB1");
  assertEquals(o.fulfillments[0].lines, [{ line_id: "L1", quantity: 1 }]);
  assertEquals(o.refunds[0].lines[0], { line_id: "L1", quantity: 1, restock_type: "RETURN", restocked: true, location_id: "LOC1", inventory_item_id: "I1" });
  assertEquals(o.lines[0].inventory_item_id, "I1");
});

Deno.test("webhook signature: valid accepted, tampered body / wrong secret / missing header refused", async () => {
  const body = new TextEncoder().encode(JSON.stringify({ id: 1, name: "#1001" }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("app-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const good = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, body))));
  assert(await verifyWebhook(body, good, "app-secret"));
  assert(!(await verifyWebhook(new TextEncoder().encode('{"id":2}'), good, "app-secret")));
  assert(!(await verifyWebhook(body, good, "other-secret")));
  assert(!(await verifyWebhook(body, null, "app-secret")));
  assert(!safeEqual("abc", "abd") && safeEqual("abc", "abc"));
});

Deno.test("webhooks: existing subscriptions are not duplicated; falls back to callbackUrl on older API versions", async () => {
  const url = "https://x.supabase.co/functions/v1/shopify-sync";
  const { f, calls } = fakeFetch([
    () => json({ errors: [{ message: "Field 'uri' doesn't exist on type 'WebhookSubscription'" }] }),
    () => json({ data: { webhookSubscriptions: { nodes: [{ id: "W1", topic: "ORDERS_CREATE", endpoint: { callbackUrl: url } }] } } }),
    ...Array.from({ length: 13 }, () => () => json({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: "Wn" }, userErrors: [] } } })),
  ]);
  const r = await registerWebhooks(createShopify(CREDS, f, noSleep), url);
  assertEquals([r.total, r.created, r.problems.length], [14, 13, 0]);
  assert(!calls.slice(2).some((c) => c.body.variables.topic === "ORDERS_CREATE"), "ORDERS_CREATE was already subscribed");
  assertEquals(calls[2].body.variables.sub, { callbackUrl: url, format: "JSON" });
});
