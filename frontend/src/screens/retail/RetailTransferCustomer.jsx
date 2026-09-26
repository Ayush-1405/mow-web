import React, { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { transferCustomer, searchRetailTeam } from "../../lib/retailApi";

// Transfer / Share Customer (v2_93h §2): the ONLY UI path that can change a customer's ownership or grant backup/temporary/
// readonly access — every option requires a new assignee, an effective date and a reason, and is permanently logged server-side
// (retail_customer_ownership_log). Never a silent reassignment.
export default function RetailTransferCustomer({ lang, customer, onClose, onDone }) {
  const [team, setTeam] = useState([]);
  const [form, setForm] = useState({ type: "PERMANENT", new_owner_id: "", effective_date: new Date().toISOString().slice(0, 10), until: "", reason: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { searchRetailTeam().then(({ data }) => setTeam((data || []).filter((u) => u.id !== customer?.owner_salesperson_id))); }, [customer]);

  async function submit(e) {
    e.preventDefault();
    if (!form.new_owner_id || !form.reason.trim()) return;
    setSaving(true);
    setError(null);
    const { error: err } = await transferCustomer(customer.id, form.new_owner_id, form.type, form.effective_date, form.until || null, form.reason);
    setSaving(false);
    if (err) { setError(err.message); return; }
    onDone?.();
  }

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h3>{t("transferShareCustomerTitle", lang)}</h3>
      <form onSubmit={submit} className="form-grid">
        <div className="field full">
          <label>{t("transferTypeLabel", lang)}</label>
          <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
            <option value="PERMANENT">{t("permanentTransferLabel", lang)}</option>
            <option value="TEMPORARY">{t("temporaryAssignmentLabel", lang)}</option>
            <option value="BACKUP">{t("addBackupSalespersonLabel", lang)}</option>
            <option value="READONLY">{t("readOnlySharingLabel", lang)}</option>
          </select>
        </div>
        <div className="field full">
          <label>{t("newAssigneeLabel", lang)} *</label>
          <select value={form.new_owner_id} onChange={(e) => setForm((f) => ({ ...f, new_owner_id: e.target.value }))} required>
            <option value="">—</option>
            {team.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{t("effectiveDateLabel", lang)}</label>
          <input type="date" value={form.effective_date} onChange={(e) => setForm((f) => ({ ...f, effective_date: e.target.value }))} />
        </div>
        {form.type !== "PERMANENT" && (
          <div className="field">
            <label>{t("untilDateLabel", lang)}</label>
            <input type="date" value={form.until} onChange={(e) => setForm((f) => ({ ...f, until: e.target.value }))} />
          </div>
        )}
        <div className="field full">
          <label>{t("reasonLabel", lang)} *</label>
          <textarea rows={2} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} required />
        </div>
        {error && <div className="msg error field full">{error}</div>}
        <div className="field full task-meta" style={{ gap: 8 }}>
          <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
          <button className="btn btn-outline" type="button" onClick={onClose}>{t("cancel", lang)}</button>
        </div>
      </form>
    </div>
  );
}
