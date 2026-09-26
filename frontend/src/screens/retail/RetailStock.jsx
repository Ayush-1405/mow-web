import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import { supabase } from "../../lib/supabase";
import { loadStockAvailability } from "../../lib/retailApi";
import { useDebouncedValue } from "../../lib/useDebouncedValue";

// Stock Availability — retail_products + retail_stock (mvp_pilot_retail_workflow_v2_93d.sql), the first real stock data source this
// module has had; the screen used to be an honest empty state with nothing to read from. Reserved quantity comes from CONFIRMED orders
// (retail_fulfilment_items, mode=STOCK) and is always subtracted before "Available" is shown — reserved stock is never offered as free.
// "Request Transfer" hands off to the existing Stock Transfer screen, which already routes to Godown/Inventory through a real task.
export default function RetailStock({ lang }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [locationId, setLocationId] = useState("");
  const [locations, setLocations] = useState([]);
  const debouncedQuery = useDebouncedValue(query, 300);

  useEffect(() => {
    supabase.from("locations").select("id, name_en, name_gu, type").eq("is_active", true).in("type", ["showroom", "godown"]).order("name_en")
      .then(({ data }) => setLocations(data || []));
  }, []);

  const load = useCallback(async () => {
    const { data, error: err } = await loadStockAvailability(debouncedQuery, locationId || null);
    if (err) { setError(true); return; }
    setError(false);
    setRows(data || []);
  }, [debouncedQuery, locationId]);

  useEffect(() => { load(); }, [load]);

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
        <div className="dept-header-icon" aria-hidden="true">🏷️</div>
        <div className="dept-header-text"><h1>{t("retailStockTitle", lang)}</h1></div>
      </div>

      <div className="card filter-bar filter-grid">
        <div className="field full">
          <label>{t("stockSearchLabel", lang)}</label>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("stockSearchPlaceholder", lang)} />
        </div>
        <div className="field">
          <label>{t("storeLocationLabel", lang)}</label>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">{t("allStoresLabel", lang)}</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{lang === "gu" ? l.name_gu : l.name_en}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        {rows === null && <div className="msg info">…</div>}
        {rows !== null && rows.length === 0 && <div className="msg info">{t("noStockDataMsg", lang)}</div>}
        {rows?.map((r) => (
          <div key={r.product_id + r.location_id} className="retail-stock-row">
            <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{r.name} <span className="sub">{r.sku}</span></div>
                <div className="sub">{r.category || "—"} · {r.location_name}{r.rack_location ? ` · ${r.rack_location}` : ""}</div>
              </div>
              <span className={`badge ${r.available_qty > 0 ? "VERIFIED" : "RETURNED"}`}>{r.available_qty} {t("availableLabel", lang)}</span>
            </div>
            <div className="task-meta" style={{ gap: 10, flexWrap: "wrap", marginTop: 4 }}>
              <span className="fx-tag">{t("onHandLabel", lang)}: {r.on_hand_qty}</span>
              {r.reserved_qty > 0 && <span className="fx-tag gold">{t("reservedLabel", lang)}: {r.reserved_qty}</span>}
              {r.damaged_qty > 0 && <span className="fx-tag" style={{ color: "var(--danger)" }}>{t("damagedLabel", lang)}: {r.damaged_qty}</span>}
              {r.incoming_qty > 0 && <span className="fx-tag">{t("incomingLabel", lang)}: {r.incoming_qty}{r.expected_availability_date ? ` (${r.expected_availability_date})` : ""}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <button type="button" className="btn btn-outline" onClick={() => navigate("/retail/stock-transfer")}>🚚 {t("requestTransfer", lang)}</button>
      </div>
    </div>
  );
}
