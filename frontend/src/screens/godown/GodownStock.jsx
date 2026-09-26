import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { supabase } from "../../lib/supabase";
import { loadStockAvailability, moveStockToDisplay, listShowroomLocations } from "../../lib/retailApi";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import ProofPhotoViewer from "../../components/ProofPhotoViewer.jsx";

// Available Stock — the Godown worker's own simple, photo-first view of retail_stock_availability, scoped to the
// Godown location by default (the SAME read Retail's own Stock Availability screen and the AI-classified intake
// share — new stock shows up here the instant it's confirmed, no separate "Display" list to keep in sync).
export default function GodownStock({ lang }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [godownLocationId, setGodownLocationId] = useState("");
  const [showrooms, setShowrooms] = useState([]);
  const [moveOpenFor, setMoveOpenFor] = useState(null); // product_id
  const [moveForm, setMoveForm] = useState({ toLocationId: "", quantity: 1 });
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveMsg, setMoveMsg] = useState(null);
  const debouncedQuery = useDebouncedValue(query, 300);

  useEffect(() => {
    supabase.from("locations").select("id, name_en").eq("type", "godown").eq("is_active", true).order("name_en").limit(1)
      .then(({ data }) => setGodownLocationId(data?.[0]?.id || ""));
    listShowroomLocations().then(({ data }) => setShowrooms(data || []));
  }, []);

  const load = useCallback(async () => {
    if (!godownLocationId) return;
    const { data, error: err } = await loadStockAvailability(debouncedQuery, godownLocationId);
    if (err) { setError(true); return; }
    setError(false);
    setRows(data || []);
  }, [debouncedQuery, godownLocationId]);

  useEffect(() => { load(); }, [load]);

  function openMove(productId) {
    setMoveOpenFor((cur) => (cur === productId ? null : productId));
    setMoveForm({ toLocationId: showrooms[0]?.id || "", quantity: 1 });
    setMoveMsg(null);
  }

  async function doMove(productId) {
    if (!moveForm.toLocationId || !moveForm.quantity) return;
    setMoveBusy(true);
    const { error: err } = await moveStockToDisplay(productId, moveForm.toLocationId, Number(moveForm.quantity), null);
    setMoveBusy(false);
    if (err) { setMoveMsg({ type: "error", text: err.message }); return; }
    setMoveMsg({ type: "success", text: t("movedToDisplaySuccessMsg", lang) });
    setMoveOpenFor(null);
    load();
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
        <div className="dept-header-icon" aria-hidden="true">📦</div>
        <div className="dept-header-text"><h1>{t("availableStockTileLabel", lang)}</h1></div>
      </div>

      <div className="card">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("stockSearchPlaceholder", lang)} style={{ minHeight: 48, fontSize: 16 }} />
      </div>

      {moveMsg && <div className="card"><div className={`msg ${moveMsg.type}`}>{moveMsg.text}</div></div>}

      <div className="card">
        {rows === null && <div className="msg info">…</div>}
        {rows !== null && rows.length === 0 && <div className="msg info">{t("noStockDataMsg", lang)}</div>}
        {rows?.map((r) => (
          <div key={r.product_id} style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
            <div className="task-meta" style={{ gap: 12, alignItems: "flex-start" }}>
              <ProofPhotoViewer lang={lang} entityType="retail_product" entityId={r.product_id} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 17 }}>{r.name}</div>
                <div className="sub">{r.sku} · {r.category || "—"}{r.rack_location ? ` · ${r.rack_location}` : ""}</div>
                <div className="task-meta" style={{ gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                  <span className={`badge ${r.available_qty > 0 ? "VERIFIED" : "RETURNED"}`}>{r.available_qty} {t("availableLabel", lang)}</span>
                  {r.reserved_qty > 0 && <span className="fx-tag gold">{t("reservedLabel", lang)}: {r.reserved_qty}</span>}
                  {r.damaged_qty > 0 && <span className="fx-tag" style={{ color: "var(--danger)" }}>{t("damagedLabel", lang)}: {r.damaged_qty}</span>}
                </div>
              </div>
            </div>
            {r.available_qty > 0 && (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-outline" style={{ minHeight: 44 }} onClick={() => openMove(r.product_id)}>
                  📤 {t("moveToDisplayAction", lang)}
                </button>
              </div>
            )}
            {moveOpenFor === r.product_id && (
              <div className="form-grid" style={{ marginTop: 8 }}>
                <div className="field"><label>{t("storeLocationLabel", lang)}</label>
                  <select value={moveForm.toLocationId} onChange={(e) => setMoveForm((f) => ({ ...f, toLocationId: e.target.value }))}>
                    {showrooms.map((s) => <option key={s.id} value={s.id}>{s.name_en}</option>)}
                  </select></div>
                <div className="field"><label>{t("quantityLabel", lang)}</label>
                  <input type="number" min="1" max={r.available_qty} value={moveForm.quantity}
                    onChange={(e) => setMoveForm((f) => ({ ...f, quantity: e.target.value }))} /></div>
                <div className="field full">
                  <button type="button" className="btn btn-primary" disabled={moveBusy} onClick={() => doMove(r.product_id)}>
                    {t("confirmAssignAction", lang)}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
