import React, { useCallback, useEffect, useMemo, useState } from "react";
import { listOrders, listVendors, saveVendor, setVendorStatus } from "../../lib/procurementApi";
import { L, procurementRoles } from "../../lib/procurementRules";
import { subscribeTable } from "../../lib/realtime";
import { friendlyError } from "../../lib/friendlyError";
import { useDebouncedValue } from "../../lib/useDebouncedValue";

const BLANK = { name: "", contact_person: "", mobile: "", email: "", address: "", gstin: "", pan: "", product_service_category: "", payment_terms: "", credit_period: "", lead_time: "", notes: "" };
const FIELDS = [
  ["name", "Company name *", "કંપનીનું નામ *"], ["contact_person", "Contact person", "સંપર્ક વ્યક્તિ"], ["mobile", "Mobile *", "મોબાઇલ *"],
  ["email", "Email", "ઇમેઇલ"], ["gstin", "GSTIN", "GSTIN"], ["pan", "PAN", "PAN"], ["product_service_category", "Products / services", "ઉત્પાદનો / સેવાઓ"],
  ["payment_terms", "Payment terms", "ચુકવણી શરતો"], ["credit_period", "Credit period", "ક્રેડિટ સમય"], ["lead_time", "Usual lead time", "સામાન્ય સમય"],
];

// Central vendor list. Everyone in Procurement can add and edit vendors; only the Procurement Head or Management approve,
// block (with a reason) or reactivate them. Bank details are not shown here (restricted to Procurement Head, Accounts Head, Management).
export default function ProcurementVendors({ lang, profile, lookups }) {
  const roles = useMemo(() => procurementRoles(profile, lookups.departments), [profile, lookups.departments]);
  const canApprove = roles.isProcurementHead || roles.isManagement;
  const canEdit = roles.isProcurement || roles.isManagement;
  const [vendors, setVendors] = useState([]);
  const [orders, setOrders] = useState([]);
  const [state, setState] = useState({ loading: true, error: null });
  const [form, setForm] = useState(null);
  const [editId, setEditId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [reason, setReason] = useState({});
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const q = useDebouncedValue(search, 250).trim().toLowerCase();

  const load = useCallback(async () => {
    const [v, o] = await Promise.all([listVendors(), listOrders({ limit: 2000 })]);
    if (v.error) { setState({ loading: false, error: friendlyError(v.error.message) }); return; }
    setVendors(v.data || []);
    setOrders(o.data || []);
    setState({ loading: false, error: null });
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("procurement-vendors", "vendors", null, () => load()), [load]);

  // Purchase history per vendor, from placed orders.
  const history = useMemo(() => {
    const m = {};
    orders.forEach((o) => { const h = (m[o.vendor_id] ||= { orders: 0, value: 0 }); h.orders += 1; h.value += Number(o.total_order_value || 0); });
    return m;
  }, [orders]);

  const visible = useMemo(() => vendors.filter((v) => {
    if (statusFilter && (statusFilter === "Blocked" ? !v.blacklisted : v.approved_status !== statusFilter || v.blacklisted)) return false;
    if (!q) return true;
    return [v.name, v.vendor_code, v.contact_person, v.mobile, v.gstin, v.product_service_category].filter(Boolean).some((x) => String(x).toLowerCase().includes(q));
  }), [vendors, statusFilter, q]);

  async function act(fn, after) {
    setBusy(true); setMsg(null);
    const { error } = await fn();
    setBusy(false);
    if (error) { setMsg({ kind: "error", text: friendlyError(error.message) }); return; }
    if (after) after();
    load();
  }

  if (state.loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 300 }} /></div>;
  if (state.error) return <div className="dept-dashboard"><div className="msg error">{state.error}</div><button className="btn btn-primary" onClick={load}>{L(lang, "Retry", "ફરી પ્રયાસ")}</button></div>;

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🏢</div>
        <div className="dept-header-text"><h1>{L(lang, "Vendors", "વેન્ડરો")}</h1></div>
        {canEdit && <button className="btn btn-primary" style={{ width: "auto", marginLeft: "auto" }} onClick={() => { setForm(BLANK); setEditId(null); }}>+ {L(lang, "Add vendor", "વેન્ડર ઉમેરો")}</button>}
      </div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}

      {form && (
        <form className="card form-grid" onSubmit={(e) => { e.preventDefault(); act(() => saveVendor(editId, form), () => setForm(null)); }}>
          <h2 className="field full">{editId ? L(lang, "Edit vendor", "વેન્ડર સુધારો") : L(lang, "New vendor", "નવો વેન્ડર")}</h2>
          {FIELDS.map(([k, en, gu]) => (
            <div className="field" key={k}><label>{L(lang, en, gu)}</label><input value={form[k] || ""} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} /></div>
          ))}
          <div className="field full"><label>{L(lang, "Address", "સરનામું")}</label><textarea rows={2} value={form.address || ""} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} /></div>
          <div className="field full"><label>{L(lang, "Notes", "નોંધ")}</label><textarea rows={2} value={form.notes || ""} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
          <div className="field full btn-row">
            <button className="btn btn-primary" type="submit" disabled={busy}>{L(lang, "Save vendor", "વેન્ડર સાચવો")}</button>
            <button className="btn btn-outline" type="button" onClick={() => setForm(null)}>{L(lang, "Cancel", "રદ કરો")}</button>
          </div>
        </form>
      )}

      <div className="card form-grid">
        <div className="field"><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={L(lang, "Search name, code, GSTIN, mobile, products", "નામ, કોડ, GSTIN, મોબાઇલ, ઉત્પાદન શોધો")} /></div>
        <div className="field">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={L(lang, "Status", "સ્થિતિ")}>
            <option value="">{L(lang, "All vendors", "બધા વેન્ડર")}</option>
            <option value="Approved">{L(lang, "Approved", "મંજૂર")}</option>
            <option value="Pending Review">{L(lang, "Pending review", "સમીક્ષા બાકી")}</option>
            <option value="Blocked">{L(lang, "Blocked", "અવરોધિત")}</option>
          </select>
        </div>
      </div>

      <div className="card">
        {visible.length === 0 && <div className="msg info">{L(lang, "No vendors yet.", "હજુ કોઈ વેન્ડર નથી.")}</div>}
        {visible.map((v) => {
          const h = history[v.id];
          return (
            <div key={v.id} className="proc-row">
              <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{v.name} <span className="sub">{v.vendor_code}</span></div>
                <div className="sub">{[v.contact_person, v.mobile, v.email, v.gstin && `GSTIN ${v.gstin}`].filter(Boolean).join(" · ")}</div>
                <div className="sub">{[v.product_service_category, v.payment_terms && `${L(lang, "Terms", "શરતો")}: ${v.payment_terms}`].filter(Boolean).join(" · ")}</div>
                <div className="sub">{h ? `${h.orders} ${L(lang, "orders", "ઓર્ડર")} · Rs ${Math.round(h.value).toLocaleString("en-IN")}` : L(lang, "No orders yet", "હજુ ઓર્ડર નથી")}</div>
                {v.blacklisted && <div className="sub" style={{ color: "var(--danger, #a23434)" }}>{L(lang, "Blocked", "અવરોધિત")}: {v.blacklist_reason}</div>}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span className={`badge ${v.blacklisted ? "RETURNED" : v.approved_status === "Approved" ? "COMPLETED" : "ASSIGNED"}`}>{v.blacklisted ? L(lang, "Blocked", "અવરોધિત") : v.approved_status}</span>
                {canEdit && <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0 }} onClick={() => { setForm({ ...BLANK, ...v }); setEditId(v.id); window.scrollTo({ top: 0 }); }}>{L(lang, "Edit", "સુધારો")}</button>}
                {canApprove && (v.blacklisted || v.approved_status !== "Approved") && (
                  <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0 }} disabled={busy} onClick={() => act(() => setVendorStatus(v.id, "Approved", null))}>
                    {v.blacklisted ? L(lang, "Reactivate", "ફરી સક્રિય") : L(lang, "Approve", "મંજૂર")}
                  </button>
                )}
                {canApprove && !v.blacklisted && (
                  <>
                    <input style={{ width: 170, margin: 0 }} value={reason[v.id] || ""} onChange={(e) => setReason((r) => ({ ...r, [v.id]: e.target.value }))} placeholder={L(lang, "Reason to block", "અવરોધનું કારણ")} />
                    <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0, color: "var(--danger, #a23434)" }} disabled={busy}
                      onClick={() => act(() => setVendorStatus(v.id, "Blocked", reason[v.id]))}>{L(lang, "Block", "અવરોધિત કરો")}</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
