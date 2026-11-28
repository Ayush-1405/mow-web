import React, { useCallback, useEffect, useState } from "react";
import { L, connectionStatus, saveConnection, setThreshold, syncNow, syncRuns, testConnection, when } from "../../lib/ecomApi";
import { EcomPage, LoadError } from "./EcomShared.jsx";

// Shopify Connection Settings. Management saves the store and credentials (stored in Supabase Vault; never shown again or sent
// to a browser), tests the connection (which also subscribes the Shopify webhooks) and sees every sync run. Everyone with
// E-commerce access sees the status and can press Sync now.
const API_VERSIONS = ["2026-10", "2026-07", "2026-04", "2026-01"];

export default function EcomConnection({ lang }) {
  const [s, setS] = useState(null);
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [thr, setThr] = useState("");
  const load = useCallback(async () => {
    setError(null);
    try {
      const [st, r] = await Promise.all([connectionStatus(), syncRuns()]);
      setS(st); setRuns(r); setThr(String(st.low_stock_threshold ?? 5));
      setForm((f) => f || { shop_domain: st.shop_domain || "", api_version: st.api_version || "2026-10", auth_mode: st.auth_mode || "ACCESS_TOKEN",
        client_id: st.client_id || "", client_secret: "", access_token: "" });
    } catch (e) { setError(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn, okText) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: typeof okText === "function" ? okText(r) : okText }); await load(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };
  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const webhookUrl = "https://bykmyttaesuyjwvtnxks.supabase.co/functions/v1/shopify-sync";
  return (
    <EcomPage lang={lang} icon="🔌" title="Shopify Connection Settings" titleGu="Shopify કનેક્શન સેટિંગ્સ"
      sub={L(lang, "Read-only connection: the app reads products, stock and orders from Shopify and never changes anything in your store.", "ફક્ત વાંચવાનું જોડાણ: સ્ટોરમાં કંઈ બદલાતું નથી.")}>
      {error && <LoadError lang={lang} error={error} onRetry={load} />}
      {msg && <div className={`msg ${msg.ok ? "success" : "error"}`} style={{ whiteSpace: "pre-line" }}>{msg.text}</div>}
      {s && (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>{L(lang, "Status", "સ્થિતિ")}</div>
          <table className="proc-table"><tbody>
            <tr><th>{L(lang, "Connection", "જોડાણ")}</th><td><span className={`badge ${s.status === "CONNECTED" ? "COMPLETED" : s.status === "ERROR" ? "RETURNED" : "ON_HOLD"}`}>{s.status.replace(/_/g, " ")}</span></td></tr>
            <tr><th>{L(lang, "Store", "સ્ટોર")}</th><td>{s.shop_name || "—"} {s.shop_domain ? <span className="sub">· {s.shop_domain}</span> : null}</td></tr>
            <tr><th>{L(lang, "API version", "API સંસ્કરણ")}</th><td>{s.api_version}</td></tr>
            <tr><th>{L(lang, "Permissions granted", "મળેલી પરવાનગી")}</th><td style={{ whiteSpace: "normal" }}>{(s.granted_scopes || []).join(", ") || "—"}
              {(s.missing_scopes || []).length > 0 && <div className="msg error" style={{ margin: "4px 0 0" }}>{L(lang, "Missing", "ખૂટે છે")}: {s.missing_scopes.join(", ")}</div>}</td></tr>
            <tr><th>{L(lang, "Webhooks", "વેબહૂક")}</th><td>{s.webhooks_registered} {L(lang, "subscribed (live updates)", "સક્રિય")}</td></tr>
            <tr><th>{L(lang, "Last test", "છેલ્લી ચકાસણી")}</th><td>{when(s.last_test_at)}</td></tr>
            <tr><th>{L(lang, "Stock baseline (first sync)", "પ્રથમ સિંક")}</th><td>{when(s.baseline_at)}</td></tr>
            <tr><th>{L(lang, "Last successful sync", "છેલ્લું સફળ સિંક")}</th><td>{when(s.last_success_sync_at)} <span className="sub">· {L(lang, "automatic check every 30 minutes", "દર 30 મિનિટે આપમેળે")}</span></td></tr>
            {s.last_error && <tr><th>{L(lang, "Last problem", "છેલ્લી સમસ્યા")}</th><td style={{ whiteSpace: "normal" }}><span className="msg error" style={{ margin: 0, display: "inline-block" }}>{s.last_error}</span> <span className="sub">{when(s.last_error_at)}</span></td></tr>}
            <tr><th>{L(lang, "Failed Shopify updates (24 h)", "નિષ્ફળ અપડેટ (24 કલાક)")}</th><td>{s.failed_webhooks_24h} {s.failed_webhooks_24h > 0 && <span className="sub">· {L(lang, "retried automatically", "આપમેળે ફરી પ્રયાસ")}</span>}</td></tr>
          </tbody></table>
          <div className="btn-row">
            {s.can_configure && s.status !== "NOT_CONFIGURED" && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(testConnection, (r) => r.ok
                ? `${L(lang, "Connected to", "જોડાયું")} ${r.shop}. ${L(lang, "Webhooks", "વેબહૂક")}: ${r.webhooks?.total ?? 0}.${r.initial_sync_started ? " " + L(lang, "The first full sync has started; it can take a few minutes.", "પ્રથમ સિંક શરૂ થયું.") : ""}${r.webhooks?.problems?.length ? "\n" + r.webhooks.problems.join("\n") : ""}`
                : `${r.error || L(lang, "Missing permissions", "પરવાનગી ખૂટે છે")}: ${(r.missing_scopes || []).join(", ")}`)}>
                {L(lang, "Test connection", "જોડાણ ચકાસો")}
              </button>)}
            {["CONNECTED", "ERROR"].includes(s.status) && (
              <>
                <button type="button" className="btn btn-outline" disabled={busy} onClick={() => run(() => syncNow(false), L(lang, "Sync started (changes since the last sync).", "સિંક શરૂ."))}>{L(lang, "Sync now", "હમણાં સિંક")}</button>
                <button type="button" className="btn btn-outline" disabled={busy} onClick={() => run(() => syncNow(true), L(lang, "Full re-sync started. Unchanged stock writes nothing; it only fills gaps.", "સંપૂર્ણ સિંક શરૂ."))}>{L(lang, "Full re-sync", "સંપૂર્ણ સિંક")}</button>
              </>)}
          </div>
        </div>
      )}

      {s?.can_set_thresholds && (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>{L(lang, "Low-stock limit", "ઓછા સ્ટોકની મર્યાદા")}</div>
          <div className="sub">{L(lang, "A variant is \"low\" at or below this many units (each variant can have its own limit on its product page).", "આટલા કે ઓછા નંગ = ઓછો સ્ટોક.")}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
            <input type="number" min="0" value={thr} onChange={(e) => setThr(e.target.value)} style={{ width: 90 }} />
            <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} disabled={busy || thr === "" || Number(thr) < 0}
              onClick={() => run(() => setThreshold(Number(thr)), L(lang, "Limit saved.", "મર્યાદા સાચવી."))}>{L(lang, "Save", "સાચવો")}</button>
          </div>
        </div>)}

      {s?.can_configure && form && (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>{L(lang, "Store and credentials (Management only)", "સ્ટોર અને ઓળખ (ફક્ત મેનેજમેન્ટ)")}</div>
          <div className="filter-grid" style={{ display: "grid", gap: 8 }}>
            <label>{L(lang, "Store address", "સ્ટોર સરનામું")} *<input value={form.shop_domain} onChange={f("shop_domain")} placeholder="moodofwood.myshopify.com" /></label>
            <label>{L(lang, "Admin API version", "API સંસ્કરણ")}
              <select value={form.api_version} onChange={f("api_version")}>{[...new Set([form.api_version, ...API_VERSIONS])].map((v) => <option key={v} value={v}>{v}</option>)}</select>
            </label>
            <label>{L(lang, "App type", "એપ પ્રકાર")}
              <select value={form.auth_mode} onChange={f("auth_mode")}>
                <option value="ACCESS_TOKEN">{L(lang, "Custom app made in Shopify admin (Admin API access token)", "Shopify એડમિનમાં બનાવેલી એપ (ટોકન)")}</option>
                <option value="CLIENT_CREDENTIALS">{L(lang, "App from the Shopify Dev Dashboard (client ID + secret)", "Dev Dashboard એપ (ક્લાયન્ટ ID + સિક્રેટ)")}</option>
              </select>
            </label>
            {form.auth_mode === "CLIENT_CREDENTIALS" && <label>{L(lang, "Client ID", "ક્લાયન્ટ ID")} *<input value={form.client_id} onChange={f("client_id")} autoComplete="off" /></label>}
            <label>{L(lang, "Client secret (API secret key)", "ક્લાયન્ટ સિક્રેટ")} {s.has_client_secret ? "" : "*"}
              <input type="password" value={form.client_secret} onChange={f("client_secret")} autoComplete="new-password" placeholder={s.has_client_secret ? L(lang, "Saved — leave blank to keep", "સાચવેલ — ખાલી રાખો") : ""} />
            </label>
            {form.auth_mode === "ACCESS_TOKEN" && (
              <label>{L(lang, "Admin API access token", "Admin API ટોકન")} {s.has_access_token ? "" : "*"}
                <input type="password" value={form.access_token} onChange={f("access_token")} autoComplete="new-password" placeholder={s.has_access_token ? L(lang, "Saved — leave blank to keep", "સાચવેલ — ખાલી રાખો") : "shpat_…"} />
              </label>)}
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy || !form.shop_domain.trim()}
              onClick={() => run(async () => { await saveConnection(form); setForm((x) => ({ ...x, client_secret: "", access_token: "" })); },
                L(lang, "Saved. Secrets are stored encrypted on the server. Now press Test connection.", "સાચવ્યું. હવે જોડાણ ચકાસો."))}>
              {L(lang, "Save", "સાચવો")}
            </button>
          </div>
          <details style={{ marginTop: 8 }}>
            <summary>{L(lang, "How to set up the Shopify app", "Shopify એપ કેવી રીતે બનાવવી")}</summary>
            <ol className="sub" style={{ lineHeight: 1.6 }}>
              <li>{L(lang, "In Shopify, create an app for your own store (Settings → Apps → Develop apps, or the Shopify Dev Dashboard) and install it on the store.", "Shopify માં તમારા સ્ટોર માટે એપ બનાવી ઇન્સ્ટોલ કરો.")}</li>
              <li>{L(lang, "Give it ONLY these Admin API permissions: read_products, read_inventory, read_locations, read_orders. Optional: read_all_orders (orders older than 60 days). No write permissions are needed.", "ફક્ત આ પરવાનગી: read_products, read_inventory, read_locations, read_orders.")}</li>
              <li>{L(lang, "To see customer names, enable protected customer data access (name) for the app; without it orders still sync, without names.", "ગ્રાહકના નામ માટે protected customer data (name) ચાલુ કરો.")}</li>
              <li>{L(lang, "Copy the store address, the client secret (API secret key) and either the Admin API access token or the client ID here, Save, then Test connection.", "સ્ટોર સરનામું, સિક્રેટ અને ટોકન/ID અહીં સાચવો, પછી ચકાસો.")}</li>
              <li>{L(lang, "Test connection subscribes the webhooks automatically to", "વેબહૂક આપમેળે અહીં જોડાશે")}: <code>{webhookUrl}</code></li>
            </ol>
          </details>
        </div>)}

      {runs.length > 0 && (
        <div className="card proc-table-wrap">
          <div className="section-title" style={{ marginTop: 0 }}>{L(lang, "Recent syncs", "તાજેતરના સિંક")}</div>
          <table className="proc-table">
            <thead><tr><th>{L(lang, "Started", "શરૂ")}</th><th>{L(lang, "Type", "પ્રકાર")}</th><th>{L(lang, "By", "દ્વારા")}</th><th>{L(lang, "Result", "પરિણામ")}</th><th>{L(lang, "Synchronised", "સિંક થયું")}</th><th>{L(lang, "Problem", "સમસ્યા")}</th></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r.id}>
                <td>{when(r.started_at)}</td><td>{r.kind.toLowerCase()}</td><td>{r.trigger.toLowerCase().replace(/_/g, " ")}</td>
                <td><span className={`badge ${r.status === "OK" ? "COMPLETED" : r.status === "FAILED" ? "RETURNED" : "IN_PROGRESS"}`}>{r.status}</span></td>
                <td className="sub">{Object.entries(r.counts || {}).filter(([, v]) => v).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ") || "—"}</td>
                <td style={{ whiteSpace: "normal" }}>{r.error || "—"}</td>
              </tr>))}</tbody>
          </table>
        </div>)}
    </EcomPage>
  );
}
