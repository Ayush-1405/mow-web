/* eslint-disable react-refresh/only-export-components -- shared E-commerce screen pieces: small components plus the useDateRange hook */
import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { L, PRESETS, presetRange, STAGE, STOCK, connectionStatus, syncNow, when } from "../../lib/ecomApi";
import { friendlyError } from "../../lib/friendlyError";

// Shared pieces of the E-commerce screens: page header, date range (company timezone), status badges, the Shopify connection
// strip with Sync Now, small product image, empty / error states.

export function EcomPage({ lang, icon, title, titleGu, sub, children, actions }) {
  const navigate = useNavigate();
  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">{icon}</div>
        <div className="dept-header-text">
          <h1 style={{ margin: 0, fontSize: 20 }}>{L(lang, title, titleGu)}</h1>
          {sub && <div className="sub">{sub}</div>}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {actions}
          <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={() => navigate("/ecommerce")}>
            ← {L(lang, "E-commerce", "ઈ-કોમર્સ")}
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

// Date range kept in the URL (?preset=&from=&to=) so a dashboard card can open a list already filtered.
export function useDateRange(defaultPreset = "last7") {
  const [params, setParams] = useSearchParams();
  const preset = params.get("preset") || (params.get("from") ? "custom" : defaultPreset);
  const r = preset === "custom" ? { from: params.get("from") || "", to: params.get("to") || "" } : presetRange(preset) || { from: "", to: "" };
  const set = (patch) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v === null || v === "" || v === undefined ? next.delete(k) : next.set(k, v)));
    setParams(next, { replace: true });
  };
  return { preset, from: r.from, to: r.to, set, params };
}

export function DateRangeFilter({ lang, range, allowAll = false }) {
  const { preset, from, to, set } = range;
  return (
    <>
      <label className="filter-date-label">{L(lang, "Period", "સમયગાળો")}
        <select value={preset} onChange={(e) => {
          const p = e.target.value;
          if (p === "custom") set({ preset: "custom", from: from || presetRange("last7").from, to: to || presetRange("today").to });
          else set({ preset: p, from: null, to: null });
        }}>
          {allowAll && <option value="all">{L(lang, "All dates", "બધી તારીખ")}</option>}
          {PRESETS.map(([k, en, gu]) => <option key={k} value={k}>{L(lang, en, gu)}</option>)}
        </select>
      </label>
      {preset === "custom" && (
        <>
          <label className="filter-date-label">{L(lang, "From", "થી")}<input type="date" value={from} max={to || undefined} onChange={(e) => set({ preset: "custom", from: e.target.value })} /></label>
          <label className="filter-date-label">{L(lang, "To", "સુધી")}<input type="date" value={to} min={from || undefined} onChange={(e) => set({ preset: "custom", to: e.target.value })} /></label>
        </>
      )}
    </>
  );
}

export const StageBadge = ({ lang, stage }) => {
  const s = STAGE[stage] || [stage, stage, "ON_HOLD"];
  return <span className={`badge ${s[2]}`}>{L(lang, s[0], s[1])}</span>;
};
export const StockBadge = ({ lang, status }) => {
  const s = STOCK[status] || STOCK.NOT_TRACKED;
  return <span className={`badge ${s[2]}`}>{L(lang, s[0], s[1])}</span>;
};
export const Thumb = ({ url, size = 40 }) => url
  ? <img src={url} alt="" loading="lazy" style={{ width: size, height: size, objectFit: "cover", borderRadius: 6, background: "var(--cream, #f4ede3)" }} />
  : <span aria-hidden="true" style={{ display: "inline-block", width: size, height: size, borderRadius: 6, background: "var(--cream, #f4ede3)" }} />;

export function Empty({ lang, children }) {
  return <div className="card" style={{ textAlign: "center", color: "var(--ink-soft)" }}>{children || L(lang, "Nothing here yet.", "હજુ કંઈ નથી.")}</div>;
}
export function LoadError({ lang, error, onRetry }) {
  return (
    <div className="card">
      <div className="msg error">{friendlyError(error?.message || error) || L(lang, "Could not load. Please try again.", "લોડ ન થયું.")}</div>
      {onRetry && <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={onRetry}>{L(lang, "Try again", "ફરી પ્રયાસ")}</button>}
    </div>
  );
}

// Shopify connection status + last sync + Sync Now. Shows the honest state: not connected, connected, or the last error.
export function ConnectionStrip({ lang, status: given, onSynced, compact = false }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState(given || null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  useEffect(() => { if (given) setStatus(given); else connectionStatus().then(setStatus).catch(() => setStatus(null)); }, [given]);
  if (!status) return null;
  const connected = status.status === "CONNECTED";
  const running = status.last_run?.status === "RUNNING";
  const sync = async () => {
    setBusy(true); setNote(null);
    try {
      await syncNow(false);
      setNote(L(lang, "Sync started. New data appears in a minute; refresh to see it.", "સિંક શરૂ થયું. એક મિનિટમાં નવો ડેટા દેખાશે."));
      setTimeout(async () => { try { setStatus(await connectionStatus()); onSynced?.(); } catch { /* keep the old status */ } }, 8000);
    } catch (e) { setNote(e.message); }
    setBusy(false);
  };
  return (
    <div className="card" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: compact ? "8px 12px" : undefined }}>
      <span className={`badge ${connected ? "COMPLETED" : status.status === "ERROR" ? "RETURNED" : "ON_HOLD"}`}>
        {connected ? L(lang, "Shopify connected", "Shopify જોડાયેલ") : status.status === "ERROR" ? L(lang, "Shopify: problem", "Shopify: સમસ્યા")
          : status.status === "CONFIGURED" ? L(lang, "Shopify: saved, not tested", "Shopify: સાચવ્યું, ચકાસ્યું નથી") : L(lang, "Shopify not connected", "Shopify જોડાયેલ નથી")}
      </span>
      {status.shop_name && <strong>{status.shop_name}</strong>}
      <span className="sub">{L(lang, "Last successful sync", "છેલ્લું સફળ સિંક")}: {when(status.last_success_sync_at)}</span>
      {running && <span className="badge IN_PROGRESS">{L(lang, "Syncing…", "સિંક ચાલુ…")}</span>}
      {status.last_run?.status === "PARTIAL" && <span className="sub">{L(lang, "Last sync stopped part-way; it continues on the next sync.", "છેલ્લું સિંક અધૂરું; આગલા સિંકમાં આગળ વધશે.")}</span>}
      {status.status === "ERROR" && status.last_error && <span className="msg error" style={{ margin: 0, padding: "4px 8px" }}>{status.last_error}</span>}
      {status.failed_webhooks_24h > 0 && <span className="sub">{status.failed_webhooks_24h} {L(lang, "update(s) from Shopify failed in 24 h; retried automatically", "Shopify અપડેટ નિષ્ફળ; આપમેળે ફરી પ્રયાસ")}</span>}
      <span style={{ flex: 1 }} />
      {(connected || status.status === "ERROR") && (
        <button type="button" className="btn btn-primary" style={{ width: "auto", marginTop: 0 }} disabled={busy || running} onClick={sync}>
          {busy ? "…" : L(lang, "Sync now", "હમણાં સિંક કરો")}
        </button>
      )}
      <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={() => navigate("/ecommerce/connection")}>
        {L(lang, "Connection settings", "કનેક્શન સેટિંગ્સ")}
      </button>
      {note && <div className="sub" style={{ width: "100%" }}>{note}</div>}
    </div>
  );
}
