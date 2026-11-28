// Mood of Wood — Shopify Admin GraphQL client for the E-commerce department (READ ONLY).
//
// - Two ways to authenticate, both official: a store-owned custom app's Admin API access token (X-Shopify-Access-Token), or a
//   Dev Dashboard app's client ID + secret exchanged for a short-lived token (client credentials grant).
// - Every request: retries on network errors / 429 / 5xx with backoff, honours GraphQL cost throttling (THROTTLED errors and the
//   throttleStatus in each reply), never logs a token.
// - Queries only READ. Nothing here creates, edits or publishes anything in Shopify except webhook subscriptions (the app's own
//   delivery settings).
// - normalise*() turns Shopify replies into the plain JSON the ecom_ingest_* database functions take.

export type Creds = {
  shop_domain: string; api_version: string; auth_mode: "ACCESS_TOKEN" | "CLIENT_CREDENTIALS";
  client_id?: string | null; client_secret?: string | null; access_token?: string | null;
};
type Fetch = typeof fetch;
type Json = Record<string, any>;

export class ShopifyError extends Error {
  constructor(message: string, public retryable = false, public status?: number) { super(message); }
}

export const REQUIRED_SCOPES = ["read_products", "read_inventory", "read_locations", "read_orders"];
export const WEBHOOK_TOPICS = [
  "ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "REFUNDS_CREATE", "FULFILLMENTS_CREATE", "FULFILLMENTS_UPDATE",
  "PRODUCTS_CREATE", "PRODUCTS_UPDATE", "PRODUCTS_DELETE", "INVENTORY_LEVELS_UPDATE", "INVENTORY_LEVELS_CONNECT",
  "INVENTORY_LEVELS_DISCONNECT", "LOCATIONS_CREATE", "LOCATIONS_UPDATE",
];

export const gid = (type: string, id: string | number) => String(id).startsWith("gid://") ? String(id) : `gid://shopify/${type}/${id}`;
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export function createShopify(creds: Creds, fetchFn: Fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(creds.shop_domain || "")) throw new ShopifyError("The store address is not set up");
  const endpoint = `https://${creds.shop_domain}/admin/api/${creds.api_version}/graphql.json`;
  let token: string | null = creds.auth_mode === "ACCESS_TOKEN" ? (creds.access_token || null) : null;
  let tokenExpires = 0;

  async function getToken(): Promise<string> {
    if (creds.auth_mode === "ACCESS_TOKEN") {
      if (!token) throw new ShopifyError("No Admin API access token is saved");
      return token;
    }
    if (token && Date.now() < tokenExpires - 60_000) return token;
    if (!creds.client_id || !creds.client_secret) throw new ShopifyError("The app's client ID and secret are not saved");
    const res = await fetchFn(`https://${creds.shop_domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: creds.client_id, client_secret: creds.client_secret }),
    });
    if (!res.ok) {
      throw new ShopifyError(res.status === 400 || res.status === 401 || res.status === 403
        ? `Shopify refused the app's client ID / secret (${res.status}). Check the app is installed on this store.`
        : `Shopify did not issue an access token (${res.status})`, res.status >= 500 || res.status === 429, res.status);
    }
    const j = await res.json();
    if (!j?.access_token) throw new ShopifyError("Shopify did not return an access token");
    token = j.access_token;
    tokenExpires = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    return token!;
  }

  // One GraphQL call. ignoreErrorPaths: field names whose errors are tolerated when data came back (e.g. "customer" when the app
  // has no protected-customer-data access).
  async function gql(query: string, variables: Json = {}, ignoreErrorPaths: string[] = []): Promise<Json> {
    let lastErr: ShopifyError | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await sleep(Math.min(30_000, 500 * 2 ** attempt));
      let res: Response;
      try {
        res = await fetchFn(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": await getToken() },
          body: JSON.stringify({ query, variables }),
        });
      } catch (e) {
        if (e instanceof ShopifyError) throw e;
        lastErr = new ShopifyError(`Could not reach Shopify (${(e as Error).message})`, true);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get("Retry-After"));
        if (wait > 0) await sleep(Math.min(wait, 30) * 1000);
        lastErr = new ShopifyError(`Shopify is busy (${res.status})`, true, res.status);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        if (creds.auth_mode === "CLIENT_CREDENTIALS" && attempt === 0) { token = null; continue; }   // expired token: get a new one once
        throw new ShopifyError(`Shopify refused the access (${res.status}). Check the token / app installation and its permissions.`, false, res.status);
      }
      if (res.status === 404) throw new ShopifyError(`Shopify API version ${creds.api_version} or the store was not found (404)`, false, 404);
      if (!res.ok) throw new ShopifyError(`Shopify answered ${res.status}`, false, res.status);
      const j = await res.json();
      const errors: Json[] = j.errors ? (Array.isArray(j.errors) ? j.errors : [{ message: String(j.errors) }]) : [];
      if (errors.some((e) => e?.extensions?.code === "THROTTLED")) {
        const ts = j.extensions?.cost?.throttleStatus;
        const need = Number(j.extensions?.cost?.requestedQueryCost) || 100;
        await sleep(ts ? Math.ceil(Math.max(0, need - ts.currentlyAvailable) / Math.max(1, ts.restoreRate)) * 1000 + 250 : 2000);
        lastErr = new ShopifyError("Shopify rate limit", true);
        continue;
      }
      const fatal = errors.filter((e) => !(j.data && (e.path || []).some((p: unknown) => ignoreErrorPaths.includes(String(p)))));
      if (fatal.length) throw new ShopifyError(fatal.map((e) => e.message).join("; ").slice(0, 600));
      // stay under the bucket: if the next call of the same size would not fit, wait for it to refill
      const ts = j.extensions?.cost?.throttleStatus;
      const req = Number(j.extensions?.cost?.requestedQueryCost) || 0;
      if (ts && req && ts.currentlyAvailable < req) await sleep(Math.ceil((req - ts.currentlyAvailable) / Math.max(1, ts.restoreRate)) * 1000);
      return j.data ?? {};
    }
    throw lastErr ?? new ShopifyError("Shopify did not answer", true);
  }

  return { gql, getToken, endpoint };
}
export type Shopify = ReturnType<typeof createShopify>;

// ------------------------------------------------------------------------------------------------------------------ queries
const MONEY = "shopMoney { amount currencyCode }";
export const Q = {
  shop: `query { shop { name myshopifyDomain ianaTimezone currencyCode } currentAppInstallation { accessScopes { handle } } }`,
  locations: `query { locations(first: 100, includeInactive: true) { nodes { id name isActive address { city } } } }`,
  products: `query($after: String, $q: String) { products(first: 5, after: $after, query: $q, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { ...P } } }`,
  product: `query($id: ID!) { product(id: $id) { ...P } }`,
  productVariants: `query($id: ID!, $after: String) { product(id: $id) { variants(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...V } } } }`,
  levels: `query($id: ID!, $after: String) { location(id: $id) { inventoryLevels(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { updatedAt quantities(names: ["available", "committed", "on_hand", "incoming"]) { name quantity } item { id sku tracked variant { id } } } } } }`,
  level: `query($item: ID!, $loc: ID!) { inventoryItem(id: $item) { id sku tracked variant { id }
      inventoryLevel(locationId: $loc) { updatedAt quantities(names: ["available", "committed", "on_hand", "incoming"]) { name quantity } } } }`,
  orderIds: `query($after: String, $q: String) { orders(first: 100, after: $after, query: $q, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor } nodes { id updatedAt } } }`,
  order: `query($id: ID!) { order(id: $id) { id legacyResourceId name createdAt processedAt updatedAt cancelledAt cancelReason closedAt test
      displayFinancialStatus displayFulfillmentStatus returnStatus currencyCode
      totalPriceSet { ${MONEY} } subtotalPriceSet { ${MONEY} }
      customer { displayName }
      lineItems(first: 20) { pageInfo { hasNextPage endCursor } nodes { ...L } }
      fulfillments(first: 3) { id status displayStatus createdAt inTransitAt deliveredAt trackingInfo(first: 3) { company number url }
        fulfillmentLineItems(first: 20) { nodes { quantity lineItem { id } } } }
      refunds(first: 3) { id createdAt note refundLineItems(first: 20) { nodes { quantity restockType restocked location { id } lineItem { id variant { inventoryItem { id } } } } } } } }`,
  orderLines: `query($id: ID!, $after: String) { order(id: $id) { lineItems(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...L } } } }`,
};
const FRAG_V = `fragment V on ProductVariant { id title sku price compareAtPrice position inventoryItem { id tracked } }`;
const FRAG_P = `fragment P on Product { id legacyResourceId title handle productType vendor status tags createdAt updatedAt
  media(first: 5) { nodes { preview { image { url altText } } } }
  variants(first: 50) { pageInfo { hasNextPage endCursor } nodes { ...V } } }`;
const FRAG_L = `fragment L on LineItem { id title variantTitle sku quantity currentQuantity unfulfilledQuantity
  originalUnitPriceSet { ${MONEY} } image { url } product { id } variant { id inventoryItem { id } } }`;
// GraphQL refuses unused fragments, so attach exactly the ones a query spreads (P needs V).
export const withFragments = (q: string) => [q, q.includes("...P") ? FRAG_P : "", q.includes("...P") || q.includes("...V") ? FRAG_V : "",
  q.includes("...L") ? FRAG_L : ""].filter(Boolean).join(String.fromCharCode(10));

// ------------------------------------------------------------------------------------------------------------------ normalise
const quantities = (qs: Json[] | undefined) => Object.fromEntries((qs || []).map((q) => [q.name, Number(q.quantity)]));

export function normaliseVariant(v: Json) {
  return {
    id: v.id, title: v.title, sku: v.sku ?? null, price: num(v.price), compare_at_price: num(v.compareAtPrice), position: v.position ?? null,
    inventory_item_id: v.inventoryItem?.id ?? null, tracked: v.inventoryItem?.tracked ?? true, image_url: null,
  };
}

export function normaliseProduct(p: Json, extraVariants: Json[] = []) {
  const images = (p.media?.nodes || []).map((m: Json) => m?.preview?.image).filter((i: Json) => i?.url).map((i: Json) => ({ url: i.url, alt: i.altText ?? null }));
  const variants = [...(p.variants?.nodes || []), ...extraVariants].map(normaliseVariant);
  return {
    id: p.id, legacy_id: num(p.legacyResourceId), title: p.title, handle: p.handle, product_type: p.productType, vendor: p.vendor,
    status: p.status, tags: p.tags || [], created_at: p.createdAt, updated_at: p.updatedAt, image_url: images[0]?.url ?? null, images,
    variants, variants_complete: !p.variants?.pageInfo?.hasNextPage || extraVariants.length > 0,
  };
}

export function normaliseLevel(node: Json, locationId: string) {
  const q = quantities(node.quantities);
  return {
    inventory_item_id: node.item?.id, location_id: locationId, variant_id: node.item?.variant?.id ?? null, sku: node.item?.sku ?? null,
    tracked: node.item?.tracked ?? true, updated_at: node.updatedAt, available: q.available ?? null, committed: q.committed ?? null,
    on_hand: q.on_hand ?? null, incoming: q.incoming ?? null,
  };
}

export function normaliseOrder(o: Json, extraLines: Json[] = []) {
  const money = (s: Json | undefined) => num(s?.shopMoney?.amount);
  const line = (l: Json) => ({
    id: l.id, title: l.title, variant_title: l.variantTitle, sku: l.sku ?? null, quantity: l.quantity, current_quantity: l.currentQuantity,
    unfulfilled_quantity: l.unfulfilledQuantity, price: money(l.originalUnitPriceSet), image_url: l.image?.url ?? null,
    product_id: l.product?.id ?? null, variant_id: l.variant?.id ?? null, inventory_item_id: l.variant?.inventoryItem?.id ?? null,
  });
  return {
    id: o.id, legacy_id: num(o.legacyResourceId), name: o.name, created_at: o.createdAt, processed_at: o.processedAt, updated_at: o.updatedAt,
    cancelled_at: o.cancelledAt, cancel_reason: o.cancelReason, closed_at: o.closedAt, test: !!o.test,
    financial_status: o.displayFinancialStatus, fulfillment_status: o.displayFulfillmentStatus, return_status: o.returnStatus,
    currency: o.currencyCode ?? o.totalPriceSet?.shopMoney?.currencyCode, total: money(o.totalPriceSet), subtotal: money(o.subtotalPriceSet),
    customer_name: o.customer?.displayName ?? null,
    lines: [...(o.lineItems?.nodes || []), ...extraLines].map(line),
    fulfillments: (o.fulfillments || []).map((f: Json) => ({
      id: f.id, status: f.status, display_status: f.displayStatus, created_at: f.createdAt, in_transit_at: f.inTransitAt, delivered_at: f.deliveredAt,
      tracking: (f.trackingInfo || []).map((t: Json) => ({ company: t.company, number: t.number, url: t.url })),
      lines: (f.fulfillmentLineItems?.nodes || []).map((n: Json) => ({ line_id: n.lineItem?.id, quantity: n.quantity })),
    })),
    refunds: (o.refunds || []).map((r: Json) => ({
      id: r.id, created_at: r.createdAt, note: r.note,
      lines: (r.refundLineItems?.nodes || []).map((n: Json) => ({
        line_id: n.lineItem?.id, quantity: n.quantity, restock_type: n.restockType, restocked: !!n.restocked,
        location_id: n.location?.id ?? null, inventory_item_id: n.lineItem?.variant?.inventoryItem?.id ?? null,
      })),
    })),
  };
}

// ------------------------------------------------------------------------------------------------------------------ fetchers
export async function fetchProduct(s: Shopify, id: string) {
  const d = await s.gql(withFragments(Q.product), { id });
  if (!d.product) return null;
  return normaliseProduct(d.product, await moreVariants(s, d.product));
}
async function moreVariants(s: Shopify, p: Json): Promise<Json[]> {
  const out: Json[] = [];
  let page = p.variants?.pageInfo;
  while (page?.hasNextPage) {
    const d = await s.gql(withFragments(Q.productVariants), { id: p.id, after: page.endCursor });
    out.push(...(d.product?.variants?.nodes || []));
    page = d.product?.variants?.pageInfo;
  }
  return out;
}
export async function fetchProductsPage(s: Shopify, after: string | null, q: string | null) {
  const d = await s.gql(withFragments(Q.products), { after, q });
  const conn = d.products || { nodes: [], pageInfo: {} };
  const products = [];
  for (const p of conn.nodes) products.push(normaliseProduct(p, await moreVariants(s, p)));
  return { products, next: conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null };
}
export async function fetchLocations(s: Shopify) {
  const d = await s.gql(Q.locations);
  return (d.locations?.nodes || []).map((l: Json) => ({ id: l.id, name: l.name, is_active: l.isActive, city: l.address?.city ?? null }));
}
export async function fetchLevelsPage(s: Shopify, locationId: string, after: string | null) {
  const d = await s.gql(Q.levels, { id: locationId, after });
  const conn = d.location?.inventoryLevels || { nodes: [], pageInfo: {} };
  return { levels: conn.nodes.map((n: Json) => normaliseLevel(n, locationId)), next: conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null };
}
export async function fetchLevel(s: Shopify, itemId: string, locationId: string) {
  const d = await s.gql(Q.level, { item: itemId, loc: locationId });
  const it = d.inventoryItem;
  if (!it || !it.inventoryLevel) return null;
  return normaliseLevel({ ...it.inventoryLevel, item: { id: it.id, sku: it.sku, tracked: it.tracked, variant: it.variant } }, locationId);
}
export async function fetchOrderIdsPage(s: Shopify, after: string | null, q: string | null) {
  const d = await s.gql(Q.orderIds, { after, q });
  const conn = d.orders || { nodes: [], pageInfo: {} };
  return { ids: conn.nodes.map((n: Json) => n.id as string), next: conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null };
}
export async function fetchOrder(s: Shopify, id: string) {
  // customer name needs Shopify's protected-customer-data access; without it the order still syncs, just without the name
  const d = await s.gql(withFragments(Q.order), { id }, ["customer"]);
  const o = d.order;
  if (!o) return null;
  const extra: Json[] = [];
  let page = o.lineItems?.pageInfo;
  while (page?.hasNextPage) {
    const m = await s.gql(withFragments(Q.orderLines), { id, after: page.endCursor });
    extra.push(...(m.order?.lineItems?.nodes || []));
    page = m.order?.lineItems?.pageInfo;
  }
  return normaliseOrder(o, extra);
}

// ------------------------------------------------------------------------------------------------------------------ webhooks
// Subscriptions point at our function URL. Newer API versions use `uri`, older ones `callbackUrl`: try one, fall back to the other.
export async function registerWebhooks(s: Shopify, url: string) {
  let existing: { topic: string; url: string }[] = [];
  let style: "uri" | "callbackUrl" = "uri";
  try {
    const d = await s.gql(`query { webhookSubscriptions(first: 100) { nodes { id topic uri } } }`);
    existing = (d.webhookSubscriptions?.nodes || []).map((n: Json) => ({ topic: n.topic, url: n.uri }));
  } catch {
    style = "callbackUrl";
    const d = await s.gql(`query { webhookSubscriptions(first: 100) { nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`);
    existing = (d.webhookSubscriptions?.nodes || []).map((n: Json) => ({ topic: n.topic, url: n.endpoint?.callbackUrl }));
  }
  let created = 0;
  const problems: string[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    if (existing.some((e) => e.topic === topic && e.url === url)) continue;
    const d = await s.gql(`mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`,
      { topic, sub: style === "uri" ? { uri: url, format: "JSON" } : { callbackUrl: url, format: "JSON" } });
    const errs = d.webhookSubscriptionCreate?.userErrors || [];
    if (errs.length) problems.push(`${topic}: ${errs.map((e: Json) => e.message).join(", ")}`);
    else created++;
  }
  return { total: WEBHOOK_TOPICS.length - problems.length, created, problems };
}

// Shopify signs each webhook: base64(HMAC-SHA256(app client secret, raw body)). Constant-time compare.
export async function verifyWebhook(rawBody: Uint8Array<ArrayBuffer>, hmacHeader: string | null, secret: string | null | undefined): Promise<boolean> {
  if (!hmacHeader || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const expected = btoa(String.fromCharCode(...sig));
  return safeEqual(expected, hmacHeader.trim());
}
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
