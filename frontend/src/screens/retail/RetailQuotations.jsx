import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { formatCurrency, statusBadgeClass } from "../../lib/retailModules";
import {
  createQuotation, convertQuotationToOrder, approveQuotation, addQuotationItemFromScan, scanProduct,
  listQuotationItems, removeQuotationItem, createQuotationRevision, recordQuotationSent, recordQuotationCustomerApproval,
  rejectQuotation, decideQuotationDiscountApproval, searchCustomers, addManualQuotationItem,
} from "../../lib/retailApi";
import { getProofPhotoUrl } from "../../lib/api";
import QRScanner from "../../components/QRScanner.jsx";

const STATUSES = ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"];
const emptyItem = () => ({ item_name: "", quantity: 1, unit_price: 0 });
const APPROVAL_METHODS = ["WHATSAPP_MESSAGE", "SIGNED_COPY", "EMAIL", "OTP", "MANUAL_NOTE"];

// Sales & Quotations — Lead -> Quotation -> Scan QR -> Discount/Adjustment -> Send (WhatsApp) -> Customer Approval ->
// Convert to Order, all on the SAME quotation/customer/serial (v2_93t). "Convert to Order" and every status change
// that matters (Sent, Customer-Approved, Rejected) goes through its own RPC so totals/evidence/lead-status are
// never left for the browser to get half-right.
export default function RetailQuotations({ lang, lookups, profile }) {
  const [searchParams] = useSearchParams();
  const leadId = searchParams.get("lead_id"); // set when arriving from RetailLeads "Create Quotation" / Won follow-up
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [actionMsg, setActionMsg] = useState(null); // { type, text } — a failed ACTION never blanks the loaded page
  const [rows, setRows] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [form, setForm] = useState({ customer_name: "", phone: "", email: "", billing_address: "", delivery_address: "", store_location_id: "", valid_until: "", internal_approval_required: false });
  const [items, setItems] = useState([emptyItem()]);
  const canApprove = !!(profile?.isManagement || profile?.isDeptHead);
  const [scanOpenFor, setScanOpenFor] = useState(null); // quotation id whose scanner is open
  const [scanPreview, setScanPreview] = useState(null); // { code, product, quantity, discount, discountType, adjustmentType, adjustmentValue, adjustmentReason }
  const [scanBusy, setScanBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState(null);

  // ---- mandatory searchable customer select (spec section 1) ------------------------------------------------------------------------
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState(null); // null = not searched yet; [] = searched, no match
  const [customerSearching, setCustomerSearching] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState(null); // the real retail_customers row, or null
  const [addingNewCustomer, setAddingNewCustomer] = useState(false); // only offered once search returns zero matches

  // ---- optional manual item, kept visually secondary to Scan QR (spec section 4) ----------------------------------------------------
  const [manualItemOpenFor, setManualItemOpenFor] = useState(null); // quotation id
  const [manualItemForm, setManualItemForm] = useState({ item_name: "", description: "", product_code: "", quantity: 1, unit_price: 0, discount_type: "FIXED", discount: 0, gst_rate: 0, notes: "" });
  const [manualItemBusy, setManualItemBusy] = useState(false);
  const [manualItemMsg, setManualItemMsg] = useState(null);

  // ---- resolved product-photo URLs for the item cards + PDF (spec sections 5 & 7) ---------------------------------------------------
  const [photoUrls, setPhotoUrls] = useState({}); // attachment id (product_image_path) -> signed URL

  const [storeLocations, setStoreLocations] = useState([]);
  const [lineItems, setLineItems] = useState({}); // quotationId -> [items]
  const [openPanel, setOpenPanel] = useState({}); // quotationId -> 'send' | 'approve' | 'reject' | null
  const [panelForm, setPanelForm] = useState({}); // quotationId -> { phone, method, notes, reason }
  const [panelBusy, setPanelBusy] = useState(null);
  const [panelMsg, setPanelMsg] = useState({}); // quotationId -> { type, text }
  const [customersById, setCustomersById] = useState({}); // customer_id -> { whatsapp, phone } — the REAL registered WhatsApp number

  const retailDept = useMemo(() => lookups.departments.find((d) => d.code === "RETAIL"), [lookups.departments]);
  const total = useMemo(() => items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0), 0), [items]);

  useEffect(() => {
    supabase.from("locations").select("id, name_en").eq("is_active", true).order("name_en").then(({ data }) => setStoreLocations(data || []));
  }, []);

  // Real product photos on the item card and in the PDF, resolved once and cached — never re-fetched for an
  // attachment id already resolved (or already in flight) this session. A ref, not state, tracks "seen" ids so
  // this stays a stable callback with no dependency on photoUrls itself.
  const seenPhotoIds = React.useRef(new Set());
  const resolvePhotoUrls = useCallback(async (itemRows) => {
    const ids = Array.from(new Set(itemRows.map((it) => it.product_image_path).filter((id) => id && !seenPhotoIds.current.has(id))));
    if (ids.length === 0) return;
    ids.forEach((id) => seenPhotoIds.current.add(id));
    const pairs = await Promise.all(ids.map(async (id) => { try { return [id, await getProofPhotoUrl(id)]; } catch { return [id, null]; } }));
    setPhotoUrls((m) => ({ ...m, ...Object.fromEntries(pairs) }));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await supabase.from("retail_quotations").select("*").eq("is_active", true).eq("is_current_revision", true)
      .order("created_at", { ascending: false }).limit(200);
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    setLoading(false);
    const pairs = await Promise.all((data || []).slice(0, 50).map((r) => listQuotationItems(r.id).then(({ data: its }) => [r.id, its || []])));
    setLineItems(Object.fromEntries(pairs));
    resolvePhotoUrls(pairs.flatMap(([, its]) => its));

    // The customer's OWN registered WhatsApp number (spec section 8) — never guessed from the quotation's plain
    // contact phone alone when a distinct WhatsApp number is on file.
    const custIds = Array.from(new Set((data || []).map((r) => r.customer_id).filter(Boolean)));
    if (custIds.length > 0) {
      const { data: custs } = await supabase.from("retail_customers").select("id, whatsapp, phone").in("id", custIds);
      setCustomersById(Object.fromEntries((custs || []).map((c) => [c.id, c])));
    }
  }, [resolvePhotoUrls]);

  // Debounced customer search (spec section 1) — searches name/mobile/whatsapp/lead number, scoped by RLS to
  // exactly the customers this salesperson (or Head/Management) is authorized to see.
  useEffect(() => {
    if (leadId) return; // arriving from a lead already carries a real, linked customer — no search needed
    if (!customerQuery.trim()) { setCustomerResults(null); setAddingNewCustomer(false); return; }
    setCustomerSearching(true);
    const handle = setTimeout(async () => {
      const { data } = await searchCustomers(customerQuery);
      setCustomerResults(data || []);
      setCustomerSearching(false);
      setAddingNewCustomer(false);
    }, 350);
    return () => clearTimeout(handle);
  }, [customerQuery, leadId]);

  function chooseCustomer(cust) {
    setSelectedCustomer(cust);
    setCustomerResults(null);
    setCustomerQuery(cust.full_name);
    setAddingNewCustomer(false);
    setForm((f) => ({
      ...f, customer_name: cust.full_name || "", phone: cust.phone || "", email: cust.email || "",
      billing_address: cust.billing_address || "", delivery_address: cust.delivery_address || "",
    }));
  }
  function clearCustomerSelection() {
    setSelectedCustomer(null);
    setCustomerQuery("");
    setCustomerResults(null);
    setForm((f) => ({ ...f, customer_name: "", phone: "", email: "", billing_address: "", delivery_address: "" }));
  }
  function startAddNewCustomer() {
    setAddingNewCustomer(true);
    setSelectedCustomer(null);
    setForm((f) => ({ ...f, customer_name: customerQuery, phone: "", email: "", billing_address: "", delivery_address: "" }));
  }

  useEffect(() => { load(); }, [load]);

  // Arriving from a lead (Create Quotation button, or the "Quotation Requested" follow-up outcome): prefill EVERY
  // real customer detail already on file — name, phone, email, store, and the customer's billing/delivery address
  // — never re-typed by hand — and open the form already expanded so the salesperson only has to scan products.
  useEffect(() => {
    if (!leadId) return;
    supabase.from("retail_leads").select("customer_name, phone, email, location_id, customer_id").eq("id", leadId).maybeSingle().then(async ({ data }) => {
      if (!data) return;
      let billing = "", delivery = "";
      if (data.customer_id) {
        const { data: cust } = await supabase.from("retail_customers").select("*").eq("id", data.customer_id).maybeSingle();
        billing = cust?.billing_address || ""; delivery = cust?.delivery_address || "";
        if (cust) setSelectedCustomer(cust); // links customer_id through to createQuotation — never re-typed
      }
      setForm((f) => ({
        ...f, customer_name: data.customer_name || f.customer_name, phone: data.phone || f.phone, email: data.email || "",
        store_location_id: data.location_id || "", billing_address: billing, delivery_address: delivery,
      }));
      setShowForm(true);
    });
  }, [leadId]);

  function updateItem(idx, field, value) {
    setItems((its) => its.map((it, i) => (i === idx ? { ...it, [field]: value } : it)));
  }
  function addItemRow() { setItems((its) => [...its, emptyItem()]); }
  function removeItemRow(idx) { setItems((its) => its.filter((_, i) => i !== idx)); }

  async function handleAdd(e) {
    e.preventDefault();
    // Mandatory customer selection (spec section 1): either an existing customer was picked from search, arriving
    // from a lead already carries one, or the salesperson explicitly opened "+ Add New Customer" for a genuinely
    // new one (search having returned zero matches first).
    if (!retailDept) return;
    if (!leadId && !selectedCustomer && !addingNewCustomer) { setActionMsg({ type: "error", text: t("selectCustomerRequiredMsg", lang) }); return; }
    if (!form.customer_name || !form.phone) { setActionMsg({ type: "error", text: t("customerNamePhoneRequiredMsg", lang) }); return; }
    setSaving(true);
    setActionMsg(null);
    const { error: err } = await createQuotation({
      customerId: selectedCustomer?.id || null,
      customerName: form.customer_name, phone: form.phone || null, email: form.email || null,
      billingAddress: form.billing_address || null, deliveryAddress: form.delivery_address || null, storeLocationId: form.store_location_id || null,
      validUntil: form.valid_until || null, internalApprovalRequired: form.internal_approval_required, leadId: leadId || null,
      items: items.filter((it) => it.item_name).map((it) => ({ item_name: it.item_name, quantity: Number(it.quantity) || 1, unit_price: Number(it.unit_price) || 0 })),
    });
    setSaving(false);
    if (err) { setActionMsg({ type: "error", text: err.message }); return; }
    setForm({ customer_name: "", phone: "", email: "", billing_address: "", delivery_address: "", store_location_id: "", valid_until: "", internal_approval_required: false });
    setItems([emptyItem()]);
    setShowForm(false);
    clearCustomerSelection();
    load();
  }

  async function convertToOrder(id) {
    setBusyId(id);
    setActionMsg(null);
    const { error: err } = await convertQuotationToOrder(id);
    setBusyId(null);
    if (err) { setActionMsg({ type: "error", text: err.message }); return; }
    load();
  }

  async function decideApproval(id, approved) {
    setBusyId(id);
    setActionMsg(null);
    const { error: err } = await approveQuotation(id, approved, null);
    setBusyId(null);
    if (err) { setActionMsg({ type: "error", text: err.message }); return; }
    load();
  }

  async function decideDiscount(id, approve) {
    setBusyId(id);
    setActionMsg(null);
    const reason = approve ? null : window.prompt(t("reasonForChangeLabel", lang)) || "";
    if (!approve && !reason.trim()) { setBusyId(null); return; }
    const { error: err } = await decideQuotationDiscountApproval(id, approve, reason);
    setBusyId(null);
    if (err) { setActionMsg({ type: "error", text: err.message }); return; }
    load();
  }

  async function createRevision(id) {
    const reason = window.prompt(t("revisionReasonPromptMsg", lang));
    if (!reason || !reason.trim()) return;
    setBusyId(id);
    setActionMsg(null);
    const { error: err } = await createQuotationRevision(id, reason.trim());
    setBusyId(null);
    if (err) { setActionMsg({ type: "error", text: err.message }); return; }
    load();
  }

  async function doRemoveItem(quotationId, itemId) {
    setBusyId(quotationId);
    const { error: err } = await removeQuotationItem(itemId);
    setBusyId(null);
    if (err) { setActionMsg({ type: "error", text: err.message }); return; }
    load();
  }

  function togglePanel(id, kind) {
    setOpenPanel((cur) => ({ ...cur, [id]: cur[id] === kind ? null : kind }));
    setPanelMsg((cur) => ({ ...cur, [id]: null }));
    setPanelForm((cur) => ({ ...cur, [id]: { phone: cur[id]?.phone || "", method: "WHATSAPP_MESSAGE", notes: "", reason: "" } }));
  }
  function setPForm(id, patch) {
    setPanelForm((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));
  }

  // The customer's OWN registered WhatsApp number — never the quotation's plain contact phone when a distinct
  // WhatsApp number is on file (spec section 8) — falling back only when neither is available.
  function effectivePhone(row) {
    const pf = panelForm[row.id] || {};
    return pf.phone || customersById[row.customer_id]?.whatsapp || customersById[row.customer_id]?.phone || row.phone || "";
  }

  // WhatsApp deep-link/share (no official Business API configured in this pilot — see report). Opening the share
  // link is NEVER treated as "sent" by itself; the salesperson must come back and explicitly confirm they sent it.
  function openWhatsApp(row) {
    const digits = effectivePhone(row).replace(/[^0-9]/g, "");
    const withCountry = digits.length === 10 ? `91${digits}` : digits;
    const message = encodeURIComponent(`${row.quotation_number} — ${formatCurrency(row.total_amount)}. ${t("quotationWhatsAppMsgBody", lang)}`);
    window.open(`https://wa.me/${withCountry}?text=${message}`, "_blank");
  }

  async function confirmSent(row) {
    const phone = effectivePhone(row);
    if (!phone) return;
    setPanelBusy(row.id);
    setPanelMsg((cur) => ({ ...cur, [row.id]: null }));
    const { error: err } = await recordQuotationSent(row.id, "WHATSAPP_MANUAL", phone);
    setPanelBusy(null);
    if (err) { setPanelMsg((cur) => ({ ...cur, [row.id]: { type: "error", text: err.message } })); return; }
    setOpenPanel((cur) => ({ ...cur, [row.id]: null }));
    load();
  }

  async function submitCustomerApproval(row) {
    const pf = panelForm[row.id] || {};
    if (pf.method === "MANUAL_NOTE" && !pf.notes?.trim()) return;
    setPanelBusy(row.id);
    setPanelMsg((cur) => ({ ...cur, [row.id]: null }));
    const { error: err } = await recordQuotationCustomerApproval(row.id, pf.method || "MANUAL_NOTE", pf.notes || null, row.total_amount);
    setPanelBusy(null);
    if (err) { setPanelMsg((cur) => ({ ...cur, [row.id]: { type: "error", text: err.message } })); return; }
    setOpenPanel((cur) => ({ ...cur, [row.id]: null }));
    load();
  }

  async function submitReject(row) {
    const pf = panelForm[row.id] || {};
    if (!pf.reason?.trim()) return;
    setPanelBusy(row.id);
    setPanelMsg((cur) => ({ ...cur, [row.id]: null }));
    const { error: err } = await rejectQuotation(row.id, pf.reason.trim());
    setPanelBusy(null);
    if (err) { setPanelMsg((cur) => ({ ...cur, [row.id]: { type: "error", text: err.message } })); return; }
    setOpenPanel((cur) => ({ ...cur, [row.id]: null }));
    load();
  }

  function openScan(quotationId) {
    setScanOpenFor((cur) => (cur === quotationId ? null : quotationId));
    setScanPreview(null);
    setScanMsg(null);
  }

  // Scan QR -> Fetch Product -> Show Product Preview -> Confirm Quantity -> Apply Authorized Discount/Adjustment -> Add.
  async function onScanDetected(code) {
    setScanMsg(null);
    const { data, error: err } = await scanProduct(code);
    if (err || !data) { setScanMsg({ type: "error", text: err?.message || t("productNotFoundMsg", lang) }); return; }
    setScanPreview({ code, product: data.product, serial: data.serial, quantity: 1, discount: 0, discountType: "FIXED", adjustmentType: "NONE", adjustmentValue: 0, adjustmentReason: "" });
  }

  async function confirmScanAdd(quotationId) {
    if (!scanPreview) return;
    setScanBusy(true);
    setScanMsg(null);
    const { error: err } = await addQuotationItemFromScan(
      quotationId, scanPreview.code, Number(scanPreview.quantity) || 1, Number(scanPreview.discount) || 0,
      scanPreview.discountType, scanPreview.adjustmentType, Number(scanPreview.adjustmentValue) || 0, scanPreview.adjustmentReason || null);
    setScanBusy(false);
    if (err) { setScanMsg({ type: "error", text: err.message }); return; }
    setScanMsg({ type: "success", text: t("productAddedToQuotationMsg", lang) });
    setScanPreview(null);
    load();
  }

  // "+ Add Manual Item (Optional)" — never linked to Product Master/Inventory; kept visually secondary to Scan QR.
  async function submitManualItem(quotationId) {
    if (!manualItemForm.item_name.trim()) return;
    setManualItemBusy(true);
    setManualItemMsg(null);
    const { error: err } = await addManualQuotationItem(quotationId, {
      itemName: manualItemForm.item_name, description: manualItemForm.description || null, productCode: manualItemForm.product_code || null,
      quantity: Number(manualItemForm.quantity) || 1, unitPrice: Number(manualItemForm.unit_price) || 0,
      discountType: manualItemForm.discount_type, discount: Number(manualItemForm.discount) || 0, gstRate: Number(manualItemForm.gst_rate) || 0,
      notes: manualItemForm.notes || null,
    });
    setManualItemBusy(false);
    if (err) { setManualItemMsg({ type: "error", text: err.message }); return; }
    setManualItemForm({ item_name: "", description: "", product_code: "", quantity: 1, unit_price: 0, discount_type: "FIXED", discount: 0, gst_rate: 0, notes: "" });
    setManualItemOpenFor(null);
    load();
  }

  // Preview/Print/Save-as-PDF: a self-contained document in a new tab (never fights the app's own layout/CSS), using
  // the browser's own native print-to-PDF — a real, professional, downloadable document, not a fake "PDF-looking" page.
  function openPdf(row) {
    const its = lineItems[row.id] || [];
    const w = window.open("", "_blank");
    if (!w) return;
    const rowsHtml = its.map((it) => {
      const photoUrl = it.product_image_path ? photoUrls[it.product_image_path] : null;
      const isManual = !it.inventory_item_id && !it.product_id;
      return `<tr>
        <td>${photoUrl ? `<img src="${photoUrl}" style="width:44px;height:44px;object-fit:cover;border-radius:4px;" />` : ""}</td>
        <td>${it.sku || ""}${it.retail_inventory_items?.serial_number ? `<br><span style="font-size:11px;color:#777">${it.retail_inventory_items.serial_number}</span>` : ""}</td>
        <td>${it.item_name || ""}${isManual ? `<br><span style="font-size:11px;color:#a06;">${t("manualItemBadgeLabel", lang)}</span>` : ""}</td>
        <td style="text-align:center">${it.quantity}</td>
        <td style="text-align:right">₹${Number(it.unit_price || 0).toFixed(2)}</td>
        <td style="text-align:right">₹${Number(it.discount || 0).toFixed(2)}</td>
        <td style="text-align:right">₹${Number(it.tax_amount ?? it.tax ?? 0).toFixed(2)}</td>
        <td style="text-align:right">₹${Number(it.line_total || 0).toFixed(2)}</td>
      </tr>`;
    }).join("");
    w.document.write(`<!doctype html><html><head><title>${row.quotation_number}</title><meta charset="utf-8">
      <style>
        *{box-sizing:border-box;} html,body{max-width:100%;overflow-x:hidden;}
        body{font-family:Arial,sans-serif;padding:16px;color:#222;}
        h1{font-size:20px;margin-bottom:0;} .sub{color:#666;font-size:13px;margin-top:2px;}
        table{width:100%;border-collapse:collapse;margin-top:16px;table-layout:fixed;}
        th,td{border:1px solid #ccc;padding:6px 8px;font-size:12px;word-wrap:break-word;overflow-wrap:anywhere;vertical-align:top;}
        img{max-width:100%;height:auto;}
        th{background:#f3f0ea;text-align:left;} .totals{margin-top:12px;text-align:right;font-size:14px;}
        .totals b{font-size:16px;} .terms{margin-top:20px;font-size:12px;color:#555;white-space:pre-wrap;}
        .sign{margin-top:60px;display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px;font-size:13px;}
        @media print { body{padding:8px;} }
      </style></head><body>
      <h1>Mood of Wood</h1>
      <div class="sub">${t("retailQuotationsTitle", lang)} · ${row.quotation_number} — ${t("revisionLabel", lang)} ${row.revision_no}</div>
      <div class="sub">${new Date(row.created_at).toLocaleDateString()}${row.valid_until ? " · " + t("validUntilLabel", lang) + ": " + row.valid_until : ""}</div>
      <p><b>${row.customer_name}</b><br>${row.phone || ""}${row.email ? " · " + row.email : ""}<br>
        ${row.billing_address ? t("billingAddressLabel", lang) + ": " + row.billing_address + "<br>" : ""}
        ${row.delivery_address ? t("deliveryAddressLabel", lang) + ": " + row.delivery_address : ""}</p>
      <table><thead><tr><th style="width:56px">${t("photoLabel", lang) || "Photo"}</th><th>${t("modelCodeLabel", lang)}</th><th>${t("itemNameLabel", lang)}</th><th>${t("quantityLabel", lang)}</th>
        <th>${t("unitPriceLabel", lang)}</th><th>${t("discountLabel", lang)}</th><th>GST</th><th>${t("totalAmountLabel", lang)}</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table>
      <div class="totals">${t("deliveryChargeLabel", lang) || "Delivery"}: ₹${Number(row.delivery_charge || 0).toFixed(2)} ·
        ${t("installationChargeLabel", lang) || "Installation"}: ₹${Number(row.installation_charge || 0).toFixed(2)}<br>
        <b>${t("grandTotalLabel", lang) || t("totalAmountLabel", lang)}: ₹${Number(row.total_amount || 0).toFixed(2)}</b></div>
      ${row.terms ? `<div class="terms"><b>${t("termsLabel", lang) || "Terms"}:</b><br>${row.terms}</div>` : ""}
      <div class="sign"><div>${t("authorizedSignatureLabel", lang) || "Authorized Signature"}: ______________</div><div>${t("customerSignatureLabel", lang) || "Customer Signature"}: ______________</div></div>
      </body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }

  if (loading) {
    return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 60 }} /><div className="skeleton-block" style={{ height: 220 }} /></div>;
  }
  if (error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{t("loadErrorRetry", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📃</div>
        <div className="dept-header-text"><h1>{t("retailQuotationsTitle", lang)}</h1></div>
      </div>

      {actionMsg && <div className="card"><div className={`msg ${actionMsg.type}`}>{actionMsg.text}</div></div>}

      <div className="card">
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? t("cancel", lang) : t("addQuotation", lang)}
        </button>
        {showForm && (
          <form onSubmit={handleAdd} className="form-grid" style={{ marginTop: 12 }}>
            {leadId ? (
              <div className="field full">
                <label>{t("customerNameLabel", lang)} *</label>
                <div className="sub">{form.customer_name} · {form.phone}{form.email ? ` · ${form.email}` : ""} — {t("linkedFromLeadMsg", lang)}</div>
              </div>
            ) : (
              <div className="field full">
                <label>{t("selectCustomerLabel", lang)} *</label>
                {selectedCustomer ? (
                  <div className="task-meta" style={{ justifyContent: "space-between", background: "var(--surface-2, #faf8f4)", padding: "8px 10px", borderRadius: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{selectedCustomer.full_name}</div>
                      <div className="sub">{selectedCustomer.phone}{selectedCustomer.email ? ` · ${selectedCustomer.email}` : ""}{selectedCustomer.area ? ` · ${selectedCustomer.area}` : ""}</div>
                    </div>
                    <button type="button" className="btn btn-outline" onClick={clearCustomerSelection}>{t("changeAction", lang)}</button>
                  </div>
                ) : (
                  <>
                    <input value={customerQuery} onChange={(e) => setCustomerQuery(e.target.value)}
                      placeholder={t("searchCustomerPlaceholder", lang)} autoComplete="off" />
                    {customerSearching && <div className="sub">{t("searchingLabel", lang)}…</div>}
                    {customerResults && customerResults.length > 0 && (
                      <div style={{ marginTop: 6, border: "1px solid var(--border, #ddd)", borderRadius: 8, overflow: "hidden" }}>
                        {customerResults.map((c) => (
                          <button key={c.id} type="button" onClick={() => chooseCustomer(c)}
                            style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "none", borderBottom: "1px solid var(--border, #eee)", background: "none", cursor: "pointer", minHeight: 44 }}>
                            <div style={{ fontWeight: 600 }}>{c.full_name}</div>
                            <div className="sub">{c.phone}{c.email ? ` · ${c.email}` : ""}{c.area ? ` · ${c.area}` : ""}</div>
                          </button>
                        ))}
                      </div>
                    )}
                    {customerResults && customerResults.length === 0 && !customerSearching && (
                      <div className="msg info" style={{ marginTop: 6 }}>
                        {t("noCustomerFoundMsg", lang)}
                        <div style={{ marginTop: 6 }}>
                          <button type="button" className="btn btn-outline" onClick={startAddNewCustomer}>➕ {t("addNewCustomerAction", lang)}</button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {(addingNewCustomer || leadId) && (
              <>
                {addingNewCustomer && (
                  <div className="field full">
                    <label>{t("customerNameLabel", lang)} *</label>
                    <input value={form.customer_name} onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))} required />
                  </div>
                )}
              </>
            )}
            {(selectedCustomer || addingNewCustomer) && (
              <>
                {addingNewCustomer && (
                  <div className="field">
                    <label>{t("phoneLabel", lang)} *</label>
                    <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} required />
                  </div>
                )}
                <div className="field">
                  <label>{t("emailLabel", lang)}</label>
                  <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
                </div>
              </>
            )}
            <div className="field">
              <label>{t("storeLabel", lang)}</label>
              <select value={form.store_location_id} onChange={(e) => setForm((f) => ({ ...f, store_location_id: e.target.value }))}>
                <option value="">—</option>
                {storeLocations.map((l) => <option key={l.id} value={l.id}>{l.name_en}</option>)}
              </select>
            </div>
            <div className="field">
              <label>{t("validUntilLabel", lang)}</label>
              <input type="date" value={form.valid_until} onChange={(e) => setForm((f) => ({ ...f, valid_until: e.target.value }))} />
            </div>
            <div className="field full"><label>{t("billingAddressLabel", lang)}</label>
              <input value={form.billing_address} onChange={(e) => setForm((f) => ({ ...f, billing_address: e.target.value }))} /></div>
            <div className="field full"><label>{t("deliveryAddressLabel", lang)}</label>
              <input value={form.delivery_address} onChange={(e) => setForm((f) => ({ ...f, delivery_address: e.target.value }))} /></div>
            <div className="field full">
              <label>{t("retailQuotationsTitle", lang)} — {t("itemNameLabel", lang)}</label>
              <div className="sub" style={{ marginBottom: 6 }}>{t("scanAfterCreateHintMsg", lang)}</div>
              {items.map((it, idx) => (
                <div key={idx} style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                  <input placeholder={t("itemNameLabel", lang)} value={it.item_name} onChange={(e) => updateItem(idx, "item_name", e.target.value)} style={{ flex: 2 }} />
                  <input type="number" placeholder={t("quantityLabel", lang)} value={it.quantity} onChange={(e) => updateItem(idx, "quantity", e.target.value)} style={{ flex: 1 }} min="0" />
                  <input type="number" placeholder={t("unitPriceLabel", lang)} value={it.unit_price} onChange={(e) => updateItem(idx, "unit_price", e.target.value)} style={{ flex: 1 }} min="0" />
                  {items.length > 1 && <button type="button" className="btn btn-outline" onClick={() => removeItemRow(idx)}>✕</button>}
                </div>
              ))}
              <button type="button" className="btn btn-outline" onClick={addItemRow}>{t("addItemRow", lang)}</button>
            </div>
            <div className="field full">
              <strong>{t("totalAmountLabel", lang)}: {formatCurrency(total)}</strong>
            </div>
            <div className="field full">
              <label className="task-meta" style={{ gap: 6 }}>
                <input type="checkbox" checked={form.internal_approval_required} onChange={(e) => setForm((f) => ({ ...f, internal_approval_required: e.target.checked }))} />
                {t("requiresInternalApprovalLabel", lang)}
              </label>
            </div>
            <div className="field full">
              <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => {
          const pendingApproval = r.internal_approval_required && !r.internal_approved_at;
          const canScanAdd = ["DRAFT", "SENT"].includes(r.status);
          const its = lineItems[r.id] || [];
          const pf = panelForm[r.id] || {};
          const panel = openPanel[r.id];
          const msg = panelMsg[r.id];
          const discountPending = r.discount_approval_status === "PENDING";
          const discountRejected = r.discount_approval_status === "REJECTED";
          return (
            <div key={r.id} style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
              <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{r.quotation_number} {r.revision_no > 1 ? `· ${t("revisionLabel", lang)} ${r.revision_no}` : ""} — {r.customer_name}</div>
                  <div className="sub">{formatCurrency(r.total_amount)}</div>
                  {r.internal_approval_required && (
                    <div className="sub">{r.internal_approved_at ? `✅ ${t("approvedLabel", lang)}` : `⏳ ${t("pendingApprovalLabel", lang)}`}</div>
                  )}
                  {r.sent_at && <div className="sub">📤 {t("sentLabel", lang)}: {new Date(r.sent_at).toLocaleString()}</div>}
                  {r.customer_approved_at && <div className="sub">✅ {t("customerApprovedLabel", lang)}: {new Date(r.customer_approved_at).toLocaleString()} ({r.customer_approval_method})</div>}
                </div>
                <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span>
              </div>

              {discountPending && (
                <div className="msg info" style={{ marginTop: 8 }}>
                  ⏳ {t("discountApprovalPendingMsg", lang)}
                  {canApprove && (
                    <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                      <button type="button" className="btn btn-primary" disabled={busyId === r.id} onClick={() => decideDiscount(r.id, true)}>✅ {t("approveAction", lang)}</button>
                      <button type="button" className="btn btn-outline" disabled={busyId === r.id} onClick={() => decideDiscount(r.id, false)}>✕ {t("rejectAction", lang)}</button>
                    </div>
                  )}
                </div>
              )}
              {discountRejected && <div className="msg error" style={{ marginTop: 8 }}>✕ {t("discountRejectedMsg", lang)}: {r.discount_rejection_reason}</div>}

              {its.length > 0 && (
                <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                  {its.map((it) => {
                    const isManual = !it.inventory_item_id && !it.product_id;
                    const photoUrl = it.product_image_path ? photoUrls[it.product_image_path] : null;
                    return (
                      <div key={it.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 4px", flexWrap: "wrap", gap: 8, borderBottom: "1px solid var(--border, #eee)" }}>
                        <div className="task-meta" style={{ gap: 8, alignItems: "flex-start" }}>
                          {photoUrl && <img src={photoUrl} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border, #ddd)" }} />}
                          <div>
                            <div style={{ fontWeight: 600 }}>{it.item_name} {it.sku ? `(${it.sku})` : ""}</div>
                            <div className="sub">
                              {it.retail_inventory_items?.serial_number && <>{t("serialLabel", lang)}: {it.retail_inventory_items.serial_number} · </>}
                              {t("quantityLabel", lang)}: {it.quantity} · {t("unitPriceLabel", lang)}: {formatCurrency(it.unit_price)}
                              {it.discount > 0 ? ` · ${t("discountLabel", lang)}: ${formatCurrency(it.discount)}` : ""}
                              {it.tax_amount ? ` · GST: ${formatCurrency(it.tax_amount)}` : ""}
                            </div>
                            {isManual && <div className="fx-tag" style={{ marginTop: 2 }}>✋ {t("manualItemBadgeLabel", lang)}</div>}
                          </div>
                        </div>
                        <div className="task-meta" style={{ gap: 8 }}>
                          <b>{formatCurrency(it.line_total)}</b>
                          {["DRAFT", "SENT"].includes(r.status) && r.is_current_revision && (
                            <button type="button" className="btn btn-outline" style={{ minHeight: 32 }} onClick={() => doRemoveItem(r.id, it.id)}>✕ {t("removeAction", lang) || t("cancel", lang)}</button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="task-meta" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                {canScanAdd && (
                  <button type="button" className="btn btn-outline" onClick={() => openScan(r.id)}>
                    📷 {t("scanQrAddProductAction", lang)}
                  </button>
                )}
                {canScanAdd && (
                  <button type="button" className="btn btn-outline" style={{ opacity: 0.85 }}
                    onClick={() => { setManualItemOpenFor((cur) => (cur === r.id ? null : r.id)); setManualItemMsg(null); }}>
                    ➕ {t("addManualItemAction", lang)}
                  </button>
                )}
                <button type="button" className="btn btn-outline" onClick={() => openPdf(r)}>🖨️ {t("quotationPdfAction", lang)}</button>

                {canApprove && pendingApproval && (
                  <div className="task-meta" style={{ gap: 6 }}>
                    <button type="button" className="btn btn-primary" disabled={busyId === r.id} onClick={() => decideApproval(r.id, true)}>✅ {t("approveAction", lang)}</button>
                    <button type="button" className="btn btn-outline" disabled={busyId === r.id} onClick={() => decideApproval(r.id, false)}>✕ {t("rejectAction", lang)}</button>
                  </div>
                )}

                {["DRAFT", "SENT"].includes(r.status) && !discountPending && !discountRejected && (
                  <button type="button" className="btn btn-outline" onClick={() => togglePanel(r.id, "send")}>📲 {t("sendViaWhatsAppAction", lang)}</button>
                )}
                {r.status === "SENT" && (
                  <>
                    <button type="button" className="btn btn-outline" onClick={() => togglePanel(r.id, "approve")}>✅ {t("recordCustomerApprovalAction", lang)}</button>
                    <button type="button" className="btn btn-outline" onClick={() => togglePanel(r.id, "reject")}>✕ {t("rejectAction", lang)}</button>
                  </>
                )}
                {["SENT", "ACCEPTED"].includes(r.status) && (
                  <button type="button" className="btn btn-outline" disabled={busyId === r.id} onClick={() => createRevision(r.id)}>🔁 {t("createRevisionAction", lang)}</button>
                )}
                {r.status === "ACCEPTED" && !pendingApproval && (
                  <button className="btn btn-outline" disabled={busyId === r.id} onClick={() => convertToOrder(r.id)}>
                    {t("convertToOrder", lang)}
                  </button>
                )}
                {r.status === "ACCEPTED" && pendingApproval && !canApprove && (
                  <span className="sub">{t("awaitingApprovalMsg", lang)}</span>
                )}
              </div>

              {manualItemOpenFor === r.id && (
                <div className="card" style={{ marginTop: 10, background: "var(--surface-2, #faf8f4)" }}>
                  <div className="sub" style={{ marginBottom: 6 }}>✋ {t("manualItemHintMsg", lang)}</div>
                  {manualItemMsg && <div className={`msg ${manualItemMsg.type}`}>{manualItemMsg.text}</div>}
                  <div className="form-grid">
                    <div className="field full"><label>{t("itemNameLabel", lang)} *</label>
                      <input value={manualItemForm.item_name} onChange={(e) => setManualItemForm((f) => ({ ...f, item_name: e.target.value }))} /></div>
                    <div className="field full"><label>{t("descriptionLabel", lang) || t("notesLabel", lang)}</label>
                      <input value={manualItemForm.description} onChange={(e) => setManualItemForm((f) => ({ ...f, description: e.target.value }))} /></div>
                    <div className="field"><label>{t("productCodeOptionalLabel", lang)}</label>
                      <input value={manualItemForm.product_code} onChange={(e) => setManualItemForm((f) => ({ ...f, product_code: e.target.value }))} /></div>
                    <div className="field"><label>{t("quantityLabel", lang)}</label>
                      <input type="number" min="1" value={manualItemForm.quantity} onChange={(e) => setManualItemForm((f) => ({ ...f, quantity: e.target.value }))} /></div>
                    <div className="field"><label>{t("unitPriceLabel", lang)}</label>
                      <input type="number" min="0" value={manualItemForm.unit_price} onChange={(e) => setManualItemForm((f) => ({ ...f, unit_price: e.target.value }))} /></div>
                    <div className="field"><label>{t("discountTypeLabel", lang)}</label>
                      <select value={manualItemForm.discount_type} onChange={(e) => setManualItemForm((f) => ({ ...f, discount_type: e.target.value }))}>
                        <option value="NONE">{t("noDiscountOption", lang)}</option>
                        <option value="FIXED">{t("fixedDiscountOption", lang)}</option>
                        <option value="PERCENT">{t("percentDiscountOption", lang)}</option>
                      </select></div>
                    <div className="field"><label>{t("discountLabel", lang)}</label>
                      <input type="number" min="0" value={manualItemForm.discount} disabled={manualItemForm.discount_type === "NONE"}
                        onChange={(e) => setManualItemForm((f) => ({ ...f, discount: e.target.value }))} /></div>
                    <div className="field"><label>GST %</label>
                      <input type="number" min="0" value={manualItemForm.gst_rate} onChange={(e) => setManualItemForm((f) => ({ ...f, gst_rate: e.target.value }))} /></div>
                    <div className="field full"><label>{t("notesLabel", lang)}</label>
                      <input value={manualItemForm.notes} onChange={(e) => setManualItemForm((f) => ({ ...f, notes: e.target.value }))} /></div>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button type="button" className="btn btn-primary" disabled={manualItemBusy || !manualItemForm.item_name.trim()} onClick={() => submitManualItem(r.id)}>
                      ✅ {t("addToQuotationAction", lang)}
                    </button>
                    <button type="button" className="btn btn-outline" onClick={() => setManualItemOpenFor(null)}>{t("cancel", lang)}</button>
                  </div>
                </div>
              )}

              {panel === "send" && (
                <div className="card" style={{ marginTop: 10, background: "var(--surface-2, #faf8f4)", display: "grid", gap: 10 }}>
                  {msg && <div className={`msg ${msg.type}`}>{msg.text}</div>}
                  <div className="field"><label>{t("whatsAppNumberLabel", lang)}</label>
                    <input value={effectivePhone(r)} onChange={(e) => setPForm(r.id, { phone: e.target.value })} placeholder="+91XXXXXXXXXX" /></div>
                  <div className="sub">{t("step1GeneratePdfHintMsg", lang)}</div>
                  <button type="button" className="btn btn-outline" onClick={() => openPdf(r)}>🖨️ {t("step1GeneratePdfAction", lang)}</button>
                  <div className="sub">{t("step2OpenWhatsappHintMsg", lang)}</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" className="btn btn-outline" onClick={() => openWhatsApp(r)}>📲 {t("openWhatsAppAction", lang)}</button>
                    <button type="button" className="btn btn-primary" disabled={panelBusy === r.id || !effectivePhone(r)} onClick={() => confirmSent(r)}>
                      ✅ {t("confirmSentAction", lang)}
                    </button>
                  </div>
                  <div className="sub">{t("confirmSentHintMsg", lang)}</div>
                </div>
              )}

              {panel === "approve" && (
                <div className="card" style={{ marginTop: 10, background: "var(--surface-2, #faf8f4)", display: "grid", gap: 10 }}>
                  {msg && <div className={`msg ${msg.type}`}>{msg.text}</div>}
                  <div className="field"><label>{t("approvalMethodLabel", lang)}</label>
                    <select value={pf.method || "WHATSAPP_MESSAGE"} onChange={(e) => setPForm(r.id, { method: e.target.value })}>
                      {APPROVAL_METHODS.map((m) => <option key={m} value={m}>{t(`approvalMethod_${m}`, lang)}</option>)}
                    </select></div>
                  <div className="field"><label>{t("approvalNotesLabel", lang)}</label>
                    <input value={pf.notes || ""} onChange={(e) => setPForm(r.id, { notes: e.target.value })} /></div>
                  <button type="button" className="btn btn-primary" disabled={panelBusy === r.id || (pf.method === "MANUAL_NOTE" && !pf.notes?.trim())} onClick={() => submitCustomerApproval(r)}>
                    ✅ {t("recordCustomerApprovalAction", lang)}
                  </button>
                </div>
              )}

              {panel === "reject" && (
                <div className="card" style={{ marginTop: 10, background: "var(--surface-2, #faf8f4)", display: "grid", gap: 10 }}>
                  {msg && <div className={`msg ${msg.type}`}>{msg.text}</div>}
                  <div className="field"><label>{t("rejectionReasonLabel", lang)} *</label>
                    <input value={pf.reason || ""} onChange={(e) => setPForm(r.id, { reason: e.target.value })} /></div>
                  <button type="button" className="btn btn-primary" disabled={panelBusy === r.id || !pf.reason?.trim()} onClick={() => submitReject(r)}>
                    ✕ {t("rejectAction", lang)}
                  </button>
                </div>
              )}

              {scanOpenFor === r.id && (
                <div className="card" style={{ marginTop: 10, background: "var(--surface-2, #faf8f4)" }}>
                  {scanMsg && <div className={`msg ${scanMsg.type}`}>{scanMsg.text}</div>}
                  {!scanPreview ? (
                    <>
                      <div className="sub" style={{ marginBottom: 8 }}>{t("scanToAddLabel", lang)}</div>
                      <QRScanner lang={lang} onDetected={onScanDetected} />
                    </>
                  ) : (
                    <div style={{ display: "grid", gap: 10 }}>
                      <div style={{ fontWeight: 700 }}>{scanPreview.product.name} <span className="sub">({scanPreview.code})</span></div>
                      {scanPreview.product.selling_price != null && (
                        <div className="sub">{t("sellingPriceLabel", lang)}: ₹{scanPreview.product.selling_price}</div>
                      )}
                      <div className="form-grid">
                        <div className="field"><label>{t("quantityLabel", lang)}</label>
                          <input type="number" min="1" value={scanPreview.quantity}
                            onChange={(e) => setScanPreview((p) => ({ ...p, quantity: e.target.value }))} /></div>
                        <div className="field"><label>{t("discountTypeLabel", lang)}</label>
                          <select value={scanPreview.discountType} onChange={(e) => setScanPreview((p) => ({ ...p, discountType: e.target.value }))}>
                            <option value="NONE">{t("noDiscountOption", lang)}</option>
                            <option value="FIXED">{t("fixedDiscountOption", lang)}</option>
                            <option value="PERCENT">{t("percentDiscountOption", lang)}</option>
                          </select></div>
                        <div className="field"><label>{t("discountLabel", lang)}</label>
                          <input type="number" min="0" value={scanPreview.discount} disabled={scanPreview.discountType === "NONE"}
                            onChange={(e) => setScanPreview((p) => ({ ...p, discount: e.target.value }))} /></div>
                        <div className="field"><label>{t("adjustmentTypeLabel", lang)}</label>
                          <select value={scanPreview.adjustmentType} onChange={(e) => setScanPreview((p) => ({ ...p, adjustmentType: e.target.value }))}>
                            <option value="NONE">{t("noAdjustmentOption", lang)}</option>
                            <option value="INCREASE">{t("increaseOption", lang)}</option>
                            <option value="DECREASE">{t("decreaseOption", lang)}</option>
                          </select></div>
                        {scanPreview.adjustmentType !== "NONE" && (
                          <>
                            <div className="field"><label>{t("adjustmentValueLabel", lang)}</label>
                              <input type="number" min="0" value={scanPreview.adjustmentValue}
                                onChange={(e) => setScanPreview((p) => ({ ...p, adjustmentValue: e.target.value }))} /></div>
                            <div className="field full"><label>{t("adjustmentReasonLabel", lang)} *</label>
                              <input value={scanPreview.adjustmentReason} onChange={(e) => setScanPreview((p) => ({ ...p, adjustmentReason: e.target.value }))} /></div>
                          </>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" className="btn btn-primary" disabled={scanBusy} onClick={() => confirmScanAdd(r.id)}>
                          ✅ {t("addToQuotationAction", lang)}
                        </button>
                        <button type="button" className="btn btn-outline" onClick={() => setScanPreview(null)}>{t("cancel", lang)}</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
