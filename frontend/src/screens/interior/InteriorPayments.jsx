import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { formatCurrency, statusBadgeClass } from "../../lib/retailModules";
import { listProjects, listPaymentRecords, addPaymentRecord, markPaymentReceived, notifyDeptLeadership } from "../../lib/interiorApi";

// Payment Follow-up — the ONE Interior card backed by a genuinely new,
// pilot-owned table (interior_payment_records), since the external
// Interior Projects system has no payment ledger at all.
export default function InteriorPayments({ lang, lookups, lockedProjectId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ amount: "", payment_type: "advance", due_date: "" });

  const interiorDept = useMemo(() => lookups.departments.find((d) => d.code === "INTERIOR"), [lookups.departments]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await listProjects();
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    if (data?.length) setProjectId((cur) => cur || lockedProjectId || data[0].id);
    setLoading(false);
  }, [lockedProjectId]);

  useEffect(() => { load(); }, [load]);

  const loadPayments = useCallback(async () => {
    if (!projectId) { setRows([]); return; }
    const { data, error: err } = await listPaymentRecords(projectId);
    if (!err) setRows(data || []);
  }, [projectId]);

  useEffect(() => { loadPayments(); }, [loadPayments]);

  async function handleMarkReceived(id, amount) {
    const { error: err } = await markPaymentReceived(id);
    if (err) return;
    const project = projects.find((p) => p.id === projectId);
    notifyDeptLeadership(
      "INTERIOR", "project", projectId,
      `Payment received: ${formatCurrency(amount)} — ${project ? `${project.project_code} (${project.customer})` : ""}`,
      `ચુકવણી મળી: ${formatCurrency(amount)}`,
    );
    loadPayments();
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!projectId || !form.amount || !interiorDept) return;
    setSaving(true);
    const { error: err } = await addPaymentRecord({
      department_id: interiorDept.id, project_id: projectId, amount: Number(form.amount),
      payment_type: form.payment_type, due_date: form.due_date || null,
    });
    setSaving(false);
    if (err) { setError(true); return; }
    const project = projects.find((p) => p.id === projectId);
    notifyDeptLeadership(
      "INTERIOR", "project", projectId,
      `Payment follow-up added: ${formatCurrency(Number(form.amount))} (${form.payment_type}) — ${project ? `${project.project_code} (${project.customer})` : ""}`,
      `ચુકવણી ફોલો-અપ ઉમેરાયું: ${formatCurrency(Number(form.amount))}`,
    );
    setForm({ amount: "", payment_type: "advance", due_date: "" });
    setShowForm(false);
    loadPayments();
  }

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 60 }} /><div className="skeleton-block" style={{ height: 220 }} /></div>;
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
        <div className="dept-header-icon" aria-hidden="true">💰</div>
        <div className="dept-header-text">
          <h1>{t("interiorPaymentsTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>{t("projectCodeLabel", lang)}</label>
          {lockedProjectId ? (
            <div className="sub" style={{ fontWeight: 700, marginTop: 4 }}>
              {(() => { const p = projects.find((pr) => pr.id === projectId); return p ? `${p.project_code} — ${p.customer}` : "—"; })()}
            </div>
          ) : (
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="card">
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)} disabled={!projectId}>
          {showForm ? t("cancel", lang) : t("addPaymentRecord", lang)}
        </button>
        {showForm && (
          <form onSubmit={handleAdd} className="form-grid" style={{ marginTop: 12 }}>
            <div className="field">
              <label>{t("amountLabel", lang)} *</label>
              <input type="number" min="0" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} required />
            </div>
            <div className="field">
              <label>{t("paymentTypeLabel", lang)}</label>
              <select value={form.payment_type} onChange={(e) => setForm((f) => ({ ...f, payment_type: e.target.value }))}>
                {["advance", "milestone", "final"].map((tOpt) => <option key={tOpt} value={tOpt}>{tOpt}</option>)}
              </select>
            </div>
            <div className="field">
              <label>{t("dueDateLabel", lang)}</label>
              <input type="date" value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} />
            </div>
            <div className="field full">
              <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{r.payment_type} · {t("dueDateLabel", lang)}: {r.due_date || "—"}</span>
            <span>{formatCurrency(r.amount)}</span>
            <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span>
            {r.status !== "RECEIVED" && (
              <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => handleMarkReceived(r.id, r.amount)}>
                {t("receivedLabel", lang)}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
