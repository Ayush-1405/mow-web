import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import {
  listMaterialRequests, createMaterialRequest, updateMaterialRequestStatus, subscribeMaterialRequests,
  searchJobCards,
} from "../../lib/factoryApi";
import ProofPhotoUpload from "../../components/ProofPhotoUpload.jsx";
import ProofPhotoViewer from "../../components/ProofPhotoViewer.jsx";

const PRIORITIES = ["Normal", "High", "Urgent", "Emergency"];
const STATUSES = ["REQUESTED", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"];
const STATUS_BADGE = {
  REQUESTED: "ASSIGNED", ORDERED: "IN_PROGRESS", PARTIALLY_RECEIVED: "IN_PROGRESS", RECEIVED: "VERIFIED", CANCELLED: "RETURNED",
};
const emptyForm = { material: "", requestingDepartmentId: "", orderPoReference: "", priority: "Normal", requiredDate: "", quantity: "", unit: "Nos", jobCardId: "", jobCardLabel: "", supplier: "", notes: "" };

// "Material to Order" (handwritten workflow, column 1) -- a real, dedicated request, never a second free-text note
// buried inside a Job Card. Minimal typing: job-card search auto-fills nothing the worker doesn't already know,
// and the requesting department defaults to Factory itself.
export default function FactoryMaterialToOrder({ lang, lookups }) {
  const [tab, setTab] = useState("open");
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [newId, setNewId] = useState(null); // id of the just-created request, for the photo-upload step
  const [jobQuery, setJobQuery] = useState("");
  const [jobResults, setJobResults] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const factoryDept = lookups?.departments?.find((d) => d.code === "FACTORY");

  const load = useCallback(async () => {
    const { data, error: err } = await listMaterialRequests({ tab });
    if (err) { setError(true); return; }
    setError(false);
    setRows(data || []);
  }, [tab]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeMaterialRequests("fx-material-to-order", load), [load]);

  useEffect(() => {
    if (factoryDept && !form.requestingDepartmentId) setForm((f) => ({ ...f, requestingDepartmentId: factoryDept.id }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factoryDept]);

  useEffect(() => {
    if (!jobQuery.trim()) { setJobResults([]); return; }
    const handle = setTimeout(async () => {
      const { data } = await searchJobCards(jobQuery, false);
      setJobResults(data || []);
    }, 300);
    return () => clearTimeout(handle);
  }, [jobQuery]);

  function pickJob(job) {
    setForm((f) => ({ ...f, jobCardId: job.id, jobCardLabel: `${job.job_order_number} · ${job.product_item || ""}` }));
    setJobQuery("");
    setJobResults([]);
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.material.trim() || !form.requestingDepartmentId || !(Number(form.quantity) > 0)) return;
    setSaving(true);
    setSaveMsg(null);
    const { data, error: err } = await createMaterialRequest({
      material: form.material.trim(), requestingDepartmentId: form.requestingDepartmentId, quantity: Number(form.quantity),
      unit: form.unit, orderPoReference: form.orderPoReference || null, priority: form.priority, requiredDate: form.requiredDate || null,
      jobCardId: form.jobCardId || null, supplier: form.supplier || null, notes: form.notes || null,
    });
    setSaving(false);
    if (err) { setSaveMsg({ type: "error", text: err.message }); return; }
    setNewId(data.id);
    setSaveMsg({ type: "success", text: `${t("requestNumberLabel", lang)}: ${data.request_number}` });
    setForm({ ...emptyForm, requestingDepartmentId: factoryDept?.id || "" });
    load();
  }

  async function changeStatus(id, status) {
    setBusyId(id);
    const { error: err } = await updateMaterialRequestStatus(id, status, null);
    setBusyId(null);
    if (err) { setError(true); return; }
    load();
  }

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🧱</div>
        <div className="dept-header-text"><h1>{t("materialToOrderTitle", lang)}</h1></div>
      </div>

      <div className="card">
        <button type="button" className="btn btn-primary" style={{ minHeight: 48, fontSize: 16 }} onClick={() => { setShowForm((s) => !s); setSaveMsg(null); setNewId(null); }}>
          {showForm ? t("cancel", lang) : `➕ ${t("requestMaterialAction", lang)}`}
        </button>

        {showForm && (
          <form onSubmit={submit} className="form-grid" style={{ marginTop: 12 }}>
            {saveMsg && <div className={`msg ${saveMsg.type}`} style={{ gridColumn: "1 / -1" }}>{saveMsg.text}</div>}
            <div className="field full">
              <label>{t("materialLabel", lang)} *</label>
              <input value={form.material} onChange={(e) => setForm((f) => ({ ...f, material: e.target.value }))} style={{ minHeight: 48, fontSize: 16 }} required />
            </div>
            <div className="field">
              <label>{t("requestingDepartmentLabel", lang)} *</label>
              <select value={form.requestingDepartmentId} onChange={(e) => setForm((f) => ({ ...f, requestingDepartmentId: e.target.value }))} style={{ minHeight: 48 }} required>
                <option value="">—</option>
                {(lookups?.departments || []).map((d) => <option key={d.id} value={d.id}>{lang === "gu" ? d.name_gu : d.name_en}</option>)}
              </select>
            </div>
            <div className="field">
              <label>{t("orderPoReferenceLabel", lang)}</label>
              <input value={form.orderPoReference} onChange={(e) => setForm((f) => ({ ...f, orderPoReference: e.target.value }))} style={{ minHeight: 48, fontSize: 16 }} />
            </div>
            <div className="field">
              <label>{t("quantityLabel", lang)} *</label>
              <input type="number" min="0.01" step="0.01" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} style={{ minHeight: 48, fontSize: 16 }} required />
            </div>
            <div className="field">
              <label>{t("unitLabel", lang)}</label>
              <input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} style={{ minHeight: 48, fontSize: 16 }} />
            </div>
            <div className="field">
              <label>{t("priorityLabel", lang)}</label>
              <select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))} style={{ minHeight: 48 }}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="field">
              <label>{t("requiredDateLabel", lang)}</label>
              <input type="date" value={form.requiredDate} onChange={(e) => setForm((f) => ({ ...f, requiredDate: e.target.value }))} style={{ minHeight: 48, fontSize: 16 }} />
            </div>
            <div className="field full">
              <label>{t("relatedJobCardLabel", lang)}</label>
              {form.jobCardLabel ? (
                <div className="task-meta" style={{ justifyContent: "space-between", background: "var(--surface-2, #faf8f4)", padding: "8px 10px", borderRadius: 8 }}>
                  <span>{form.jobCardLabel}</span>
                  <button type="button" className="btn btn-outline" onClick={() => setForm((f) => ({ ...f, jobCardId: "", jobCardLabel: "" }))}>{t("changeAction", lang)}</button>
                </div>
              ) : (
                <>
                  <input value={jobQuery} onChange={(e) => setJobQuery(e.target.value)} placeholder={t("searchJobCardPlaceholder", lang)} style={{ minHeight: 48, fontSize: 16 }} />
                  {jobResults.length > 0 && (
                    <div style={{ marginTop: 6, border: "1px solid var(--border, #ddd)", borderRadius: 8, overflow: "hidden" }}>
                      {jobResults.map((j) => (
                        <button key={j.id} type="button" onClick={() => pickJob(j)}
                          style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "none", borderBottom: "1px solid var(--border, #eee)", background: "none", cursor: "pointer", minHeight: 44 }}>
                          {j.job_order_number} · {j.product_item || "—"}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="field">
              <label>{t("supplierOptionalLabel", lang)}</label>
              <input value={form.supplier} onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))} style={{ minHeight: 48, fontSize: 16 }} />
            </div>
            <div className="field full">
              <label>{t("notesLabel", lang)}</label>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
            <div className="field full">
              <button type="submit" className="btn btn-primary" style={{ minHeight: 48, fontSize: 16 }} disabled={saving}>
                {saving ? "…" : `✅ ${t("requestMaterialAction", lang)}`}
              </button>
            </div>
          </form>
        )}

        {newId && (
          <div style={{ marginTop: 12 }}>
            <div className="sub" style={{ marginBottom: 6 }}>{t("attachPhotoDocumentHintMsg", lang)}</div>
            <ProofPhotoUpload lang={lang} entityType="factory_material_request" entityId={newId} />
          </div>
        )}
      </div>

      <div className="card">
        <div className="task-meta" style={{ gap: 8, marginBottom: 10 }}>
          <button type="button" className={`btn ${tab === "open" ? "btn-primary" : "btn-outline"}`} onClick={() => setTab("open")}>{t("openRequestsLabel", lang)}</button>
          <button type="button" className={`btn ${tab === "all" ? "btn-primary" : "btn-outline"}`} onClick={() => setTab("all")}>{t("allRequestsLabel", lang)}</button>
        </div>

        {error && <div className="msg error">{t("loadErrorRetry", lang)} <button className="btn btn-outline" onClick={load}>{t("retry", lang)}</button></div>}
        {rows === null && !error && <div className="skeleton-block" style={{ height: 120 }} />}
        {rows && rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}

        {rows && rows.map((r) => (
          <div key={r.id} style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
            <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{r.request_number} — {r.material}</div>
                <div className="sub">
                  {r.quantity} {r.unit} · {lang === "gu" ? r.requesting_department?.name_gu : r.requesting_department?.name_en}
                  {r.job_card ? ` · ${r.job_card.job_order_number}` : ""}
                  {r.required_date ? ` · ${t("requiredDateLabel", lang)}: ${r.required_date}` : ""}
                  {r.order_po_reference ? ` · PO: ${r.order_po_reference}` : ""}
                  {r.supplier ? ` · ${r.supplier}` : ""}
                </div>
              </div>
              <div className="task-meta" style={{ gap: 6 }}>
                {["Urgent", "Emergency", "High"].includes(r.priority) && <span className="fx-tag gold">{r.priority}</span>}
                <span className={`badge ${STATUS_BADGE[r.status]}`}>{t(`materialStatus_${r.status}`, lang)}</span>
              </div>
            </div>
            <ProofPhotoViewer lang={lang} entityType="factory_material_request" entityId={r.id} />
            {r.status !== "RECEIVED" && r.status !== "CANCELLED" && (
              <div className="task-meta" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                {STATUSES.filter((s) => s !== r.status && s !== "REQUESTED").map((s) => (
                  <button key={s} type="button" className="btn btn-outline" style={{ minHeight: 44 }} disabled={busyId === r.id} onClick={() => changeStatus(r.id, s)}>
                    {t(`materialStatus_${s}`, lang)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
