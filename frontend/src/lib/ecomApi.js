import { supabase } from "./supabase";
import { addDaysToDateStr } from "./kolkataTime";

// E-commerce department (v3_35). Every read goes through row-level security (ecom_can_access: E-commerce + Marketing members and
// Management); every change is a database function that re-checks the caller. Shopify itself is only reached by the shopify-sync
// server function -- no Shopify token is ever in the browser.

export const L = (lang, en, gu) => (lang === "gu" ? gu : en);

const rpc = async (name, args) => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
};
const rows = async (q) => {
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
};

// ---------------------------------------------------------------------------------------------------------- connection / sync
export const connectionStatus = () => rpc("ecom_connection_status");
export const saveConnection = (f) => rpc("ecom_save_connection", {
  p_shop_domain: f.shop_domain, p_api_version: f.api_version, p_auth_mode: f.auth_mode, p_client_id: f.client_id || null,
  p_client_secret: f.client_secret || null, p_access_token: f.access_token || null,
});
export const setThreshold = (threshold, variantId = null) => rpc("ecom_set_threshold", { p_threshold: threshold, p_variant_id: variantId });
export const syncRuns = () => rows(supabase.from("ecom_sync_runs").select("*").order("started_at", { ascending: false }).limit(15));

async function callSync(body) {
  const { data, error } = await supabase.functions.invoke("shopify-sync", { body });
  if (error) {
    let msg = "Could not reach the Shopify sync service. Please try again.";
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep the generic message */ }
    throw new Error(msg);
  }
  return data;
}
export const testConnection = () => callSync({ action: "test" });
export const syncNow = (full = false) => callSync({ action: "sync", full });

// ---------------------------------------------------------------------------------------------------------- dashboard / reports
export const dashboard = (from, to) => rpc("ecom_dashboard", { p_from: from, p_to: to });
export const inventoryReport = (from, to, location, search) =>
  rpc("ecom_inventory_report", { p_from: from, p_to: to, p_location: location || null, p_search: search || null });

// ---------------------------------------------------------------------------------------------------------- orders
const ORDER_COLS = "*, ecom_order_lines(shopify_id, title, variant_title, sku, image_url, quantity, current_quantity, variant_id)";
export async function listOrders({ from, to, stages, payment, search, extra } = {}) {
  let q = supabase.from("ecom_orders").select(ORDER_COLS).eq("is_test", false).order("shopify_created_at", { ascending: false }).limit(300);
  if (from) q = q.gte("shopify_created_at", `${from}T00:00:00+05:30`);
  if (to) q = q.lt("shopify_created_at", `${addDaysToDateStr(to, 1)}T00:00:00+05:30`);
  if (stages?.length) q = q.in("stage", stages);
  if (payment) q = q.eq("financial_status", payment);
  if (extra) q = extra(q);
  const s = (search || "").trim().replace(/[%,()"]/g, " ").trim();
  if (s) {
    // order number / customer, or any line's product name / SKU
    const lines = await rows(supabase.from("ecom_order_lines").select("order_id").or(`title.ilike.%${s}%,sku.ilike.%${s}%`).limit(300));
    const ids = [...new Set(lines.map((l) => l.order_id))];
    const parts = [`name.ilike.%${s}%`, `customer_name.ilike.%${s}%`];
    if (ids.length) parts.push(`shopify_id.in.(${ids.map((i) => `"${i}"`).join(",")})`);
    q = q.or(parts.join(","));
  }
  return rows(q);
}
export async function orderDetail(id) {
  const [o, lines, events, refunds] = await Promise.all([
    supabase.from("ecom_orders").select("*").eq("shopify_id", id).maybeSingle(),
    rows(supabase.from("ecom_order_lines").select("*").eq("order_id", id)),
    rows(supabase.from("ecom_order_events").select("*").eq("order_id", id).order("at")),
    rows(supabase.from("ecom_refunds").select("*").eq("order_id", id).order("shopify_created_at")),
  ]);
  if (o.error) throw o.error;
  return { order: o.data, lines, events, refunds };
}
export const listRefunds = (from, to) => {
  let q = supabase.from("ecom_refunds").select("*, ecom_orders(name, customer_name, stage)").order("shopify_created_at", { ascending: false }).limit(300);
  if (from) q = q.gte("shopify_created_at", `${from}T00:00:00+05:30`);
  if (to) q = q.lt("shopify_created_at", `${addDaysToDateStr(to, 1)}T00:00:00+05:30`);
  return rows(q);
};

// ---------------------------------------------------------------------------------------------------------- catalogue / stock
export function listVariants({ search, status, stock, category } = {}) {
  let q = supabase.from("ecom_variant_stock").select("*").order("product_title").limit(2000);
  const s = (search || "").trim().replace(/[%,()"]/g, " ").trim();
  if (s) q = q.or(`product_title.ilike.%${s}%,sku.ilike.%${s}%,variant_title.ilike.%${s}%`);
  if (status) q = q.eq("product_status", status);
  if (stock) q = q.eq("stock_status", stock);
  if (category) q = q.eq("product_type", category);
  return rows(q);
}
export async function productDetail(id) {
  const [p, variants, locations] = await Promise.all([
    supabase.from("ecom_products").select("*").eq("shopify_id", id).maybeSingle(),
    rows(supabase.from("ecom_variant_stock").select("*").eq("product_id", id)),
    rows(supabase.from("ecom_locations").select("*")),
  ]);
  if (p.error) throw p.error;
  const items = variants.map((v) => v.inventory_item_id).filter(Boolean);
  const vids = variants.map((v) => v.variant_id);
  const [levels, lines, moves] = await Promise.all([
    items.length ? rows(supabase.from("ecom_inventory_levels").select("*").in("inventory_item_id", items)) : [],
    vids.length ? rows(supabase.from("ecom_order_lines").select("*, ecom_orders(shopify_id, name, shopify_created_at, stage, financial_status, customer_name, is_test)")
      .in("variant_id", vids).limit(200)) : [],
    vids.length ? rows(supabase.from("ecom_stock_movements").select("*").in("variant_id", vids).order("occurred_at", { ascending: false }).limit(200)) : [],
  ]);
  return { product: p.data, variants, locations, levels, lines: lines.filter((l) => l.ecom_orders && !l.ecom_orders.is_test), moves };
}
export const listLocations = () => rows(supabase.from("ecom_locations").select("*").order("name"));
export async function listMovements({ from, to, type, search, location } = {}) {
  let q = supabase.from("ecom_stock_movements").select("*").order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(500);
  if (from) q = q.gte("occurred_at", `${from}T00:00:00+05:30`);
  if (to) q = q.lt("occurred_at", `${addDaysToDateStr(to, 1)}T00:00:00+05:30`);
  if (type) q = q.eq("movement_type", type);
  if (location) q = q.eq("location_id", location);
  const s = (search || "").trim().replace(/[%,()"]/g, " ").trim();
  if (s) {
    const vs = await rows(supabase.from("ecom_variant_stock").select("variant_id").or(`product_title.ilike.%${s}%,sku.ilike.%${s}%`).limit(300));
    if (!vs.length) return [];
    q = q.in("variant_id", vs.map((v) => v.variant_id));
  }
  return rows(q);
}
export const variantsById = async (ids) => {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const vs = await rows(supabase.from("ecom_variant_stock").select("variant_id, product_id, product_title, variant_title, sku, image_url").in("variant_id", list));
  return Object.fromEntries(vs.map((v) => [v.variant_id, v]));
};

// ---------------------------------------------------------------------------------------------------------- products to add
export const listListings = () => rows(supabase.from("ecom_listing_items").select("*, ecom_products(shopify_id, title, status)").is("archived_at", null)
  .order("created_at", { ascending: false }));
export const team = () => rpc("ecom_team");
export const saveListing = (f) => rpc("ecom_save_listing", {
  p_id: f.id || null, p_title: f.title, p_sku: f.sku || null, p_category: f.category || null, p_image_url: f.image_url || null,
  p_retail_product_id: f.retail_product_id || null, p_assigned_to: f.assigned_to || null, p_target_date: f.target_date || null, p_notes: f.notes || null,
});
export const setListingStatus = (id, status, shopifyProductId = null) => rpc("ecom_set_listing_status", { p_id: id, p_status: status, p_shopify_product_id: shopifyProductId });
export const removeListing = (id) => rpc("ecom_remove_listing", { p_id: id });
export const searchMasterProducts = (s) => rows(supabase.from("retail_products").select("id, name, sku, category, image_path")
  .or(`name.ilike.%${s.replace(/[%,()"]/g, " ")}%,sku.ilike.%${s.replace(/[%,()"]/g, " ")}%`).eq("is_active", true).limit(15));
export const searchShopifyProducts = (s) => rows(supabase.from("ecom_products").select("shopify_id, title, status").is("deleted_at", null)
  .ilike("title", `%${s.replace(/[%,()"]/g, " ")}%`).limit(15));

// ---------------------------------------------------------------------------------------------------------- dates & labels
export { presetRange, PRESETS } from "./ecomRules.js";
export const STAGE = {
  PENDING: ["Pending", "બાકી", "ON_HOLD"], PROCESSING: ["Processing", "પ્રોસેસિંગ", "IN_PROGRESS"],
  PARTIALLY_FULFILLED: ["Partially fulfilled", "આંશિક મોકલ્યું", "IN_PROGRESS"], FULFILLED: ["Fulfilled", "ફુલફિલ", "ACCEPTED"],
  DISPATCHED: ["Dispatched", "રવાના", "ACCEPTED"], DELIVERED: ["Delivered", "પહોંચાડ્યું", "COMPLETED"],
  CANCELLED: ["Cancelled", "રદ", "RETURNED"], RETURNED: ["Returned", "પરત", "RETURNED"],
};
export const MOVEMENT = {
  BASELINE: ["Opening balance (first sync)", "શરૂઆતનો સ્ટોક"], ORDER: ["Order", "ઓર્ડર"], CANCEL_RESTOCK: ["Cancelled – restocked", "રદ – ફરી સ્ટોકમાં"],
  RETURN_RESTOCK: ["Return – restocked", "રિટર્ન – ફરી સ્ટોકમાં"], ADJUSTMENT_SYNCED: ["Synced adjustment", "સિંક થયેલ ફેરફાર"],
  ITEM_REMOVED: ["Removed from location", "સ્થાનમાંથી દૂર"],
};
export const STOCK = { IN: ["In stock", "સ્ટોકમાં", "COMPLETED"], LOW: ["Low stock", "ઓછો સ્ટોક", "IN_PROGRESS"], OUT: ["Out of stock", "સ્ટોક ખતમ", "RETURNED"], NOT_TRACKED: ["Not tracked", "ટ્રેક નથી", "ON_HOLD"] };
export const pretty = (s) => (s ? String(s).replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : "—");
export const money = (n, cur = "INR") => (n === null || n === undefined ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: cur || "INR", maximumFractionDigits: 2 }).format(Number(n)));
export const when = (ts) => (ts ? new Date(ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const day = (ts) => (ts ? new Date(ts).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }) : "—");
