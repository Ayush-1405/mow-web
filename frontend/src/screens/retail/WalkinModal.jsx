import React, { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { createWalkin, checkDuplicateCustomer, requestCustomerAccess } from "../../lib/retailApi";
import { fetchDepartmentMembers } from "../../lib/retailModules";

const REQUIREMENTS = ["LOOSE_FURNITURE", "SOFA", "BED", "DINING", "OFFICE_FURNITURE", "MODULAR_KITCHEN", "WARDROBE", "COMPLETE_INTERIOR", "BULK_CORPORATE", "CUSTOMIZED", "OTHER"];
const TEMPS = ["HOT", "WARM", "COLD"];

// Fast, mobile-first Walk-in intake. On save: retail_create_walkin() upserts the customer (deduped by phone), creates the lead, and
// schedules the first follow-up as a REAL Today's Tasks row — see mvp_pilot_retail_workflow_v2_93b.sql. Nothing here writes a table
// directly; the RPC is the only path, so a half-saved walk-in (customer created, lead not) can never happen.
export default function WalkinModal({ lang, profile, lookups, onClose, onSaved }) {
  const retailDept = lookups.departments.find((d) => d.code === "RETAIL");
  const [members, setMembers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [duplicates, setDuplicates] = useState([]);
  const [checkingDup, setCheckingDup] = useState(false);
  const [requestedIds, setRequestedIds] = useState([]);
  const [forceCreate, setForceCreate] = useState(false);
  const now = new Date();
  const [form, setForm] = useState({
    customerName: "", phone: "", whatsapp: "", email: "", city: "", requirementCategory: "", interestedProducts: "",
    roomCategory: "", approxBudget: "", purchaseTimeline: "", leadSource: "walkin", salesperson: profile.id, customerType: "RETAIL",
    notes: "", leadTemperature: "WARM",
    nextFollowUpDate: new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10), nextFollowUpTime: "11:00",
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => { fetchDepartmentMembers(retailDept?.id).then(setMembers); }, [retailDept?.id]);

  // Duplicate-customer protection (v2_93h §3): exact-normalized phone/WhatsApp/email/name+city match, checked before create —
  // never a silent second customer. retail_check_duplicate_customer() itself withholds contact details unless the caller already
  // has access, so this UI only ever shows what the RPC decided to reveal.
  async function runDuplicateCheck() {
    if (!form.phone.trim() && !form.whatsapp.trim() && !form.email.trim() && !(form.customerName.trim() && form.city.trim())) return;
    setCheckingDup(true);
    const { data } = await checkDuplicateCustomer(form.customerName.trim(), form.phone.trim(), form.whatsapp.trim(), form.email.trim(), form.city.trim());
    setCheckingDup(false);
    setDuplicates(data || []);
    setForceCreate(false);
  }

  async function doRequestAccess(customerId) {
    const reason = window.prompt(t("reasonLabel", lang));
    if (!reason) return;
    const { error: err } = await requestCustomerAccess(customerId, reason);
    if (!err) setRequestedIds((ids) => [...ids, customerId]);
  }

  const blockingDuplicates = duplicates.filter((d) => !requestedIds.includes(d.customer_id));

  async function save(e) {
    e.preventDefault();
    if (!form.customerName.trim()) return;
    if (blockingDuplicates.length > 0 && !forceCreate) return;
    setSaving(true); setError(null);
    const { data, error: err } = await createWalkin({
      customerName: form.customerName.trim(), phone: form.phone || null, whatsapp: form.whatsapp || form.phone || null, email: form.email || null,
      city: form.city || null, requirementCategory: form.requirementCategory || null, interestedProducts: form.interestedProducts || null,
      roomCategory: form.roomCategory || null, approxBudget: form.approxBudget ? Number(form.approxBudget) : null, purchaseTimeline: form.purchaseTimeline || null,
      leadSource: form.leadSource, salesperson: form.salesperson || profile.id, customerType: form.customerType, notes: form.notes || null,
      leadTemperature: form.leadTemperature, nextFollowUpAt: `${form.nextFollowUpDate}T${form.nextFollowUpTime}:00`,
    });
    setSaving(false);
    if (err) { setError(err.message); return; }
    onSaved?.(data);
  }

  return (
    <div className="proof-lightbox" role="dialog" aria-modal="true" aria-label={t("addWalkin", lang)} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card retail-modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="task-meta" style={{ justifyContent: "space-between" }}>
          <b>🚶 {t("addWalkin", lang)}</b>
          <button type="button" className="chat-x" aria-label={t("cancel", lang)} onClick={onClose}>×</button>
        </div>
        <form onSubmit={save} className="form-grid">
          <div className="field full"><label>{t("customerNameLabel", lang)} *</label><input value={form.customerName} onChange={(e) => set("customerName", e.target.value)} onBlur={runDuplicateCheck} required maxLength={120} /></div>
          <div className="field"><label>{t("phoneLabel", lang)}</label><input inputMode="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} onBlur={runDuplicateCheck} /></div>
          <div className="field"><label>{t("whatsappLabel", lang)}</label><input inputMode="tel" value={form.whatsapp} onChange={(e) => set("whatsapp", e.target.value)} onBlur={runDuplicateCheck} placeholder={form.phone} /></div>
          <div className="field"><label>{t("emailLabel", lang)}</label><input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} onBlur={runDuplicateCheck} /></div>
          <div className="field"><label>{t("cityLabel", lang)}</label><input value={form.city} onChange={(e) => set("city", e.target.value)} onBlur={runDuplicateCheck} /></div>

          {checkingDup && <div className="field full sub">{t("checkingDuplicatesLabel", lang)}…</div>}
          {duplicates.length > 0 && (
            <div className="field full" style={{ display: "grid", gap: 6 }}>
              {duplicates.map((d) => (
                <div key={d.customer_id} className="msg warning" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div>
                    <div><strong>{t("possibleDuplicateLabel", lang)}:</strong> {d.full_name} {d.city ? `— ${d.city}` : ""}</div>
                    <div className="sub">{t("ownedByLabel", lang)}: {d.owner_name} · {d.match_reason}</div>
                  </div>
                  {requestedIds.includes(d.customer_id) ? (
                    <span className="badge">{t("accessRequestedLabel", lang)}</span>
                  ) : (
                    <button type="button" className="btn btn-outline" onClick={() => doRequestAccess(d.customer_id)}>{t("requestAccessAction", lang)}</button>
                  )}
                </div>
              ))}
              {!forceCreate && (
                <button type="button" className="btn btn-outline" onClick={() => setForceCreate(true)}>{t("createAsNewAnywayAction", lang)}</button>
              )}
            </div>
          )}
          <div className="field">
            <label>{t("requirementCategoryLabel", lang)}</label>
            <select value={form.requirementCategory} onChange={(e) => set("requirementCategory", e.target.value)}>
              <option value="">—</option>
              {REQUIREMENTS.map((r) => <option key={r} value={r}>{t(`req_${r}`, lang)}</option>)}
            </select>
          </div>
          <div className="field"><label>{t("interestedProductsLabel", lang)}</label><input value={form.interestedProducts} onChange={(e) => set("interestedProducts", e.target.value)} /></div>
          <div className="field"><label>{t("roomCategoryLabel", lang)}</label><input value={form.roomCategory} onChange={(e) => set("roomCategory", e.target.value)} /></div>
          <div className="field"><label>{t("approxBudgetLabel", lang)}</label><input type="number" min="0" inputMode="decimal" value={form.approxBudget} onChange={(e) => set("approxBudget", e.target.value)} /></div>
          <div className="field"><label>{t("purchaseTimelineLabel", lang)}</label><input value={form.purchaseTimeline} onChange={(e) => set("purchaseTimeline", e.target.value)} placeholder="e.g. 2 weeks" /></div>
          <div className="field">
            <label>{t("leadSourceLabel", lang)}</label>
            <select value={form.leadSource} onChange={(e) => set("leadSource", e.target.value)}>
              {["walkin", "phone", "referral", "social_media", "website", "exhibition", "other"].map((s) => <option key={s} value={s}>{t(`src_${s}`, lang)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t("salespersonLabel", lang)}</label>
            <select value={form.salesperson} onChange={(e) => set("salesperson", e.target.value)}>
              {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t("leadTemperatureLabel", lang)}</label>
            <div className="fx-seg" role="radiogroup">
              {TEMPS.map((tp) => (
                <button key={tp} type="button" role="radio" aria-checked={form.leadTemperature === tp} className={form.leadTemperature === tp ? "on" : ""} onClick={() => set("leadTemperature", tp)}>
                  {tp === "HOT" ? "🔥" : tp === "WARM" ? "🌤️" : "❄️"} {t(`temp_${tp}`, lang)}
                </button>
              ))}
            </div>
          </div>
          <div className="field"><label>{t("nextFollowUpLabel", lang)} *</label><input type="date" value={form.nextFollowUpDate} onChange={(e) => set("nextFollowUpDate", e.target.value)} required /></div>
          <div className="field"><label>{t("dueTime", lang)}</label><input type="time" value={form.nextFollowUpTime} onChange={(e) => set("nextFollowUpTime", e.target.value)} /></div>
          <div className="field full"><label>{t("notesLabel", lang)}</label><textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} /></div>
          {error && <div className="msg error field full" role="alert">{error}</div>}
          <div className="field full">
            <button className="btn btn-primary" type="submit" disabled={saving || (blockingDuplicates.length > 0 && !forceCreate)}>{saving && <span className="spinner" />}{t("save", lang)}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
