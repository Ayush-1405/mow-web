import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { statusBadgeClass, fetchDepartmentMembers, notifyAssignment } from "../../lib/retailModules";
import { recordFollowUp } from "../../lib/retailApi";
import { subscribeTable } from "../../lib/realtime";
import { exportRowsToExcel } from "../../lib/exportExcel";
import WalkinModal from "./WalkinModal.jsx";

const STATUSES = ["NEW", "FOLLOW_UP", "QUOTED", "CONVERTED", "LOST"];
const FOLLOWUP_STATUSES = ["CONTACTED", "FOLLOW_UP_DUE", "INTERESTED", "QUOTATION_REQUESTED", "QUOTATION_SENT", "NEGOTIATION", "DECISION_PENDING", "WON", "LOST", "NOT_RESPONDING", "ON_HOLD"];
const today = () => new Date().toISOString().slice(0, 10);

// Retail CRM board (retail_leads, extended in mvp_pilot_retail_workflow_v2_93a.sql). "Record Follow-up" goes through
// retail_record_followup() — the CRM timeline entry, the lead status, and the next Today's Tasks reminder all move together; nothing
// here writes a follow-up as a plain insert. Walk-ins are added via the same modal the dashboard's quick action opens.
export default function RetailLeads({ lang, profile, lookups }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlFilter = searchParams.get("filter"); // due_today | overdue (from the dashboard KPI cards)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [members, setMembers] = useState([]);
  const [showWalkin, setShowWalkin] = useState(false);
  const [followUpFor, setFollowUpFor] = useState(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [tempFilter, setTempFilter] = useState("");
  const [search, setSearch] = useState("");

  const retailDept = useMemo(() => lookups.departments.find((d) => d.code === "RETAIL"), [lookups.departments]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [leadsRes, membersRes] = await Promise.all([
      supabase.from("retail_leads").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(300),
      fetchDepartmentMembers(retailDept?.id),
    ]);
    if (leadsRes.error) { setError(true); setLoading(false); return; }
    setRows(leadsRes.data || []);
    setMembers(membersRes);
    setLoading(false);
  }, [retailDept?.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("retail_leads_screen", "retail_leads", null, load), [load]);

  const memberName = useCallback((id) => members.find((m) => m.id === id)?.full_name || "—", [members]);

  const visible = useMemo(() => {
    let list = rows;
    if (urlFilter === "overdue") list = list.filter((r) => r.next_follow_up_date && r.next_follow_up_date < today() && !["CONVERTED", "LOST"].includes(r.status));
    if (urlFilter === "due_today") list = list.filter((r) => r.next_follow_up_date === today() && !["CONVERTED", "LOST"].includes(r.status));
    if (statusFilter) list = list.filter((r) => r.status === statusFilter);
    if (tempFilter) list = list.filter((r) => r.lead_temperature === tempFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((r) => r.customer_name?.toLowerCase().includes(q) || r.phone?.includes(q) || r.walkin_number?.toLowerCase().includes(q));
    }
    return list;
  }, [rows, urlFilter, statusFilter, tempFilter, search]);

  async function exportVisible() {
    const rows = visible.map((r) => ({
      customer_name: r.customer_name, phone: r.phone || "", email: r.email || "", city: r.city || "", source: r.source || "",
      status: r.status, lead_temperature: r.lead_temperature || "", requirement_category: r.requirement_category || "",
      next_follow_up_date: r.next_follow_up_date || "", assigned_to: memberName(r.assigned_to), created_at: r.created_at?.slice(0, 10) || "",
    }));
    await exportRowsToExcel(`retail-leads-${today()}.xlsx`, "Leads", rows);
  }

  async function updateAssignee(id, assignedTo, customerName) {
    const { error: err } = await supabase.from("retail_leads").update({ assigned_to: assignedTo || null }).eq("id", id);
    if (!err) {
      if (assignedTo) notifyAssignment(assignedTo, "retail_lead", id, `Lead assigned to you: ${customerName}`, `તમને લીડ સોંપાયેલ: ${customerName}`);
      load();
    }
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
        <div className="dept-header-icon" aria-hidden="true">🧾</div>
        <div className="dept-header-text"><h1>{t("retailLeadsTitle", lang)}</h1></div>
        <div className="task-meta" style={{ gap: 6, flexWrap: "wrap" }}>
          <button className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={exportVisible}>⬇️ {t("exportAction", lang)}</button>
          <button className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={() => navigate("/retail/import")}>📥 {t("importAction", lang)}</button>
          <button className="btn btn-primary" style={{ width: "auto", marginTop: 0 }} onClick={() => setShowWalkin(true)}>{t("addWalkin", lang)}</button>
        </div>
      </div>

      <div className="card filter-bar filter-grid">
        <div className="field"><label>{t("statusLabel", lang)}</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">{t("allStatuses", lang)}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field"><label>{t("leadTemperatureLabel", lang)}</label>
          <select value={tempFilter} onChange={(e) => setTempFilter(e.target.value)}>
            <option value="">—</option>
            <option value="HOT">🔥 {t("temp_HOT", lang)}</option>
            <option value="WARM">🌤️ {t("temp_WARM", lang)}</option>
            <option value="COLD">❄️ {t("temp_COLD", lang)}</option>
          </select>
        </div>
        <div className="field full"><label>{t("customerSearchLabel", lang)}</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("customerSearchLabel", lang)} />
        </div>
        {(statusFilter || tempFilter || search) && (
          <button type="button" className="btn btn-outline" onClick={() => { setStatusFilter(""); setTempFilter(""); setSearch(""); }}>{t("clearFilters", lang)}</button>
        )}
      </div>

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((r) => {
          const overdue = r.next_follow_up_date && r.next_follow_up_date < today() && !["CONVERTED", "LOST"].includes(r.status);
          return (
            <div key={r.id} className={`retail-lead-row${overdue ? " overdue" : ""}`}>
              <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{r.customer_name} {r.lead_temperature === "HOT" && "🔥"}</div>
                  <div className="sub">{r.phone || "—"} {r.walkin_number ? `· ${r.walkin_number}` : ""} {r.source ? `· ${r.source}` : ""}</div>
                  {r.next_follow_up_date && <div className={overdue ? "sub" : "sub"} style={overdue ? { color: "var(--red, #b3261e)", fontWeight: 600 } : undefined}>
                    {t("nextFollowUpLabel", lang)}: {r.next_follow_up_date} {r.next_follow_up_time || ""}
                  </div>}
                </div>
                <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span>
              </div>
              <div className="task-meta" style={{ gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                <select value={r.assigned_to || ""} onChange={(e) => updateAssignee(r.id, e.target.value, r.customer_name)} title={t("assignedToLabel", lang)}>
                  <option value="">{t("assignedToLabel", lang)}: —</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{memberName(m.id)}</option>)}
                </select>
                {!["CONVERTED", "LOST"].includes(r.status) && (
                  <button type="button" className="btn btn-primary" style={{ width: "auto", marginTop: 0 }} onClick={() => setFollowUpFor(r)}>📞 {t("recordFollowUpAction", lang)}</button>
                )}
                {!["CONVERTED", "LOST"].includes(r.status) && (
                  <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={() => navigate(`/retail/quotations?lead_id=${r.id}`)}>
                    📃 {t("createQuotationAction", lang)}
                  </button>
                )}
                {r.customer_id && (
                  <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={() => navigate(`/retail/customer/${r.customer_id}`)}>🕑 {t("viewTimelineAction", lang)}</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showWalkin && <WalkinModal lang={lang} profile={profile} lookups={lookups} onClose={() => setShowWalkin(false)} onSaved={() => { setShowWalkin(false); load(); }} />}
      {followUpFor && <FollowUpModal lang={lang} lead={followUpFor} onClose={() => setFollowUpFor(null)} onSaved={() => { setFollowUpFor(null); load(); }} />}
    </div>
  );
}

function FollowUpModal({ lang, lead, onClose, onSaved }) {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({
    contactMode: "CALL", outcome: "", customerResponse: "", productsDiscussed: lead.interested_products || "", expectedDecisionDate: "",
    revisedBudget: "", notes: "", nextAction: "", status: "CONTACTED", nextFollowUpDate: "", nextFollowUpTime: "11:00", lostReason: "",
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const needsNext = !["WON", "LOST", "NOT_RESPONDING"].includes(form.status);

  async function save(e) {
    e.preventDefault();
    if (needsNext && !form.nextFollowUpDate) { setError(t("nextFollowUpRequiredMsg", lang)); return; }
    setSaving(true); setError(null);
    const { error: err } = await recordFollowUp(lead.id, {
      contactMode: form.contactMode, outcome: form.outcome || null, customerResponse: form.customerResponse || null, productsDiscussed: form.productsDiscussed || null,
      expectedDecisionDate: form.expectedDecisionDate || null, revisedBudget: form.revisedBudget ? Number(form.revisedBudget) : null, notes: form.notes || null,
      nextAction: form.nextAction || null, status: form.status, lostReason: form.status === "LOST" ? form.lostReason || null : null,
      nextFollowUpAt: needsNext && form.nextFollowUpDate ? `${form.nextFollowUpDate}T${form.nextFollowUpTime}:00` : null,
    });
    setSaving(false);
    if (err) { setError(err.message); return; }
    onSaved?.();
    // "Quotation Requested" is the one outcome that has real next-step work: open the quotation form, already
    // prefilled with this lead's own details — no manual re-entry, matching the follow-up straight into the
    // next real stage instead of leaving the salesperson to remember to do it themselves.
    if (form.status === "QUOTATION_REQUESTED") navigate(`/retail/quotations?lead_id=${lead.id}`);
  }

  return (
    <div className="proof-lightbox" role="dialog" aria-modal="true" aria-label={t("recordFollowUpAction", lang)} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card retail-modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="task-meta" style={{ justifyContent: "space-between" }}>
          <b>📞 {lead.customer_name}</b>
          <button type="button" className="chat-x" aria-label={t("cancel", lang)} onClick={onClose}>×</button>
        </div>
        <form onSubmit={save} className="form-grid">
          <div className="field">
            <label>{t("contactModeLabel", lang)}</label>
            <select value={form.contactMode} onChange={(e) => set("contactMode", e.target.value)}>
              {["CALL", "WHATSAPP", "VISIT", "EMAIL"].map((m) => <option key={m} value={m}>{t(`mode_${m}`, lang)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t("followupStatusLabel", lang)}</label>
            <select value={form.status} onChange={(e) => set("status", e.target.value)}>
              {FOLLOWUP_STATUSES.map((s) => <option key={s} value={s}>{t(`fus_${s}`, lang)}</option>)}
            </select>
          </div>
          <div className="field full"><label>{t("customerResponseLabel", lang)}</label><textarea value={form.customerResponse} onChange={(e) => set("customerResponse", e.target.value)} rows={2} /></div>
          <div className="field"><label>{t("productsDiscussedLabel", lang)}</label><input value={form.productsDiscussed} onChange={(e) => set("productsDiscussed", e.target.value)} /></div>
          <div className="field"><label>{t("revisedBudgetLabel", lang)}</label><input type="number" min="0" value={form.revisedBudget} onChange={(e) => set("revisedBudget", e.target.value)} /></div>
          <div className="field full"><label>{t("nextActionLabel", lang)}</label><input value={form.nextAction} onChange={(e) => set("nextAction", e.target.value)} /></div>
          {form.status === "LOST" && <div className="field full"><label>{t("lostReasonLabel", lang)}</label><input value={form.lostReason} onChange={(e) => set("lostReason", e.target.value)} /></div>}
          {needsNext && (
            <>
              <div className="field"><label>{t("nextFollowUpLabel", lang)} *</label><input type="date" value={form.nextFollowUpDate} onChange={(e) => set("nextFollowUpDate", e.target.value)} required={needsNext} /></div>
              <div className="field"><label>{t("dueTime", lang)}</label><input type="time" value={form.nextFollowUpTime} onChange={(e) => set("nextFollowUpTime", e.target.value)} /></div>
            </>
          )}
          <div className="field full"><label>{t("notesLabel", lang)}</label><textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} /></div>
          {error && <div className="msg error field full" role="alert">{error}</div>}
          <div className="field full"><button className="btn btn-primary" type="submit" disabled={saving}>{saving && <span className="spinner" />}{t("save", lang)}</button></div>
        </form>
      </div>
    </div>
  );
}
