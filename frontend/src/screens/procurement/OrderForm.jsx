import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { createOrder, getOrder, listOrderItems, submitPurchaseRequest, updateOrder, uploadOrderFile } from "../../lib/procurementApi";
import { L, ORDER_PRIORITIES, SETUP_MISSING_TEXT, daysLeft, defaultOrderForm, emptyCustomer, fmtDate, isProcurementSetupMissing, itemAmount, orderTotal, remainingText, toCustomerForm, todayIST, validateCustomer, validateOrder, withDeliveryCopied } from "../../lib/procurementRules";
import CustomerDetailsFields from "./CustomerDetailsFields";
import { friendlyError } from "../../lib/friendlyError";
import { kolkataDateStr } from "../../lib/kolkataTime";
import ProcurementContactCard from "../../components/ProcurementContactCard";

const BLANK_ITEM = { item_code: "", description: "", qty_size: "", quantity: "", rate: "", remarks: "" };
const money = (n) => (n === null ? "" : `Rs ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// A department's ORDER page: one Production Supply Order with many lines. It goes to the department's Head, then to
// Procurement (proc_create_order). Interior orders default to the compact Interior form, everyone else to the Retail form.
export default function OrderForm({ lang, profile, lookups }) {
  const navigate = useNavigate();
  const { id: editId } = useParams();
  const [params] = useSearchParams();
  const department = lookups.departmentById?.[profile.department_id];
  const isInterior = department?.code === "INTERIOR";
  const [header, setHeader] = useState({
    form_type: defaultOrderForm(department?.code), project_id: params.get("project") || "", client_name: "", sales_person_name: "", vendor_name: "",
    required_completion_date: "", delivery_date: "", delivery_location: "", remarks: "", priority: "NORMAL", urgency_reason: "",
  });
  const [createdAt, setCreatedAt] = useState(null);
  const [customer, setCustomer] = useState(emptyCustomer());
  const [hadCustomer, setHadCustomer] = useState(false);
  const [wasEmergency, setWasEmergency] = useState(false);
  const [items, setItems] = useState([{ ...BLANK_ITEM }, { ...BLANK_ITEM }, { ...BLANK_ITEM }]);
  const [files, setFiles] = useState([]);
  const [projects, setProjects] = useState([]);
  const [errors, setErrors] = useState({});
  const [customerErrors, setCustomerErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!!editId);

  const headName = useMemo(() => {
    const d = lookups.departmentById?.[profile.department_id];
    return d ? (lang === "gu" ? d.name_gu : d.name_en) : "—";
  }, [lookups.departmentById, profile.department_id, lang]);
  const total = orderTotal(items);
  const retail = header.form_type === "RETAIL";

  useEffect(() => {
    if (!isInterior && !header.project_id) return undefined;
    let alive = true;
    supabase.rpc("staff_list_interior_project_options").then(({ data }) => { if (alive) setProjects(data || []); });
    return () => { alive = false; };
  }, [isInterior, header.project_id]);

  useEffect(() => {
    if (!editId) return undefined;
    let alive = true;
    Promise.all([getOrder(editId), listOrderItems(editId)]).then(([o, it]) => {
      if (!alive) return;
      const d = o.data;
      if (d) {
        setHeader({
          form_type: d.order_form_type || "RETAIL", project_id: d.project_id || "", client_name: d.client_name || "", sales_person_name: d.sales_person_name || "",
          vendor_name: d.preferred_vendor_name || "", required_completion_date: d.required_by_date || "", delivery_date: d.delivery_date || "",
          delivery_location: d.delivery_location || "", remarks: d.remarks || "",
          priority: d.is_emergency ? "EMERGENCY" : (ORDER_PRIORITIES.some((x) => x.code === d.priority) ? d.priority : "NORMAL"),
          urgency_reason: d.urgency_reason || d.emergency_reason || "",
        });
        setCreatedAt(d.created_at || null);
        setCustomer(d.customer ? { ...toCustomerForm(d.customer), retail_customer_id: d.retail_customer_id || null } : { ...emptyCustomer(), name: d.client_name || "" });
        setHadCustomer(!!d.customer);
        setWasEmergency(!!d.is_emergency);
        setItems([...(it.data || []).map((x) => ({ item_code: x.item_code || "", description: x.description || "", qty_size: x.qty_size || "", quantity: x.quantity ?? "", rate: x.rate ?? "", remarks: x.line_remarks || "" })), { ...BLANK_ITEM }]);
      }
      setLoading(false);
    });
    return () => { alive = false; };
  }, [editId]);

  // When a project is picked, its customer and site fill the client and delivery fields (still editable).
  useEffect(() => {
    const p = projects.find((x) => x.id === header.project_id);
    if (!p || editId) return;
    setHeader((h) => ({ ...h, client_name: h.client_name || p.customer || "", delivery_location: h.delivery_location || p.location || "" }));
    setCustomer((c) => (c.name ? c : { ...c, name: p.customer || "" }));
  }, [header.project_id, projects, editId]);

  const setH = (k) => (e) => { const v = e.target.type === "checkbox" ? e.target.checked : e.target.value; setHeader((h) => ({ ...h, [k]: v })); setErrors((x) => ({ ...x, [k]: undefined })); };
  const setItem = (n, k) => (e) => { const v = e.target.value; setItems((list) => list.map((it, i) => (i === n ? { ...it, [k]: v } : it))); setErrors((x) => ({ ...x, items: undefined })); };

  async function save(submit) {
    const { errors: found, items: filled } = validateOrder(header, items);
    if (header.required_completion_date && header.required_completion_date < kolkataDateStr()) found.required_completion_date = "past";
    if (isInterior && !header.project_id && !customer.name.trim()) found.client_name = "required";
    const custErrors = validateCustomer(customer);
    setCustomerErrors(custErrors);
    if (Object.keys(custErrors).length) found.customer = "invalid";
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    setServerError(null);
    let id = editId;
    let res;
    const named = customer.name.trim();
    const payload = { ...header, client_name: named || header.client_name,
      customer: named ? withDeliveryCopied(customer) : (hadCustomer ? { name: "" } : undefined) };
    if (editId) {
      res = await updateOrder(editId, payload, filled);
      if (!res.error && submit) res = await submitPurchaseRequest(editId);
    } else {
      res = await createOrder(payload, filled, { submit });
      id = res.data?.id;
    }
    if (res.error) {
      setSaving(false);
      setServerError(isProcurementSetupMissing(res.error) ? L(lang, ...SETUP_MISSING_TEXT) : friendlyError(res.error.message));
      return;
    }
    const failed = [];
    for (const f of files) {
      const { error } = await uploadOrderFile(id, f);
      if (error) failed.push(f.name);
    }
    setSaving(false);
    navigate(`/purchase-requests/${id}`, { replace: true, state: failed.length ? { uploadFailed: failed } : null });
  }

  const errText = (k) => {
    const e = errors[k];
    if (!e) return null;
    const text = e === "past" ? L(lang, "Cannot be in the past", "ભૂતકાળની તારીખ ન હોઈ શકે")
      : e === "beforeCompletion" ? L(lang, "Cannot be before the completion date", "તૈયાર તારીખ પહેલાં ન હોઈ શકે")
      : e === "noItems" ? L(lang, "Add at least one item", "ઓછામાં ઓછી એક આઇટમ ઉમેરો")
      : String(e).startsWith("row:") ? L(lang, `Line ${e.slice(4)}: description and qty / size are required; rate and quantity must be numbers`, `લાઇન ${e.slice(4)}: વર્ણન અને જથ્થો / માપ જરૂરી; ભાવ અને જથ્થો આંકડા હોવા જોઈએ`)
      : L(lang, "Required", "જરૂરી");
    return <div className="sub" style={{ color: "var(--danger, #a23434)" }}>{text}</div>;
  };

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 300 }} /></div>;

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📝</div>
        <div className="dept-header-text">
          <h1>{editId ? L(lang, "Edit order", "ઓર્ડર સુધારો") : L(lang, "New order", "નવો ઓર્ડર")}</h1>
          <div className="sub">{L(lang, "Production Supply Order Form. Goes to your Department Head, then to Procurement.", "પ્રોડક્શન સપ્લાય ઓર્ડર ફોર્મ. પહેલા વિભાગના વડા પાસે, પછી ખરીદી વિભાગને.")}</div>
        </div>
      </div>

      <form className="card form-grid" onSubmit={(e) => { e.preventDefault(); save(true); }} noValidate>
        <div className="field">
          <label>{L(lang, "Order form", "ઓર્ડર ફોર્મ")}</label>
          <select value={header.form_type} onChange={setH("form_type")}>
            <option value="INTERIOR">{L(lang, "Interior (compact)", "ઇન્ટિરિયર (નાનું)")}</option>
            <option value="RETAIL">{L(lang, "Retail (with rate & amount)", "રિટેલ (ભાવ અને રકમ સાથે)")}</option>
          </select>
        </div>
        <div className="field"><label>{L(lang, "Ordered by", "ઓર્ડર આપનાર")}</label><input value={`${profile.full_name} — ${headName}`} readOnly /></div>
        <div className="field"><label>{L(lang, "Order creation date (automatic)", "ઓર્ડર તારીખ (આપોઆપ)")}</label><input value={fmtDate(createdAt || todayIST())} readOnly /></div>
        {(isInterior || header.project_id) && (
          <div className="field">
            <label>{L(lang, "Project", "પ્રોજેક્ટ")}</label>
            <select value={header.project_id} onChange={setH("project_id")} disabled={!!editId}>
              <option value="">{L(lang, "— No project —", "— પ્રોજેક્ટ વગર —")}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          </div>
        )}
        <CustomerDetailsFields lang={lang} value={customer} onChange={(c) => { setCustomer(c); setCustomerErrors({}); setErrors((x) => ({ ...x, customer: undefined, client_name: undefined })); }}
          errors={{ ...customerErrors, ...(errors.client_name ? { name: "required" } : {}) }} nameRequired={isInterior && !header.project_id} />
        <div className="field"><label>{L(lang, "Sales person", "સેલ્સ પર્સન")}</label><input value={header.sales_person_name} onChange={setH("sales_person_name")} /></div>
        <div className="field"><label>{L(lang, "Vendor (if known)", "વેન્ડર (જો ખબર હોય)")}</label><input value={header.vendor_name} onChange={setH("vendor_name")} /></div>
        <div className="field">
          <label>{L(lang, "Required due date (delivery / completion)", "જરૂરી ડ્યુ તારીખ (ડિલિવરી / પૂર્ણ)")} *</label>
          <input type="date" min={kolkataDateStr()} value={header.required_completion_date} onChange={setH("required_completion_date")} />
          {header.required_completion_date && !errors.required_completion_date && (
            <div className="sub">{fmtDate(header.required_completion_date)} · {remainingText(daysLeft(header.required_completion_date), lang)}</div>
          )}
          {errText("required_completion_date")}
        </div>
        <div className="field"><label>{L(lang, "Delivery date", "ડિલિવરી તારીખ")}</label><input type="date" value={header.delivery_date} onChange={setH("delivery_date")} />{errText("delivery_date")}</div>
        <div className="field">
          <label>{L(lang, "Priority", "પ્રાથમિકતા")}</label>
          {/* Emergency decides who approves (Management first), so it can only be chosen on a new order. */}
          <select value={header.priority} onChange={setH("priority")} disabled={!!editId && wasEmergency}>
            {ORDER_PRIORITIES.filter((p) => !editId || (wasEmergency ? p.code === "EMERGENCY" : p.code !== "EMERGENCY"))
              .map((p) => <option key={p.code} value={p.code}>{lang === "gu" ? p.gu : p.en}</option>)}
          </select>
          {header.priority === "EMERGENCY" && <div className="sub">{L(lang, "Goes to Management for approval first.", "પહેલા મેનેજમેન્ટની મંજૂરી માટે જશે.")}</div>}
        </div>
        {header.priority !== "NORMAL" && (
          <div className="field full">
            <label>{L(lang, "Reason for urgency", "તાત્કાલિકતાનું કારણ")}{["URGENT", "EMERGENCY"].includes(header.priority) && " *"}</label>
            <textarea rows={2} value={header.urgency_reason} onChange={setH("urgency_reason")} placeholder={L(lang, "Why is it needed by this date?", "આ તારીખ સુધી કેમ જરૂરી છે?")} />
            {errText("urgency_reason")}
          </div>
        )}
        <div className="field full"><label>{L(lang, "Delivery location", "ડિલિવરી સ્થળ")} *</label><input value={header.delivery_location} onChange={setH("delivery_location")} />{errText("delivery_location")}</div>

        <div className="field full">
          <label>{L(lang, "Production item details", "પ્રોડક્શન આઇટમ વિગત")} *</label>
          <div className="proc-table-wrap">
            <table className="proc-table order-items">
              <thead>
                <tr>
                  <th>#</th><th>{L(lang, "Item code", "આઇટમ કોડ")}</th><th>{L(lang, "Description", "વર્ણન")} *</th><th>{L(lang, "Qty / size", "જથ્થો / માપ")} *</th>
                  {retail ? <><th>{L(lang, "Qty (no.)", "જથ્થો (સંખ્યા)")}</th><th>{L(lang, "Rate (Rs)", "ભાવ (રૂ.)")}</th><th style={{ textAlign: "right" }}>{L(lang, "Amount", "રકમ")}</th></>
                    : <th>{L(lang, "Remarks", "નોંધ")}</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((it, n) => (
                  <tr key={n}>
                    <td>{n + 1}</td>
                    <td><input value={it.item_code} onChange={setItem(n, "item_code")} style={{ minWidth: 80 }} aria-label={`Item ${n + 1} code`} /></td>
                    <td><input value={it.description} onChange={setItem(n, "description")} style={{ minWidth: 200 }} aria-label={`Item ${n + 1} description`} /></td>
                    <td><input value={it.qty_size} onChange={setItem(n, "qty_size")} style={{ minWidth: 110 }} placeholder={L(lang, "e.g. 2 nos, 6x3 ft", "દા.ત. 2 નંગ, 6x3 ફૂટ")} aria-label={`Item ${n + 1} quantity or size`} /></td>
                    {!retail && <td><input value={it.remarks} onChange={setItem(n, "remarks")} style={{ minWidth: 140 }} aria-label={`Item ${n + 1} remarks`} /></td>}
                    {retail && (
                      <>
                        <td><input type="number" min="0" step="any" inputMode="decimal" value={it.quantity} onChange={setItem(n, "quantity")} style={{ width: 80 }} aria-label={`Item ${n + 1} quantity`} /></td>
                        <td><input type="number" min="0" step="any" inputMode="decimal" value={it.rate} onChange={setItem(n, "rate")} style={{ width: 100 }} aria-label={`Item ${n + 1} rate`} /></td>
                        <td style={{ textAlign: "right" }}>{money(itemAmount(it))}</td>
                      </>
                    )}
                    <td>{items.length > 1 && <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0 }} onClick={() => setItems((l) => l.filter((_, i) => i !== n))} aria-label={`Remove line ${n + 1}`}>✕</button>}</td>
                  </tr>
                ))}
                {retail && total !== null && (
                  <tr><td colSpan={6} style={{ textAlign: "right", fontWeight: 700 }}>{L(lang, "Total", "કુલ")}</td><td style={{ textAlign: "right", fontWeight: 700 }}>{money(total)}</td><td /></tr>
                )}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 6 }} onClick={() => setItems((l) => [...l, { ...BLANK_ITEM }])}>+ {L(lang, "Add line", "લાઇન ઉમેરો")}</button>
          {errText("items")}
        </div>

        <div className="field full"><label>{L(lang, "Remarks", "નોંધ")}</label><textarea rows={2} value={header.remarks} onChange={setH("remarks")} /></div>
        <div className="field full">
          <label>{L(lang, "Drawings / attachments (PDF, images, DWG)", "ડ્રોઇંગ / જોડાણ (PDF, ફોટા, DWG)")}</label>
          <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.dwg,.dxf"
            onChange={(e) => { const picked = Array.from(e.target.files || []); setFiles((l) => [...l, ...picked]); e.target.value = ""; }} />
          <SelectedFiles files={files} lang={lang} onRemove={(n) => setFiles((l) => l.filter((_, i) => i !== n))} />
        </div>
        {serverError && <div className="msg error field full">{serverError}</div>}
        <div className="field full btn-row">
          <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? L(lang, "Sending…", "મોકલાય છે…") : L(lang, "Send for approval", "મંજૂરી માટે મોકલો")}</button>
          <button className="btn btn-outline" type="button" disabled={saving} onClick={() => save(false)}>{L(lang, "Save as draft", "ડ્રાફ્ટ સાચવો")}</button>
          <button className="btn btn-outline" type="button" disabled={saving} onClick={() => navigate(-1)}>{L(lang, "Cancel", "રદ કરો")}</button>
        </div>
      </form>

      <ProcurementContactCard lang={lang} profile={profile} />
    </div>
  );
}

// Files chosen but not yet uploaded: photos show as thumbnails, each can be removed before the order is sent.
function SelectedFiles({ files, lang, onRemove }) {
  const [previews, setPreviews] = useState([]);
  useEffect(() => {
    const urls = files.map((f) => (/^image\/(jpeg|png|webp|gif|bmp)$/i.test(f.type) ? URL.createObjectURL(f) : null));
    setPreviews(urls);
    return () => urls.forEach((u) => u && URL.revokeObjectURL(u));
  }, [files]);
  if (!files.length) return null;
  return (
    <div className="att-grid">
      {files.map((f, n) => (
        <div key={`${f.name}-${f.size}-${n}`} className="att-tile" style={{ cursor: "default" }}>
          {previews[n] ? <img src={previews[n]} alt={f.name} /> : <span className="att-icon">{/pdf/i.test(f.type) ? "📄" : "📐"}</span>}
          <span className="att-name">{f.name}</span>
          <button type="button" className="att-remove" onClick={() => onRemove(n)} aria-label={L(lang, `Remove ${f.name}`, `${f.name} દૂર કરો`)}>✕</button>
        </div>
      ))}
    </div>
  );
}
