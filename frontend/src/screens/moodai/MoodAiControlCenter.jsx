import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import {
  controlCenter, emergencyStop, fmtMs, fmtUsd, mfaStartEnroll, mfaState, mfaVerify, resumeAi, runHealthCheck, setAgent, setBackup, setModelPrice, updateSettings,
} from "../../lib/moodAiApi";
import { friendlyError } from "../../lib/friendlyError";
import LaptopServerPanel from "./LaptopServerPanel.jsx";

const L = (lang, en, gu) => (lang === "gu" ? gu : en);
const when = (t) => (t ? String(t).replace("T", " ").slice(0, 16) : "—");

// MOOD AI CONTROL CENTER (v3_19, Phase B). Owner and Management can see it; the database decides what each may change.
export default function MoodAiControlCenter({ lang }) {
  const [d, setD] = useState(null);
  const [state, setState] = useState({ loading: true, error: null, info: null });
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState(null);

  const load = useCallback(async () => {
    try { setD(await controlCenter()); setState((s) => ({ ...s, loading: false, error: null })); }
    catch (e) { setState({ loading: false, error: friendlyError(e?.message), info: null }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, info) => {
    setBusy(true); setState((s) => ({ ...s, error: null, info: null }));
    try { await fn(); await load(); if (info) setState((s) => ({ ...s, info })); } catch (e) { setState((s) => ({ ...s, error: friendlyError(e?.message) })); }
    setBusy(false);
  };
  const stop = () => {
    const reason = window.prompt(L(lang, "Stop every AI feature now. Reason:", "બધી AI સુવિધા હમણાં બંધ કરો. કારણ:"));
    if (reason && reason.trim()) run(() => emergencyStop(reason.trim()), L(lang, "Mood AI is stopped. Every AI feature refuses new requests.", "Mood AI બંધ."));
  };
  const check = async () => {
    setBusy(true); setHealth(null);
    const r = await runHealthCheck();
    setHealth(r); await load(); setBusy(false);
  };

  if (state.loading && !d) return <div className="card sub">{L(lang, "Loading…", "લોડ થાય છે…")}</div>;
  if (!d) return <div className="msg error">{state.error}</div>;
  const s = d.settings || {}; const me = d.me || {}; const canOwner = me.owner_verified;
  return (
    <div className="dept-dashboard perf-page">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🧠</div>
        <div className="dept-header-text">
          <h1>{L(lang, "Mood AI Control Center", "Mood AI કંટ્રોલ સેન્ટર")}</h1>
          <div className="sub">{L(lang, "Every AI feature in the app goes through Mood AI Core: one stop switch, one budget, one usage log.", "દરેક AI સુવિધા Mood AI Core મારફતે ચાલે છે.")}</div>
        </div>
      </div>
      {state.error && <div className="msg error">{state.error}</div>}
      {state.info && <div className="msg success">{state.info}</div>}

      <div className={`card mai-status ${s.ai_enabled ? "on" : "off"}`}>
        <div>
          <b>{s.ai_enabled ? L(lang, "● Mood AI is running", "● Mood AI ચાલુ છે") : L(lang, "■ Mood AI is stopped", "■ Mood AI બંધ છે")}</b>
          {!s.ai_enabled && <div className="sub">{s.stop_reason} — {s.stopped_by_name} · {when(s.stopped_at)}</div>}
        </div>
        <div className="btn-row" style={{ marginLeft: "auto" }}>
          {s.ai_enabled
            ? <button type="button" className="btn btn-danger" style={{ width: "auto" }} disabled={busy} onClick={stop}>{L(lang, "Emergency stop", "તાત્કાલિક બંધ")}</button>
            : <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy || !canOwner} onClick={() => run(resumeAi, L(lang, "Mood AI is running again.", "ફરી ચાલુ."))}
              title={canOwner ? "" : L(lang, "Owner with authenticator check", "માલિક ખાતરી સાથે")}>{L(lang, "Resume", "ફરી ચાલુ કરો")}</button>}
        </div>
      </div>

      <OwnerCard lang={lang} d={d} reload={load} />

      <LaptopServerPanel lang={lang} canOwner={canOwner} />

      <div className="card">
        <h3 className="perf-h">{L(lang, "Connected models", "જોડાયેલા મોડલ")}</h3>
        <div className="report-table-wrap"><table className="report-table">
          <thead><tr><th>{L(lang, "Model", "મોડલ")}</th><th>{L(lang, "Good for", "ઉપયોગ")}</th><th>{L(lang, "$ / million tokens (in / out)", "$ / 10 લાખ ટોકન")}</th><th>{L(lang, "Last check", "છેલ્લી તપાસ")}</th><th /></tr></thead>
          <tbody>{(d.models || []).map((m) => <ModelRow key={`${m.provider}/${m.model}`} m={m} lang={lang} canOwner={canOwner} onSave={(i, o, en) => run(() => setModelPrice(m.provider, m.model, i, o, en), L(lang, "Saved.", "સાચવ્યું."))} />)}</tbody>
        </table></div>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy || !s.ai_enabled} onClick={check}>{L(lang, "Run health check (sends a tiny real request to each model)", "હેલ્થ ચેક ચલાવો")}</button>
        </div>
        {health && (health.ok
          ? <div className="perf-history" style={{ marginTop: 8 }}>{health.results.map((r) => <div key={r.model} className="perf-mini-row"><b>{r.label}</b>
            <span className={`badge ${r.ok ? "COMPLETED" : "RETURNED"}`}>{r.ok ? "OK" : L(lang, "Failed", "નિષ્ફળ")}</span><span>{r.ok ? `${fmtMs(r.latency_ms)} · ${r.input_tokens}+${r.output_tokens} tokens` : r.error}</span></div>)}</div>
          : <div className="msg error">{health.reason}</div>)}
      </div>

      <SettingsCard lang={lang} s={s} models={d.models || []} canOwner={canOwner} onSave={(p) => run(() => updateSettings(p), L(lang, "Settings saved.", "સેટિંગ સાચવ્યા."))} />

      <div className="card">
        <h3 className="perf-h">{L(lang, "Usage and cost", "ઉપયોગ અને ખર્ચ")}</h3>
        <div className="kpi-grid">
          {[[L(lang, "Calls today", "આજે"), d.usage?.today?.calls], [L(lang, "Cost today", "આજનો ખર્ચ"), fmtUsd(d.usage?.today?.cost_usd)], [L(lang, "Calls this month", "આ મહિને"), d.usage?.month?.calls],
            [L(lang, "Cost this month", "આ મહિનાનો ખર્ચ"), fmtUsd(d.usage?.month?.cost_usd)], [L(lang, "Failed this month", "નિષ્ફળ"), d.usage?.month?.failed],
            [L(lang, "Budget", "બજેટ"), s.monthly_budget_usd === null ? L(lang, "none", "નથી") : fmtUsd(s.monthly_budget_usd)]]
            .map(([k, v]) => <div key={k} className="kpi-tile"><div className="num">{v ?? 0}</div><div className="label">{k}</div></div>)}
        </div>
        {Number(d.usage?.month?.unpriced_calls) > 0 && <p className="sub">{L(lang, `${d.usage.month.unpriced_calls} call(s) this month used a model without a price, so their cost is not included. Set the price above.`, "કિંમત વગરના મોડલના કોલ ખર્ચમાં નથી.")}</p>}
        <div className="perf-two" style={{ marginTop: 10 }}>
          <div><b>{L(lang, "By feature (30 days)", "સુવિધા મુજબ")}</b>{(d.usage?.by_feature || []).map((x) => <div key={x.feature} className="perf-mini-row"><span>{x.feature}</span><span>{x.calls} {L(lang, "calls", "કોલ")}{x.failed ? ` (${x.failed} ✕)` : ""}</span><span>{fmtUsd(x.cost_usd)}</span><span className="sub">{fmtMs(x.avg_ms)}</span></div>)}
            {!(d.usage?.by_feature || []).length && <p className="sub">{L(lang, "No AI calls recorded yet.", "હજી કોઈ AI કોલ નથી.")}</p>}</div>
          <div><b>{L(lang, "By model (30 days)", "મોડલ મુજબ")}</b>{(d.usage?.by_model || []).map((x) => <div key={x.model} className="perf-mini-row"><span>{x.model}</span><span>{x.calls} {L(lang, "calls", "કોલ")}</span><span>{fmtUsd(x.cost_usd)}</span><span className="sub">{fmtMs(x.avg_ms)}</span></div>)}</div>
        </div>
      </div>

      <div className="card">
        <h3 className="perf-h">{L(lang, "Agents", "એજન્ટ")}</h3>
        {(d.agents || []).map((a) => (
          <div key={a.code} className="perf-mini-row">
            <span><b>{a.name}</b><div className="sub">{a.description}</div></span>
            <span className="sub">{L(lang, "Phase", "તબક્કો")} {a.built_in_phase}</span>
            {a.is_built
              ? <label className="mai-toggle"><input type="checkbox" checked={a.enabled} disabled={busy || !canOwner} onChange={(e) => run(() => setAgent(a.code, e.target.checked))} /> {a.enabled ? L(lang, "On", "ચાલુ") : L(lang, "Off", "બંધ")}</label>
              : <span className="badge ASSIGNED">{L(lang, "Not built yet", "હજી બન્યું નથી")}</span>}
          </div>
        ))}
      </div>

      <div className="perf-two">
        <div className="card">
          <h3 className="perf-h">{L(lang, "Recent AI errors", "તાજેતરની AI ભૂલો")}</h3>
          {(d.errors || []).length ? d.errors.map((e, i) => <div key={i} className="perf-mini-row"><span className="sub">{when(e.at)}</span><span>{e.feature}</span><span>{e.error}</span></div>)
            : <p className="sub">{L(lang, "None.", "નથી.")}</p>}
        </div>
        <div className="card">
          <h3 className="perf-h">{L(lang, "Activity log (permanent)", "પ્રવૃત્તિ લૉગ (કાયમી)")}</h3>
          {(d.audit || []).length ? d.audit.map((a, i) => <div key={i} className="perf-mini-row"><span className="sub">{when(a.at)}</span><span>{a.action}</span><span>{a.by || "—"}</span></div>)
            : <p className="sub">{L(lang, "Nothing yet.", "હજી કંઈ નથી.")}</p>}
        </div>
      </div>
    </div>
  );
}

function ModelRow({ m, lang, canOwner, onSave }) {
  const [edit, setEdit] = useState(false);
  const [i, setI] = useState(m.input_usd_per_mtok ?? ""); const [o, setO] = useState(m.output_usd_per_mtok ?? "");
  return (
    <tr>
      <td><b>{m.label}</b><div className="sub">{m.provider} · {m.model}{m.enabled ? "" : ` · ${L(lang, "off", "બંધ")}`}</div></td>
      <td className="sub">{m.good_for}</td>
      <td>{edit
        ? <span className="perf-goal-row"><input type="number" min="0" step="0.01" value={i} onChange={(e) => setI(e.target.value)} style={{ width: 80 }} />
          <input type="number" min="0" step="0.01" value={o} onChange={(e) => setO(e.target.value)} style={{ width: 80 }} />
          <button type="button" className="btn btn-primary btn-sm" onClick={() => { onSave(i === "" ? null : Number(i), o === "" ? null : Number(o), m.enabled); setEdit(false); }}>✓</button></span>
        : m.input_usd_per_mtok === null ? <span className="sub">{L(lang, "not priced", "કિંમત નથી")}</span> : `${m.input_usd_per_mtok} / ${m.output_usd_per_mtok}`}</td>
      <td className="sub">{m.last_error ? `✕ ${m.last_error}` : m.last_ok_at ? `✓ ${when(m.last_ok_at)} · ${fmtMs(m.last_latency_ms)}` : L(lang, "never checked", "તપાસ્યું નથી")}</td>
      <td>{canOwner && !edit && <button type="button" className="btn btn-outline btn-sm" onClick={() => setEdit(true)}>{L(lang, "Price", "કિંમત")}</button>}</td>
    </tr>
  );
}

function SettingsCard({ lang, s, models, canOwner, onSave }) {
  const [f, setF] = useState(null);
  useEffect(() => { setF({ chat: `${s.chat_provider}/${s.chat_model}`, effort: s.chat_effort, doc: `${s.document_provider}/${s.document_model}`, ttl: s.approval_ttl_minutes, budget: s.monthly_budget_usd ?? "" }); }, [s]);
  if (!f) return null;
  const opts = models.filter((m) => m.enabled).map((m) => <option key={`${m.provider}/${m.model}`} value={`${m.provider}/${m.model}`}>{m.label}</option>);
  const save = () => {
    const [cp, cm] = f.chat.split("/"); const [dp, dm] = f.doc.split("/");
    onSave({ chat_provider: cp, chat_model: cm, chat_effort: f.effort, document_provider: dp, document_model: dm, approval_ttl_minutes: Number(f.ttl), monthly_budget_usd: f.budget === "" ? "" : String(f.budget) });
  };
  return (
    <div className="card">
      <h3 className="perf-h">{L(lang, "Routing and limits", "રૂટિંગ અને મર્યાદા")}</h3>
      <div className="perf-weights">
        <label>{L(lang, "Chat and commands", "ચેટ અને આદેશ")}<select value={f.chat} disabled={!canOwner} onChange={(e) => setF({ ...f, chat: e.target.value })}>{opts}</select></label>
        <label>{L(lang, "Chat thinking effort", "ચેટ વિચાર સ્તર")}<select value={f.effort} disabled={!canOwner} onChange={(e) => setF({ ...f, effort: e.target.value })}>
          <option value="low">{L(lang, "Low (fastest)", "ઓછું (ઝડપી)")}</option><option value="medium">{L(lang, "Medium", "મધ્યમ")}</option><option value="high">{L(lang, "High (slowest)", "વધુ")}</option></select></label>
        <label>{L(lang, "Documents and photos", "દસ્તાવેજ અને ફોટા")}<select value={f.doc} disabled={!canOwner} onChange={(e) => setF({ ...f, doc: e.target.value })}>{opts}</select></label>
        <label>{L(lang, "Approval expires after (minutes)", "મંજૂરી સમાપ્તિ (મિનિટ)")}<input type="number" min="2" max="240" value={f.ttl} disabled={!canOwner} onChange={(e) => setF({ ...f, ttl: e.target.value })} /></label>
        <label>{L(lang, "Monthly budget in USD (empty = none)", "માસિક બજેટ USD")}<input type="number" min="0" step="1" value={f.budget} disabled={!canOwner} onChange={(e) => setF({ ...f, budget: e.target.value })} /></label>
      </div>
      <p className="sub">{L(lang, "When the monthly budget is used up, every AI feature pauses until the Owner raises it.", "બજેટ પૂરું થાય ત્યારે AI અટકે છે.")}</p>
      {canOwner ? <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={save}>{L(lang, "Save", "સાચવો")}</button>
        : <p className="sub">{L(lang, "Only the Owner, verified with the authenticator app, can change these.", "ફક્ત માલિક બદલી શકે.")}</p>}
    </div>
  );
}

// Owner verification (authenticator app) and the backup approver.
function OwnerCard({ lang, d, reload }) {
  const me = d.me || {};
  const [mfa, setMfa] = useState(null);
  const [enroll, setEnroll] = useState(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState(null);
  const [people, setPeople] = useState([]);
  const [pick, setPick] = useState("");
  const refresh = useCallback(async () => { try { setMfa(await mfaState()); } catch { setMfa(null); } }, []);
  useEffect(() => { if (me.is_owner) refresh(); }, [me.is_owner, refresh]);
  useEffect(() => {
    if (!me.owner_verified || me.kind !== "OWNER") return;
    supabase.from("user_profiles").select("id, full_name, roles:role_id(code)").eq("is_active", true).order("full_name")
      .then(({ data }) => setPeople((data || []).filter((p) => ["management", "sysadmin"].includes(p.roles?.code))));
  }, [me.owner_verified, me.kind]);
  const verify = async (factorId) => {
    setMsg(null);
    try { await mfaVerify(factorId, code); setCode(""); setEnroll(null); await refresh(); await reload(); setMsg({ ok: true, t: L(lang, "Verified. Owner actions are unlocked for this sign-in.", "ખાતરી થઈ.") }); }
    catch (e) { setMsg({ ok: false, t: friendlyError(e?.message) || L(lang, "That code did not work. Try the newest code.", "કોડ ખોટો છે.") }); }
  };
  const owners = d.owners || [];
  const backup = owners.find((o) => o.kind === "BACKUP");
  return (
    <div className="card">
      <h3 className="perf-h">{L(lang, "Owner approvals", "માલિકની મંજૂરી")}</h3>
      <div className="perf-mini-row"><b>{L(lang, "Owner", "માલિક")}</b><span>{owners.find((o) => o.kind === "OWNER")?.full_name || L(lang, "not set", "નક્કી નથી")}</span></div>
      <div className="perf-mini-row"><b>{L(lang, "Backup approver", "બેકઅપ મંજૂરીકર્તા")}</b><span>{backup?.full_name || L(lang, "none", "નથી")}</span>
        {backup && me.owner_verified && me.kind === "OWNER" && <button type="button" className="btn btn-outline btn-sm" onClick={async () => { try { await setBackup(backup.user_id, false); await reload(); } catch (e) { setMsg({ ok: false, t: friendlyError(e?.message) }); } }}>{L(lang, "Remove", "દૂર કરો")}</button>}</div>
      {!backup && me.owner_verified && me.kind === "OWNER" && (
        <div className="perf-goal-row" style={{ marginTop: 6 }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)}><option value="">{L(lang, "Choose a Management account", "મેનેજમેન્ટ ખાતું પસંદ કરો")}</option>
            {people.filter((p) => !owners.some((o) => o.user_id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select>
          <button type="button" className="btn btn-primary btn-sm" disabled={!pick} onClick={async () => { try { await setBackup(pick, true); setPick(""); await reload(); } catch (e) { setMsg({ ok: false, t: friendlyError(e?.message) }); } }}>{L(lang, "Make backup approver", "બેકઅપ બનાવો")}</button>
        </div>
      )}
      {!me.is_owner && <p className="sub">{L(lang, "Owner-level actions (resume, settings, agents, approvals) can only be done by the Owner or the backup approver, from their own account with their authenticator app.",
        "માલિક સ્તરનાં કામ ફક્ત માલિક/બેકઅપ પોતાના ખાતાથી અને ઓથેન્ટિકેટર એપથી કરી શકે.")}</p>}
      {me.is_owner && (
        <div className="mai-verify">
          {me.owner_verified ? <p className="msg success" style={{ margin: "8px 0" }}>✓ {L(lang, "Verified with your authenticator app for this sign-in.", "આ સાઇન-ઇન માટે ખાતરી થઈ.")}</p>
            : mfa && !mfa.enrolled && !enroll ? (
              <>
                <p>{L(lang, "Owner actions need a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator…). Set it up once:", "માલિક કામ માટે ઓથેન્ટિકેટર એપનો 6 અંકનો કોડ જોઈએ. એક વાર સેટ કરો:")}</p>
                <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={async () => { try { setEnroll(await mfaStartEnroll()); } catch (e) { setMsg({ ok: false, t: friendlyError(e?.message) }); } }}>{L(lang, "Set up authenticator app", "ઓથેન્ટિકેટર સેટ કરો")}</button>
              </>
            ) : enroll ? (
              <>
                <p>{L(lang, "Scan this with your authenticator app, then type the 6-digit code it shows.", "આ એપમાં સ્કેન કરો અને 6 અંકનો કોડ લખો.")}</p>
                <img src={enroll.qr} alt="Authenticator QR code" style={{ width: 180, height: 180, background: "#fff", padding: 6, borderRadius: 8 }} />
                <div className="sub" style={{ overflowWrap: "anywhere" }}>{L(lang, "Or enter this key:", "અથવા આ કી:")} <code>{enroll.secret}</code></div>
                <div className="perf-goal-row" style={{ marginTop: 6 }}><input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
                  <button type="button" className="btn btn-primary btn-sm" disabled={code.trim().length !== 6} onClick={() => verify(enroll.factorId)}>{L(lang, "Confirm", "પુષ્ટિ કરો")}</button></div>
              </>
            ) : mfa?.enrolled ? (
              <div className="perf-goal-row"><span>{L(lang, "Enter the code from your authenticator app to unlock owner actions:", "ઓથેન્ટિકેટર કોડ લખો:")}</span>
                <input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
                <button type="button" className="btn btn-primary btn-sm" disabled={code.trim().length !== 6} onClick={() => verify(mfa.factorId)}>{L(lang, "Verify", "ખાતરી કરો")}</button></div>
            ) : <p className="sub">…</p>}
        </div>
      )}
      {msg && <div className={`msg ${msg.ok ? "success" : "error"}`}>{msg.t}</div>}
    </div>
  );
}
