import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { factoryInventoryCosting } from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

// Opening/received/issued/adjustment/closing computed purely from
// factory_material_transactions (never a manually-typed total). A live
// bug in this exact calculation was found and fixed before delivery: with
// no date filter, opening and period movement both matched the whole
// ledger and double-counted everything (verified: 100 received showed as
// closing 160 instead of 100 -- fixed and re-verified live). Restricted to
// the same authorized roles as Mandatory Product Costing.
export default function FactoryInventoryCosting({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await factoryInventoryCosting(from || null, to || null, includeTestData);
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    setLoading(false);
  }, [from, to, includeTestData]);

  useEffect(() => { load(); }, [load]);

  function handleExport() {
    exportRowsToExcel("Factory-Inventory-Costing-export.xlsx", "Inventory Costing", rows.map((r) => ({
      MaterialCode: r.material_code, MaterialName: r.material_name, Location: r.location_name,
      Opening: r.opening_quantity, Received: r.received_quantity, Issued: r.issued_quantity,
      Adjustment: r.adjustment_quantity, Closing: r.closing_quantity,
    })));
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
        <div className="dept-header-icon" aria-hidden="true">🏭</div>
        <div className="dept-header-text">
          <h1>{t("factoryInventoryCostingTitle", lang) || "Factory Inventory Costing"}</h1>
          <div className="sub">Restricted to Super Admin, Management, Factory Department Head and authorized Accounts users. If nothing loads below, either there is no ledger activity yet, or your role is not authorized.</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="field" style={{ width: "auto" }}><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field" style={{ width: "auto" }}><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <button type="button" className="btn btn-outline" style={{ width: "auto", alignSelf: "flex-end" }} onClick={() => { setFrom(""); setTo(""); }}>Clear Filters</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto", alignSelf: "flex-end" }} onClick={handleExport}>Export</button>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
        </div>
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>{["Material", "Location", "Opening", "Received", "Issued", "Adjustment", "Closing"].map((h) => <th key={h} style={{ textAlign: "left", fontSize: 12, padding: 6 }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--border, #e5e7eb)" }}>
                    <td style={{ padding: 6, fontWeight: 600 }}>{r.material_code} — {r.material_name}</td>
                    <td style={{ padding: 6 }}>{r.location_name}</td>
                    <td style={{ padding: 6 }}>{r.opening_quantity}</td>
                    <td style={{ padding: 6, color: "#15803d" }}>{r.received_quantity}</td>
                    <td style={{ padding: 6, color: r.issued_quantity > 0 ? "#b45309" : undefined }}>{r.issued_quantity}</td>
                    <td style={{ padding: 6 }}>{r.adjustment_quantity}</td>
                    <td style={{ padding: 6, fontWeight: 700 }}>{r.closing_quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
