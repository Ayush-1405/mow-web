import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { listFactoryMaterials, listFactoryMaterialStock, listFactoryLocationsAll, factoryUpsertMaterial, factoryReceiveMaterial } from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

const PAGE_SIZE = 20;

// The real material master + stock ledger, built this round -- previously
// no inventory table existed anywhere in this app. "Available" here means
// quantity_on_hand - reserved_quantity, computed live, never typed by hand.
export default function FactoryRawMaterialAvailability({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [materials, setMaterials] = useState([]);
  const [stock, setStock] = useState([]);
  const [locations, setLocations] = useState([]);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showMaterialForm, setShowMaterialForm] = useState(false);
  const [materialForm, setMaterialForm] = useState({ materialCode: "", materialName: "", category: "", unit: "", reorderLevel: "" });
  const [showReceiptForm, setShowReceiptForm] = useState(false);
  const [receiptForm, setReceiptForm] = useState({ materialId: "", locationId: "", quantity: "", referenceNumber: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [matRes, stockRes, locRes] = await Promise.all([listFactoryMaterials(includeTestData), listFactoryMaterialStock(includeTestData), listFactoryLocationsAll()]);
    if (matRes.error || stockRes.error || locRes.error) { setError(true); setLoading(false); return; }
    setMaterials(matRes.data || []);
    setStock(stockRes.data || []);
    setLocations(locRes.data || []);
    setLoading(false);
  }, [includeTestData]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_material_stock_board", "factory_material_stock", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch]);

  const rows = useMemo(() => {
    const byMaterial = new Map();
    materials.forEach((m) => byMaterial.set(m.id, { material: m, stockRows: [] }));
    stock.forEach((s) => { if (byMaterial.has(s.material_id)) byMaterial.get(s.material_id).stockRows.push(s); });
    return Array.from(byMaterial.values());
  }, [materials, stock]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => [r.material.material_code, r.material.material_name, r.material.category].filter(Boolean).join(" ").toLowerCase().includes(q));
  }, [rows, debouncedSearch]);

  const visible = filtered.slice(0, visibleCount);
  const shortageCount = useMemo(() => rows.filter((r) => {
    const total = r.stockRows.reduce((s, x) => s + Number(x.quantity_on_hand) - Number(x.reserved_quantity), 0);
    return r.material.reorder_level != null && total < r.material.reorder_level;
  }).length, [rows]);

  async function handleMaterialSubmit(e) {
    e.preventDefault();
    if (!materialForm.materialCode.trim() || !materialForm.materialName.trim()) { setMsg("Material code and name are required."); return; }
    setSaving(true);
    setMsg("");
    const { error: err } = await factoryUpsertMaterial(null, materialForm);
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setMaterialForm({ materialCode: "", materialName: "", category: "", unit: "", reorderLevel: "" });
    setShowMaterialForm(false);
    load();
  }

  async function handleReceiptSubmit(e) {
    e.preventDefault();
    if (!receiptForm.materialId || !receiptForm.locationId) { setMsg("Select a material and location."); return; }
    if (!receiptForm.quantity || Number(receiptForm.quantity) <= 0) { setMsg("A positive quantity is required."); return; }
    setSaving(true);
    setMsg("");
    const { error: err } = await factoryReceiveMaterial(receiptForm.materialId, receiptForm.locationId, Number(receiptForm.quantity), receiptForm.referenceNumber, receiptForm.notes);
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setReceiptForm({ materialId: "", locationId: "", quantity: "", referenceNumber: "", notes: "" });
    setShowReceiptForm(false);
    load();
  }

  function handleExport() {
    exportRowsToExcel("Raw-Material-Availability-export.xlsx", "Material Availability", filtered.flatMap((r) => (
      r.stockRows.length ? r.stockRows.map((s) => ({
        MaterialCode: r.material.material_code, MaterialName: r.material.material_name, Location: locations.find((l) => l.id === s.location_id)?.name || "",
        OnHand: s.quantity_on_hand, Reserved: s.reserved_quantity, Available: Number(s.quantity_on_hand) - Number(s.reserved_quantity), ReorderLevel: r.material.reorder_level ?? "",
      })) : [{ MaterialCode: r.material.material_code, MaterialName: r.material.material_name, Location: "—", OnHand: 0, Reserved: 0, Available: 0, ReorderLevel: r.material.reorder_level ?? "" }]
    )));
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
          <h1>{t("factoryRawMaterialAvailabilityTitle", lang) || "Raw Material Availability"}</h1>
          <div className="sub">Available = quantity on hand − reserved, computed live from the material transaction ledger.</div>
        </div>
      </div>

      <div className="dept-meta-grid">
        <div className="card dept-meta-tile"><div className="label">Materials</div><div className="value">{materials.length}</div></div>
        <div className="card dept-meta-tile"><div className="label">Below Reorder Level</div><div className="value" style={{ color: shortageCount ? "#b91c1c" : undefined }}>{shortageCount}</div></div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search material code/name/category…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleExport}>Export</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setShowMaterialForm((s) => !s)}>{showMaterialForm ? "Cancel" : "New Material"}</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowReceiptForm((s) => !s)}>{showReceiptForm ? "Cancel" : "Receive Stock"}</button>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
        </div>
      </div>

      {msg && <div className="msg error">{msg}</div>}

      {showMaterialForm && (
        <div className="card">
          <form onSubmit={handleMaterialSubmit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field"><label>Material Code (required)</label><input value={materialForm.materialCode} onChange={(e) => setMaterialForm((f) => ({ ...f, materialCode: e.target.value }))} /></div>
            <div className="field"><label>Material Name (required)</label><input value={materialForm.materialName} onChange={(e) => setMaterialForm((f) => ({ ...f, materialName: e.target.value }))} /></div>
            <div className="field"><label>Category</label><input value={materialForm.category} onChange={(e) => setMaterialForm((f) => ({ ...f, category: e.target.value }))} /></div>
            <div className="field"><label>Unit</label><input value={materialForm.unit} onChange={(e) => setMaterialForm((f) => ({ ...f, unit: e.target.value }))} /></div>
            <div className="field"><label>Reorder Level</label><input type="number" value={materialForm.reorderLevel} onChange={(e) => setMaterialForm((f) => ({ ...f, reorderLevel: e.target.value }))} /></div>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save Material"}</button>
          </form>
        </div>
      )}

      {showReceiptForm && (
        <div className="card">
          <form onSubmit={handleReceiptSubmit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field"><label>Material (required)</label>
              <select value={receiptForm.materialId} onChange={(e) => setReceiptForm((f) => ({ ...f, materialId: e.target.value }))} required>
                <option value="">—</option>
                {materials.map((m) => <option key={m.id} value={m.id}>{m.material_code} — {m.material_name}</option>)}
              </select>
            </div>
            <div className="field"><label>Location (required)</label>
              <select value={receiptForm.locationId} onChange={(e) => setReceiptForm((f) => ({ ...f, locationId: e.target.value }))} required>
                <option value="">—</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="field"><label>Quantity (required)</label><input type="number" value={receiptForm.quantity} onChange={(e) => setReceiptForm((f) => ({ ...f, quantity: e.target.value }))} /></div>
            <div className="field"><label>GRN/Reference Number</label><input value={receiptForm.referenceNumber} onChange={(e) => setReceiptForm((f) => ({ ...f, referenceNumber: e.target.value }))} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><input value={receiptForm.notes} onChange={(e) => setReceiptForm((f) => ({ ...f, notes: e.target.value }))} /></div>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Receive Stock"}</button>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map(({ material, stockRows }) => {
          const totalOnHand = stockRows.reduce((s, x) => s + Number(x.quantity_on_hand), 0);
          const totalReserved = stockRows.reduce((s, x) => s + Number(x.reserved_quantity), 0);
          const available = totalOnHand - totalReserved;
          const short = material.reorder_level != null && available < material.reorder_level;
          return (
            <div key={material.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <span style={{ fontWeight: 700 }}>{material.material_code}</span>
              <span className="sub">{material.material_name} ({material.category || "—"})</span>
              <span className="sub">On hand {totalOnHand} · Reserved {totalReserved}</span>
              <span className={`badge ${short ? "RETURNED" : "VERIFIED"}`}>Available {available}</span>
              {short && <span className="sub" style={{ color: "#b91c1c" }}>Below reorder level ({material.reorder_level})</span>}
            </div>
          );
        })}
        {visibleCount < filtered.length && (
          <button type="button" className="btn btn-outline" style={{ marginTop: 8 }} onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
            Load More ({filtered.length - visibleCount} more)
          </button>
        )}
      </div>
    </div>
  );
}
