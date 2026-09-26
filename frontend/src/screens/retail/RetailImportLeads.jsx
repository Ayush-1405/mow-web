import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import { importLeads } from "../../lib/retailApi";

// Controlled Excel/CSV import for historical leads (spec §16): Supabase stays the single source of truth — this is a one-time, audited
// upload, never a live sync. Upload -> map spreadsheet columns to fields -> preview (dry run, writes nothing) -> confirm (writes real
// retail_customers/retail_leads rows via retail_import_leads(), deduped by phone, with one audit-log row for the whole batch).
const TARGET_FIELDS = [
  ["customer_name", true], ["phone", false], ["whatsapp", false], ["email", false], ["city", false],
  ["source", false], ["requirement_category", false], ["customer_type", false], ["notes", false],
];

export default function RetailImportLeads({ lang }) {
  const navigate = useNavigate();
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState([]);
  const [sourceRows, setSourceRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null); setPreview(null); setConfirmed(null);
    setFileName(file.name);
    const buf = await file.arrayBuffer();
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    if (!rows.length) { setError(t("importEmptyFileMsg", lang)); return; }
    const cols = Object.keys(rows[0]);
    setHeaders(cols);
    setSourceRows(rows);
    // best-effort auto-map by matching header text loosely to target field names
    const auto = {};
    for (const [field] of TARGET_FIELDS) {
      const hit = cols.find((c) => c.toLowerCase().replace(/[^a-z]/g, "") === field.replace(/_/g, ""));
      if (hit) auto[field] = hit;
    }
    setMapping(auto);
  }

  const mappedRows = useMemo(() => {
    return sourceRows.map((r) => {
      const out = {};
      for (const [field] of TARGET_FIELDS) {
        const col = mapping[field];
        if (col) out[field] = String(r[col] ?? "").trim();
      }
      return out;
    });
  }, [sourceRows, mapping]);

  async function runPreview() {
    setBusy(true); setError(null);
    const { data, error: err } = await importLeads(mappedRows, true);
    setBusy(false);
    if (err) { setError(err.message); return; }
    setPreview(data || []);
  }

  async function runImport() {
    setBusy(true); setError(null);
    const { data, error: err } = await importLeads(mappedRows, false);
    setBusy(false);
    if (err) { setError(err.message); return; }
    setConfirmed(data || []);
    setPreview(null);
  }

  const summary = (rows) => rows ? {
    willImport: rows.filter((r) => r.outcome === "WILL_IMPORT" || r.outcome === "IMPORTED").length,
    duplicate: rows.filter((r) => r.outcome === "DUPLICATE").length,
    error: rows.filter((r) => r.outcome === "ERROR").length,
  } : null;
  const previewSummary = summary(preview);
  const confirmedSummary = summary(confirmed);

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📥</div>
        <div className="dept-header-text"><h1>{t("importLeadsTitle", lang)}</h1></div>
        <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={() => navigate("/retail/leads")}>{t("back", lang)}</button>
      </div>

      {!confirmed && (
        <div className="card">
          <div className="field full"><label>{t("chooseExcelFileLabel", lang)}</label>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={onFile} />
          </div>
          {fileName && <div className="sub">{fileName} · {sourceRows.length} {t("rowsFoundLabel", lang)}</div>}
        </div>
      )}

      {headers.length > 0 && !confirmed && (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>{t("mapColumnsLabel", lang)}</div>
          <div className="form-grid">
            {TARGET_FIELDS.map(([field, required]) => (
              <div className="field" key={field}>
                <label>{t(`importField_${field}`, lang)}{required ? " *" : ""}</label>
                <select value={mapping[field] || ""} onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value || undefined }))}>
                  <option value="">{t("notMappedLabel", lang)}</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          {error && <div className="msg error" role="alert">{error}</div>}
          <button type="button" className="btn btn-primary" disabled={busy || !mapping.customer_name} onClick={runPreview}>
            {busy && <span className="spinner" />}{t("previewImportAction", lang)}
          </button>
          {!mapping.customer_name && <div className="msg info" style={{ marginTop: 6 }}>{t("mapCustomerNameRequiredMsg", lang)}</div>}
        </div>
      )}

      {preview && !confirmed && (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>{t("importPreviewLabel", lang)}</div>
          <div className="task-meta" style={{ gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="fx-tag gold">{t("willImportLabel", lang)}: {previewSummary.willImport}</span>
            <span className="fx-tag">{t("duplicateLabel", lang)}: {previewSummary.duplicate}</span>
            {previewSummary.error > 0 && <span className="fx-tag" style={{ color: "var(--danger)" }}>{t("errorLabel", lang)}: {previewSummary.error}</span>}
          </div>
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            {preview.map((r) => (
              <div key={r.row_index} className="task-meta" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--border)", padding: "4px 0" }}>
                <div>{r.customer_name || "—"} <span className="sub">{r.phone || ""}</span></div>
                <span className={`badge ${r.outcome === "WILL_IMPORT" ? "VERIFIED" : r.outcome === "DUPLICATE" ? "ASSIGNED" : "RETURNED"}`}>{r.outcome}{r.reason ? `: ${r.reason}` : ""}</span>
              </div>
            ))}
          </div>
          {error && <div className="msg error" role="alert">{error}</div>}
          <button type="button" className="btn btn-primary" disabled={busy || previewSummary.willImport === 0} onClick={runImport} style={{ marginTop: 10 }}>
            {busy && <span className="spinner" />}{t("confirmImportAction", lang)} ({previewSummary.willImport})
          </button>
        </div>
      )}

      {confirmed && (
        <div className="card">
          <div className="msg success">{t("importCompleteMsg", lang)}</div>
          <div className="task-meta" style={{ gap: 10, flexWrap: "wrap", margin: "8px 0" }}>
            <span className="fx-tag gold">{t("importedLabel", lang)}: {confirmedSummary.willImport}</span>
            <span className="fx-tag">{t("duplicateLabel", lang)}: {confirmedSummary.duplicate}</span>
            {confirmedSummary.error > 0 && <span className="fx-tag" style={{ color: "var(--danger)" }}>{t("errorLabel", lang)}: {confirmedSummary.error}</span>}
          </div>
          <button type="button" className="btn btn-primary" onClick={() => navigate("/retail/leads")}>{t("viewLeadsAction", lang)}</button>
        </div>
      )}
    </div>
  );
}
