import React, { useCallback, useEffect, useState } from "react";
import { releaseApprove, releaseCancel, releaseList, releaseRequest, releaseRollback } from "../../lib/moodAiApi";

// Phase G deployment manager (v3_28): put what was merged on the laptop live, in fixed steps the laptop runs after the Owner
// approves the exact plan with the authenticator app. Owner and backup only.
const L = (lang, en, gu) => (lang === "gu" ? gu : en);
const STATUS = {
  REQUESTED: ["Laptop is preparing the plan", "IN_PROGRESS"], PLANNED: ["Plan ready — needs your approval", "ON_HOLD"],
  NOTHING_TO_RELEASE: ["Nothing new to put live", "COMPLETED"], APPROVED: ["Approved — starting", "IN_PROGRESS"], RUNNING: ["Going live…", "IN_PROGRESS"],
  LIVE: ["Live", "COMPLETED"], FAILED: ["Stopped", "RETURNED"], ROLLBACK_APPROVED: ["Rollback approved", "IN_PROGRESS"],
  ROLLING_BACK: ["Rolling back…", "IN_PROGRESS"], ROLLED_BACK: ["Rolled back", "COMPLETED"], CANCELLED: ["Cancelled", "RETURNED"],
};
const BUSY = new Set(["REQUESTED", "APPROVED", "RUNNING", "ROLLBACK_APPROVED", "ROLLING_BACK"]);
const when = (v) => (v ? new Date(v).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const askCode = (lang) => async () => window.prompt(L(lang, "Enter the 6-digit code from your authenticator app:", "ઓથેન્ટિકેટર કોડ (6 અંક):"));
const base = (p) => String(p).split("/").pop();

export default function ReleasesPanel({ lang }) {
  const [list, setList] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => releaseList().then(setList).catch((e) => { setList([]); setMsg(e.message); }), []);
  useEffect(() => { load(); }, [load]);
  // while the laptop works, refresh every 10 s
  const working = (list || []).some((r) => BUSY.has(r.status));
  useEffect(() => { if (!working) return undefined; const t = setInterval(load, 10_000); return () => clearInterval(t); }, [working, load]);

  async function act(fn, ok) {
    setBusy(true); setMsg("");
    try { await fn(); setMsg(ok); await load(); } catch (e) { setMsg(e?.message || "Failed"); }
    setBusy(false);
  }
  const open = (list || []).find((r) => !["LIVE", "FAILED", "ROLLED_BACK", "CANCELLED", "NOTHING_TO_RELEASE"].includes(r.status));

  return (
    <div className="card" id="releases">
      <h3 className="perf-h">🚀 {L(lang, "Releases (go live)", "રિલીઝ (લાઇવ કરો)")}</h3>
      <p className="sub">{L(lang,
        "Puts what was merged on the laptop live. The laptop makes a plan; after you approve it with your authenticator app it runs fixed steps: backup, database trial with tests, database change, server functions, website, health check. It stops at the first problem. The laptop must have RELEASE=on in worker/.env.",
        "લેપટોપ પર મર્જ થયેલું લાઇવ કરે છે. તમારી મંજૂરી (ઓથેન્ટિકેટર) પછી જ.")}</p>
      {msg && <div className="msg">{msg}</div>}
      {!open && <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy} onClick={() => act(releaseRequest, L(lang, "Asked the laptop for a release plan.", "પ્લાન માગ્યો."))}>{L(lang, "Prepare a release", "રિલીઝ તૈયાર કરો")}</button>}
      {list === null && <p className="sub">…</p>}
      {(list || []).slice(0, 8).map((r) => {
        const [label, badge] = STATUS[r.status] || [r.status, "ASSIGNED"];
        const p = r.plan || {};
        return (
          <div key={r.id} className="mai-dev-row">
            <div className="perf-mini-row mai-dev-head"><b>{r.ref}</b><span>{r.commit_ref ? String(r.commit_ref).slice(0, 9) : ""}</span><span className={`badge ${badge}`}>{label}</span><span className="sub">{when(r.updated_at)}</span></div>
            <div className="mai-dev-body">
              {(p.commits || []).length > 0 && <>
                <b>{L(lang, "What goes live", "શું લાઇવ થશે")}</b>
                <ul>{p.commits.slice(0, 12).map((c) => <li key={c.sha}><code>{c.sha}</code> {c.subject}</li>)}{p.commits.length > 12 && <li>… {p.commits.length - 12} more</li>}</ul>
                <p className="sub">
                  {L(lang, "Database changes", "ડેટાબેઝ ફેરફાર")}: {(p.migrations || []).length ? p.migrations.map(base).join(", ") : L(lang, "none", "નથી")}
                  {" · "}{L(lang, "Tests", "ટેસ્ટ")}: {(p.tests || []).length}
                  {" · "}{L(lang, "Server functions", "સર્વર ફંક્શન")}: {(p.functions || []).length ? p.functions.join(", ") : L(lang, "none", "નથી")}
                  {" · "}{L(lang, "Website", "વેબસાઇટ")}: {p.website ? L(lang, "changes", "બદલાશે") : L(lang, "no change", "નહીં")}
                </p>
              </>}
              {r.note && <p className="sub">{r.note}</p>}
              {(r.steps || []).length > 0 && <ul className="mai-dev-events">{r.steps.map((s, i) => <li key={i}>{s.ok ? "✅" : "❌"} <b>{s.name}</b> — {s.note} <span className="sub">{when(s.at)}</span></li>)}</ul>}
              {r.backup_file && <p className="sub">{L(lang, "Backup", "બેકઅપ")}: {r.backup_file}</p>}
              <div className="btn-row">
                {r.status === "PLANNED" && <button type="button" className="btn btn-primary btn-sm" disabled={busy}
                  onClick={() => window.confirm(L(lang, `Put ${r.ref} live now (${(p.commits || []).length} change(s), ${(p.migrations || []).length} database change(s))?`, "હવે લાઇવ કરવું?"))
                    && act(() => releaseApprove(r.id, r.commit_ref, askCode(lang)), L(lang, "Approved. The laptop starts within a minute.", "મંજૂર."))}>{L(lang, "Approve & go live", "મંજૂર કરી લાઇવ કરો")}</button>}
                {["PLANNED", "APPROVED", "NOTHING_TO_RELEASE"].includes(r.status) && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => act(() => releaseCancel(r.id), L(lang, "Cancelled.", "રદ."))}>{L(lang, "Cancel", "રદ")}</button>}
                {["LIVE", "FAILED"].includes(r.status) && r.approved_at && r === (list || []).find((x) => ["LIVE", "FAILED", "ROLLED_BACK"].includes(x.status)) && (
                  <button type="button" className="btn btn-outline btn-sm" disabled={busy}
                    onClick={() => window.confirm(L(lang, "Roll back the website and server functions to the version before this release? Database changes stay.", "વેબસાઇટ અને ફંક્શન પાછા લાવવા?"))
                      && act(() => releaseRollback(r.id, askCode(lang)), L(lang, "Rollback approved. The laptop starts within a minute.", "રોલબેક મંજૂર."))}>{L(lang, "Roll back website & functions", "પાછું લાવો")}</button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
