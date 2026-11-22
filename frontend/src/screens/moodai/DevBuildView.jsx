import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { devApproveMerge, devDetail } from "../../lib/moodAiApi";
import { subscribeTable } from "../../lib/realtime";
import { checksSummary, fmtDuration, isActive, lastLogId, logFromRow, mergeBlocker, mergeLogs, parseDiff } from "../../lib/devBuild";
import { askText } from "../../lib/askText";

// Live build view for one developer request (v3_26, DR-0008): the laptop's live log (Claude Code progress, stdout, stderr), the
// check report it ran itself (build, lint, tests), the branch diff, and the Owner's merge approval (fresh authenticator code,
// exact commit on screen, every check passed). Owner / backup only (the database refuses everyone else). Realtime pushes new
// lines; while a build is active it also polls every few seconds, so it keeps working if Realtime is not connected.
const L = (lang, en, gu) => (lang === "gu" ? gu : en);
const POLL_MS = 4000;
const STREAMS = { all: null, progress: ["progress"], errors: ["stderr"] };

export default function DevBuildView({ request, lang, onChanged }) {
  const id = request.id;
  const [detail, setDetail] = useState(null);
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState("all");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [openFile, setOpenFile] = useState(null);
  const logsRef = useRef([]);
  const statusRef = useRef(request.status);
  const boxRef = useRef(null);
  const stick = useRef(true);
  logsRef.current = logs;

  const refresh = useCallback(async (full = false) => {
    try {
      const d = await devDetail(id, full ? 0 : lastLogId(logsRef.current));
      setLogs((prev) => mergeLogs(full ? [] : prev, d.logs || []));
      setDetail(d);
      if (d.status !== statusRef.current) { statusRef.current = d.status; onChanged?.(); }
    } catch (e) {
      setMsg(e?.message || "Could not load the build");
    }
  }, [id, onChanged]);

  useEffect(() => { refresh(true); }, [refresh]);

  // realtime: new log lines arrive directly; a change on the request reloads the report / diff
  useEffect(() => {
    const offLogs = subscribeTable(`mai_dev_logs_${id}`, "mai_dev_logs", `request_id=eq.${id}`, (p) => {
      const l = logFromRow(p.new);
      if (l) setLogs((prev) => mergeLogs(prev, [l]));
    });
    const offReq = subscribeTable(`mai_dev_request_${id}`, "mai_dev_requests", `id=eq.${id}`, () => { refresh(false); });
    return () => { offLogs(); offReq(); };
  }, [id, refresh]);

  const active = isActive(detail?.status ?? request.status);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => { if (!document.hidden) refresh(false); }, POLL_MS);
    return () => clearInterval(t);
  }, [active, refresh]);

  // keep the log scrolled to the newest line unless the Owner scrolled up to read
  useEffect(() => { const b = boxRef.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [logs, filter]);
  const onScroll = () => { const b = boxRef.current; if (b) stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40; };

  const shown = useMemo(() => (STREAMS[filter] ? logs.filter((l) => STREAMS[filter].includes(l.s)) : logs), [logs, filter]);
  const files = useMemo(() => parseDiff(detail?.diff_patch), [detail?.diff_patch]);
  const sum = checksSummary(detail?.checks);
  const blocker = mergeBlocker(detail);

  async function approveMerge() {
    const d = detail;
    if (!window.confirm(L(lang, `Merge ${request.ref} (commit ${d.commit_ref}) into main on the laptop?\n\nThis does NOT push or go live. You will be asked for your authenticator code.`,
      `${request.ref} (કમિટ ${d.commit_ref}) લેપટોપ પર main માં મર્જ કરવું? લાઇવ નહીં થાય.`))) return;
    setBusy(true); setMsg("");
    try {
      await devApproveMerge(id, d.commit_ref, async () => askText(L(lang, "Enter the 6-digit code from your authenticator app to approve this merge:", "મર્જ મંજૂર કરવા ઓથેન્ટિકેટર કોડ (6 અંક):"), { lang, inputMode: "numeric", maxLength: 6, okLabel: L(lang, "Approve", "મંજૂર") }));
      setMsg(L(lang, "Merge approved. The laptop merges it into its main (not pushed, not live) and reports back here.", "મર્જ મંજૂર. લેપટોપ અહીં જણાવશે."));
      await refresh(false);
      onChanged?.();
    } catch (e) {
      setMsg(e?.message || "Failed");
    }
    setBusy(false);
  }

  if (!detail) return <div className="mai-build"><p className="sub">{msg || L(lang, "Loading the build…", "લોડ થાય છે…")}</p></div>;
  return (
    <div className="mai-build">
      <div className="mai-build-head">
        <b>{L(lang, "Build", "બિલ્ડ")}</b>
        {active && <span className="mai-live">● {detail.building ? L(lang, "live on the laptop", "લેપટોપ પર ચાલુ") : L(lang, "waiting for the laptop", "લેપટોપની રાહ")}</span>}
        {detail.branch && <span className="sub">{detail.branch}{detail.commit_ref ? ` @ ${detail.commit_ref}` : ""}</span>}
        {detail.merged_commit && <span className="badge COMPLETED">{L(lang, "Merged locally as", "મર્જ")} {detail.merged_commit}</span>}
      </div>
      {msg && <div className="msg">{msg}</div>}

      <details open={active}>
        <summary>{L(lang, "Live log", "લાઇવ લોગ")} ({logs.length}{logs.length >= 2000 ? "+" : ""})</summary>
        <div className="mai-build-filter" role="group" aria-label="Log filter">
          {Object.keys(STREAMS).map((k) => (
            <button key={k} type="button" className={`btn btn-sm ${filter === k ? "btn-primary" : "btn-outline"}`} onClick={() => setFilter(k)}>
              {k === "all" ? L(lang, "All", "બધું") : k === "progress" ? L(lang, "Steps", "પગલાં") : L(lang, "Errors", "ભૂલો")}
            </button>
          ))}
        </div>
        <div className="mai-build-log" ref={boxRef} onScroll={onScroll} aria-live="polite">
          {shown.length === 0 && <div className="sub">{L(lang, "No log lines yet.", "હજુ કોઈ લોગ નથી.")}</div>}
          {shown.map((l) => <div key={l.id} className={`mai-log-${l.s}`}>{l.t}</div>)}
        </div>
      </details>

      <details open={!active && sum.total > 0}>
        <summary>
          {L(lang, "Checks run by the laptop", "લેપટોપની તપાસ")}{" "}
          {sum.total ? <span className={`badge ${sum.allPassed ? "COMPLETED" : "RETURNED"}`}>{sum.passed}/{sum.total} {L(lang, "passed", "પાસ")}</span>
            : <span className="sub">{L(lang, "not run yet", "હજુ નહીં")}</span>}
        </summary>
        {sum.total > 0 && (
          <ul className="mai-checks">
            {detail.checks.map((c, i) => (
              <li key={`${c.name}-${i}`}>
                <span className={`badge ${c.ok ? "COMPLETED" : "RETURNED"}`}>{c.ok ? "PASS" : "FAIL"}</span> <b>{c.name}</b> <span className="sub">{fmtDuration(c.ms)}</span>
                {c.tail && <details><summary className="sub">{L(lang, "output", "આઉટપુટ")}</summary><pre className="mai-dev-prompt">{c.tail}</pre></details>}
              </li>
            ))}
          </ul>
        )}
        <p className="sub">{L(lang, "Database tests (backend/supabase/tests) need a database and are run by you when you apply a migration.", "ડેટાબેઝ ટેસ્ટ તમે ચલાવો.")}</p>
      </details>

      <details>
        <summary>{L(lang, "Changes on the branch", "બ્રાન્ચના ફેરફાર")} {files.length ? `(${files.length} ${L(lang, "files", "ફાઇલ")})` : ""}</summary>
        {!detail.diff_stat && !files.length && <p className="sub">{L(lang, "No changes reported yet.", "હજુ કોઈ ફેરફાર નથી.")}</p>}
        {detail.diff_stat && <pre className="mai-dev-prompt">{detail.diff_stat}</pre>}
        {detail.diff_truncated && <p className="sub">{L(lang, "The change is large; only the first part is shown here. The full diff is on the laptop branch.", "મોટો ફેરફાર; શરૂઆતનો ભાગ જ.")}</p>}
        {files.map((f) => (
          <div key={f.path} className="mai-diff-file">
            <button type="button" className="perf-mini-row mai-dev-head" onClick={() => setOpenFile(openFile === f.path ? null : f.path)}>
              <span>{f.path}</span>{f.added && <span className="sub">new</span>}{f.deleted && <span className="sub">deleted</span>}
              <span className="mai-diff-add">+{f.adds}</span><span className="mai-diff-del">−{f.dels}</span>
            </button>
            {openFile === f.path && (f.binary ? <p className="sub">{L(lang, "Binary file", "બાઇનરી ફાઇલ")}</p> : (
              <pre className="mai-diff">{f.lines.slice(0, 1500).map((l, i) => <div key={i} className={`mai-diff-${l.k}`}>{l.t || " "}</div>)}
                {f.lines.length > 1500 && <div className="sub">… {f.lines.length - 1500} {L(lang, "more lines", "વધુ લાઇન")}</div>}</pre>
            ))}
          </div>
        ))}
      </details>

      {detail.status === "READY_FOR_REVIEW" && (
        <div className="mai-merge">
          <p className="sub">{L(lang, "Merging puts this branch into main on the laptop only. It is not pushed and not live; database changes and going live stay separate steps for you.",
            "મર્જ ફક્ત લેપટોપ પર. પુશ / લાઇવ નહીં.")}</p>
          {blocker && <p className="msg">{blocker}</p>}
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !!blocker} onClick={approveMerge}>
            {L(lang, `Approve merge of ${detail.commit_ref || "…"} (authenticator)`, "મર્જ મંજૂર કરો (ઓથેન્ટિકેટર)")}
          </button>
        </div>
      )}
      {detail.status === "MERGE_APPROVED" && <p className="sub">{L(lang, "Merge approved; waiting for the laptop to merge (approvals not used within 24 hours expire).", "લેપટોપ મર્જ કરશે.")}</p>}
      {detail.status === "MERGED" && <p className="sub">{L(lang, "Merged on the laptop. Not pushed, not live: push, apply any migration and go live as separate, approved steps.", "લેપટોપ પર મર્જ. લાઇવ નહીં.")}</p>}
    </div>
  );
}
