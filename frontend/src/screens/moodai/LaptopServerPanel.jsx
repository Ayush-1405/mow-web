import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { friendlyError } from "../../lib/friendlyError";
import { askText } from "../../lib/askText";

const L = (lang, en, gu) => (lang === "gu" ? gu : en);
const when = (t) => (t ? String(t).replace("T", " ").slice(0, 19) : "—");
const rpc = async (name, args) => { const { data, error } = await supabase.rpc(name, args); if (error) throw error; return data; };
const ago = (t) => {
  if (!t) return "never";
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

// Laptop server (v3_20): the optional Mood AI worker. Shown inside the Mood AI Control Center.
// The app never depends on it -- jobs wait in the queue while it is off.
export default function LaptopServerPanel({ lang, canOwner }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState(null);
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setP(await rpc("mai_worker_panel")); setErr(null); } catch (e) { setErr(friendlyError(e?.message)); } }, []);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);
  const act = async (fn) => { setBusy(true); setErr(null); try { await fn(); await load(); } catch (e) { setErr(friendlyError(e?.message)); } setBusy(false); };

  if (!p) return err ? <div className="card"><div className="msg error">{err}</div></div> : null;
  const active = (p.workers || []).filter((w) => w.status === "ACTIVE");
  return (
    <div className="card">
      <h3 className="perf-h">💻 {L(lang, "Laptop server", "લેપટોપ સર્વર")}</h3>
      <p className="sub">{L(lang, "An optional helper computer for background jobs. The app keeps working when it is off; jobs wait and run when it comes back. It is started on the laptop itself (start-worker.cmd) — it cannot be switched on from here.",
        "બેકગ્રાઉન્ડ કામ માટે વૈકલ્પિક સહાયક કમ્પ્યુટર. તે બંધ હોય ત્યારે પણ એપ ચાલે છે.")}</p>
      {err && <div className="msg error">{err}</div>}
      {token && (
        <div className="msg success" style={{ overflowWrap: "anywhere" }}>
          <b>{L(lang, "Worker token — shown only once.", "વર્કર ટોકન — ફક્ત એક વાર દેખાય છે.")}</b> {L(lang, "Put it in worker\\.env on the laptop as MOOD_AI_WORKER_TOKEN, then start the worker. Do not send it in chat or email.", "લેપટોપ પર worker\\.env માં મૂકો.")}
          <div><code>{token}</code></div>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setToken(null)}>{L(lang, "I have saved it", "સાચવી લીધું")}</button>
        </div>
      )}
      <div className="kpi-grid">
        {[[L(lang, "Waiting jobs", "બાકી કામ"), p.jobs?.queued], [L(lang, "Running", "ચાલુ"), p.jobs?.running], [L(lang, "Done (24 h)", "પૂર્ણ (24 ક)"), p.jobs?.done_24h], [L(lang, "Failed (24 h)", "નિષ્ફળ (24 ક)"), p.jobs?.failed_24h]]
          .map(([k, v]) => <div key={k} className="kpi-tile"><div className="num">{v ?? 0}</div><div className="label">{k}</div></div>)}
      </div>
      {active.length === 0 && <p className="sub" style={{ marginTop: 8 }}>{L(lang, "No laptop worker is registered.", "કોઈ લેપટોપ વર્કર નોંધાયેલું નથી.")}</p>}
      {active.map((w) => {
        const m = w.metrics || {};
        return (
          <div key={w.id} className={`mai-worker ${w.online ? "on" : "off"}`}>
            <div className="perf-mini-row">
              <b>{w.online ? "● " : "○ "}{w.name}</b>
              <span className={`badge ${!w.online ? "ASSIGNED" : w.paused ? "ON_HOLD" : w.state === "RUNNING" ? "COMPLETED" : "ON_HOLD"}`}>
                {!w.online ? L(lang, "Offline — AI background work waits", "ઑફલાઇન") : w.paused ? L(lang, "Paused", "અટકાવ્યું") : w.state}</span>
              <span className="sub">{L(lang, "last heartbeat", "છેલ્લો સંકેત")} {ago(w.last_heartbeat_at)}{w.state_reason && w.online ? ` · ${w.state_reason}` : ""}</span>
            </div>
            {w.online && (
              <div className="perf-metrics" style={{ marginTop: 6 }}>
                {[["CPU", `${m.cpu_pct ?? "—"}%`], ["RAM", `${m.ram_free_gb ?? "—"} / ${m.ram_total_gb ?? "—"} GB free`],
                  ["GPU", m.gpu ? `${m.gpu.util_pct}% · ${m.gpu.vram_used_gb}/${m.gpu.vram_total_gb} GB` : "—"],
                  ["Disk D:", m.disks?.D ? `${m.disks.D.free_gb} GB free` : "—"], ["Disk C:", m.disks?.C ? `${m.disks.C.free_gb} GB free` : "—"],
                  [L(lang, "Power", "પાવર"), m.on_ac === false ? `${L(lang, "battery", "બેટરી")} ${m.battery_pct ?? ""}%` : L(lang, "charger", "ચાર્જર")],
                  [L(lang, "Worker running for", "વર્કર ચાલુ"), m.worker_uptime_min !== undefined ? `${Math.round(m.worker_uptime_min)} min` : "—"],
                  [L(lang, "Jobs running", "ચાલુ કામ"), w.running],
                  [L(lang, "Local models (Ollama)", "લોકલ મૉડેલ"), m.ollama?.up
                    ? `${[m.ollama.chat_model, m.ollama.embed_model].filter(Boolean).join(" + ")}${m.ollama.loaded?.length ? ` · ${L(lang, "loaded", "લોડ")}: ${m.ollama.loaded.map((x) => x.name).join(", ")}` : ""}`
                    : L(lang, "off", "બંધ")]]
                  .map(([k, v]) => <div key={k} className="perf-metric"><span className="n" style={{ fontSize: 15 }}>{v}</span><span className="t">{k}</span></div>)}
              </div>
            )}
            <div className="sub" style={{ marginTop: 4 }}>{L(lang, "Limits", "મર્યાદા")}: CPU ≤ {w.limits?.max_cpu_pct}% · {L(lang, "free RAM", "ખાલી RAM")} ≥ {w.limits?.min_free_ram_gb} GB · {L(lang, "1 job at a time", "એક સમયે 1 કામ")}
              {w.limits?.pause_on_battery ? ` · ${L(lang, "pauses on battery", "બેટરી પર અટકે")}` : ""}{w.limits?.working_hours ? ` · ${w.limits.working_hours.from}–${w.limits.working_hours.to}` : ""}
              {" · "}{w.hostname || "—"} · v{w.version || "—"} · {L(lang, "token …", "ટોકન …")}{w.token_hint}</div>
            <div className="btn-row" style={{ marginTop: 6 }}>
              {w.paused
                ? <button type="button" className="btn btn-primary btn-sm" disabled={busy || !canOwner} onClick={() => act(() => rpc("mai_worker_set_paused", { p_worker: w.id, p_paused: false }))}>{L(lang, "Resume jobs", "કામ ફરી શરૂ")}</button>
                : <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => act(() => rpc("mai_worker_set_paused", { p_worker: w.id, p_paused: true }))}>{L(lang, "Pause jobs", "કામ અટકાવો")}</button>}
              <button type="button" className="btn btn-outline btn-sm" disabled={busy || !w.online} onClick={() => act(() => rpc("mai_worker_request_restart", { p_worker: w.id }))}>{w.restart_pending ? L(lang, "Restart requested…", "પુનઃશરૂ વિનંતી…") : L(lang, "Restart worker", "વર્કર પુનઃશરૂ")}</button>
              {canOwner && <LimitsEditor lang={lang} w={w} onSave={(lim) => act(() => rpc("mai_worker_set_limits", { p_worker: w.id, p: lim }))} />}
              {canOwner && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => { if (window.confirm(L(lang, "Make a new token? The worker stops until you put the new token in worker\\.env.", "નવો ટોકન બનાવવો?"))) act(async () => setToken((await rpc("mai_worker_rotate", { p_worker: w.id })).token)); }}>{L(lang, "New token", "નવો ટોકન")}</button>}
              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => { if (window.confirm(L(lang, "Disconnect this laptop now? It is refused immediately; its running job goes back in the queue. Registering again gives a new token.", "આ લેપટોપ હમણાં ડિસ્કનેક્ટ કરવું?"))) act(() => rpc("mai_worker_disconnect", { p_worker: w.id })); }}>{L(lang, "Disconnect", "ડિસ્કનેક્ટ")}</button>
            </div>
          </div>
        );
      })}
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={() => act(() => rpc("mai_enqueue_job", { p_type: "SELFTEST", p_payload: { note: "from Control Center" }, p_dedupe: null }))}>{L(lang, "Send a test job", "ટેસ્ટ કામ મોકલો")}</button>
        <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={() => act(() => rpc("mai_enqueue_job", { p_type: "LOCAL_GENERATE", p_payload: { prompt: "In two short sentences, say what a carpenter checks before fitting a wardrobe shutter.", max_tokens: 120 }, p_dedupe: null }))}>{L(lang, "Test local chat model", "લોકલ ચેટ મૉડેલ ટેસ્ટ")}</button>
        <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={() => act(() => rpc("mai_enqueue_job", { p_type: "LOCAL_EMBED", p_payload: { texts: ["teak wood wardrobe with soft-close hinges", "factory dispatch delayed by polishing"] }, p_dedupe: null }))}>{L(lang, "Test local search model", "લોકલ સર્ચ મૉડેલ ટેસ્ટ")}</button>
        {canOwner && <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={async () => { const n = await askText(L(lang, "Name for this laptop worker:", "લેપટોપ વર્કરનું નામ:"), { lang, defaultValue: "Ayush laptop" }); if (n && n.trim()) act(async () => setToken((await rpc("mai_worker_register", { p_name: n.trim() })).token)); }}>{L(lang, "Register a laptop worker", "લેપટોપ વર્કર નોંધો")}</button>}
      </div>
      {(p.recent || []).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <b>{L(lang, "Recent jobs", "તાજેતરનાં કામ")}</b>
          {p.recent.map((j) => (
            <div key={j.id} className="perf-mini-row">
              <span className="sub">{when(j.created_at)}</span><span>{j.job_type}</span>
              <span className={`badge ${j.status === "DONE" ? "COMPLETED" : j.status === "FAILED" ? "RETURNED" : j.status === "RUNNING" ? "IN_PROGRESS" : "ASSIGNED"}`}>{j.status}</span>
              <span className="sub">{j.error || (j.status === "DONE" ? jobSummary(j) : "")}{j.attempts > 1 ? ` · ${j.attempts} attempts` : ""}</span>
              {["QUEUED", "RUNNING"].includes(j.status) && <button type="button" className="btn btn-outline btn-sm" onClick={() => act(() => rpc("mai_cancel_job", { p_job: j.id }))}>{L(lang, "Cancel", "રદ")}</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function jobSummary(j) {
  const r = j.result || {};
  if (j.job_type === "SELFTEST" && r.db_round_trip_ms !== undefined) return `${r.hostname} · DB ${r.db_round_trip_ms} ms · CPU ${r.metrics?.cpu_pct}%`;
  if (j.job_type === "LOCAL_GENERATE") return `${r.model} · ${(r.ms / 1000).toFixed(1)} s · ${r.tokens_per_s ?? "—"} tok/s — “${String(r.text || "").slice(0, 160)}”`;
  if (j.job_type === "LOCAL_CHAT") return `Chat answer · ${r.model ?? "local model"} · ${((r.ms || 0) / 1000).toFixed(1)} s`;
  if (j.job_type === "LOCAL_EMBED") return `${r.model} · ${r.count} × ${r.dimensions} · ${r.ms} ms`;
  return "";
}

function LimitsEditor({ lang, w, onSave }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(null);
  if (!open) return <button type="button" className="btn btn-outline btn-sm" onClick={() => { setF({ ...w.limits, from: w.limits?.working_hours?.from || "", to: w.limits?.working_hours?.to || "" }); setOpen(true); }}>{L(lang, "Limits", "મર્યાદા")}</button>;
  return (
    <div className="perf-weights" style={{ width: "100%" }}>
      <label>{L(lang, "Max CPU %", "મહત્તમ CPU %")}<input type="number" min="10" max="95" value={f.max_cpu_pct} onChange={(e) => setF({ ...f, max_cpu_pct: e.target.value })} /></label>
      <label>{L(lang, "Keep RAM free (GB)", "ખાલી RAM (GB)")}<input type="number" min="1" max="12" step="0.5" value={f.min_free_ram_gb} onChange={(e) => setF({ ...f, min_free_ram_gb: e.target.value })} /></label>
      <label className="mai-toggle"><input type="checkbox" checked={!!f.pause_on_battery} onChange={(e) => setF({ ...f, pause_on_battery: e.target.checked })} /> {L(lang, "Pause on battery", "બેટરી પર અટકાવો")}</label>
      <label>{L(lang, "Working hours from (empty = any time)", "કામના કલાક થી")}<input type="time" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
      <label>{L(lang, "to", "સુધી")}<input type="time" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => { onSave({ max_cpu_pct: Number(f.max_cpu_pct), min_free_ram_gb: Number(f.min_free_ram_gb), max_concurrency: 1, pause_on_battery: !!f.pause_on_battery, working_hours: f.from && f.to ? { from: f.from, to: f.to } : null }); setOpen(false); }}>{L(lang, "Save", "સાચવો")}</button>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setOpen(false)}>{L(lang, "Cancel", "રદ")}</button>
      </div>
    </div>
  );
}
