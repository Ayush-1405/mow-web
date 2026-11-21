import React, { useCallback, useEffect, useState } from "react";
import { devAnswer, devCancel, devEdit, devList, devSubmit, withOwnerVerification } from "../../lib/moodAiApi";

// Developer requests (v3_23): what the Owner asked Mood AI to change in the app, the developer prompt it wrote, and every step
// the developer reported since. Approving (submit / answer) needs the authenticator app. Owner and backup only.
const L = (lang, en, gu) => (lang === "gu" ? gu : en);
const STATUS = {
  DRAFT: ["Draft — not sent", "ASSIGNED"], SUBMITTED: ["Sent to developer", "IN_PROGRESS"], IN_PROGRESS: ["Being built", "IN_PROGRESS"],
  NEEDS_INFO: ["Needs your answer", "ON_HOLD"], READY_FOR_REVIEW: ["Ready for your review", "ON_HOLD"], LIVE: ["Live", "COMPLETED"],
  DONE: ["Done", "COMPLETED"], REJECTED: ["Not done", "RETURNED"], CANCELLED: ["Cancelled", "RETURNED"],
};
const when = (v) => (v ? new Date(v).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const askCode = (lang) => async () => window.prompt(L(lang, "Enter the 6-digit code from your authenticator app:", "ઓથેન્ટિકેટર કોડ (6 અંક):"));

export default function DevRequestsPanel({ lang }) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => devList().then(setList).catch((e) => { setList([]); setMsg(e.message); }), []);
  useEffect(() => { load(); }, [load]);

  async function act(fn, ok) {
    setBusy(true); setMsg("");
    try { await fn(); setMsg(ok); await load(); } catch (e) { setMsg(e?.message || "Failed"); }
    setBusy(false);
  }

  if (list === null) return <div className="card"><h3 className="perf-h">{L(lang, "Developer requests", "ડેવલપર વિનંતીઓ")}</h3><p className="sub">…</p></div>;
  return (
    <div className="card" id="dev-requests">
      <h3 className="perf-h">🛠 {L(lang, "Developer requests", "ડેવલપર વિનંતીઓ")}</h3>
      <p className="sub">{L(lang, "Ask for app changes in the Mood AI chat (🛠 Developer request). Mood AI writes the developer prompt; nothing is built until you approve it with your authenticator app, and nothing goes live without your separate yes. You get a notification at every step.",
        "Mood AI ચેટમાં (🛠) ફેરફાર માગો. મંજૂરી વગર કંઈ બનતું નથી.")}</p>
      {msg && <div className="msg">{msg}</div>}
      {list.length === 0 && <p className="sub">{L(lang, "No requests yet.", "હજુ કોઈ વિનંતી નથી.")}</p>}
      {list.map((r) => {
        const [label, badge] = STATUS[r.status] || [r.status, "ASSIGNED"];
        const isOpen = open === r.id;
        return (
          <div key={r.id} className="mai-dev-row">
            <button type="button" className="perf-mini-row mai-dev-head" onClick={() => setOpen(isOpen ? null : r.id)}>
              <b>{r.ref}</b><span>{r.title}</span><span className={`badge ${badge}`}>{L(lang, label, label)}</span>
              <span className={`mai-risk ${r.risk}`}>{r.risk}</span><span className="sub">{when(r.updated_at)}</span>
            </button>
            {isOpen && (
              <div className="mai-dev-body">
                <p><b>{L(lang, "Goal", "હેતુ")}:</b> {r.goal}</p>
                {(r.acceptance || []).length > 0 && <><b>{L(lang, "Done when", "પૂર્ણ ક્યારે")}</b><ul>{r.acceptance.map((a) => <li key={a}>{a}</li>)}</ul></>}
                {(r.questions || []).length > 0 && <><b>{L(lang, "Open questions", "પ્રશ્નો")}</b><ul>{r.questions.map((a) => <li key={a}>{a}</li>)}</ul></>}
                {r.branch && <p className="sub">{L(lang, "Branch", "બ્રાન્ચ")}: {r.branch}{r.commit_ref ? ` · ${r.commit_ref}` : ""}</p>}
                <details><summary>{L(lang, "Developer prompt", "ડેવલપર પ્રોમ્પ્ટ")}</summary><pre className="mai-dev-prompt">{r.prompt}</pre></details>
                <b>{L(lang, "History", "ઇતિહાસ")}</b>
                <ul className="mai-dev-events">{(r.events || []).map((e, i) => <li key={i}><span className="sub">{when(e.at)} · {e.by}</span>{e.status ? ` · ${e.status}` : ""} — {e.note}</li>)}</ul>
                <div className="btn-row">
                  {r.status === "DRAFT" && <>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy}
                      onClick={() => act(() => withOwnerVerification(() => devSubmit(r.id), askCode(lang)), L(lang, `${r.ref} sent to the developer.`, "મોકલ્યું."))}>{L(lang, "Approve & send to developer", "મંજૂર કરી મોકલો")}</button>
                    <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => {
                      const t = window.prompt(L(lang, "Title", "શીર્ષક"), r.title); if (t === null) return;
                      const pr = window.prompt(L(lang, "Developer prompt (edit if needed)", "પ્રોમ્પ્ટ"), r.prompt); if (pr === null) return;
                      act(() => devEdit(r.id, t, pr), L(lang, "Saved.", "સાચવ્યું."));
                    }}>{L(lang, "Edit", "ફેરફાર")}</button>
                  </>}
                  {r.status === "NEEDS_INFO" && (
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => {
                      const a = window.prompt(L(lang, "Your answer for the developer:", "ડેવલપર માટે જવાબ:")); if (!a) return;
                      act(() => withOwnerVerification(() => devAnswer(r.id, a), askCode(lang)), L(lang, "Answer sent.", "જવાબ મોકલ્યો."));
                    }}>{L(lang, "Answer the question", "જવાબ આપો")}</button>
                  )}
                  {!["LIVE", "DONE", "CANCELLED"].includes(r.status) && (
                    <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => { if (window.confirm(L(lang, `Cancel ${r.ref}?`, "રદ કરવું?"))) act(() => devCancel(r.id), L(lang, "Cancelled.", "રદ.")); }}>{L(lang, "Cancel request", "રદ કરો")}</button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
