import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import FactoryTaskForm from "./FactoryTaskForm.jsx";
import { getJobProgress, listJobTasks, subscribeFactoryTasks } from "../../lib/factoryApi";
import { fmtDate } from "./factoryConstants";
import { TASK_STATUS, progressText } from "./factoryTaskStatus";

// Tasks that belong to one Job Card + a real roll-up (counts of actual tasks;
// never a typed percentage). Employees only see the tasks they are on, but the
// roll-up counts every task of the Job Card (computed server-side).
export default function FactoryJobTasks({ job, lang, lookups, canCreate }) {
  const [tasks, setTasks] = useState([]);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState(null);
  const jobId = job.id;

  const load = useCallback(async () => {
    const [t, p] = await Promise.all([listJobTasks(jobId), getJobProgress([jobId])]);
    if (t.error || p.error) { console.error("[FactoryJobTasks] load failed", t.error || p.error); setError(true); return; }
    setError(false);
    setTasks(t.data);
    setProgress(p.data[jobId] || null);
  }, [jobId]);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeFactoryTasks(`fx-jobtasks-${jobId}`, () => loadRef.current()), [jobId]);

  const open = !["cancelled", "completed"].includes(job.factory_status);
  return (
    <div>
      <div className="fx-kv">
        <div><div className="k">Progress</div><div className="v">{progressText(progress)}</div></div>
        <div><div className="k">In progress</div><div className="v">{progress?.in_progress ?? 0}</div></div>
        <div><div className="k">Waiting to start</div><div className="v">{progress?.pending ?? 0}</div></div>
        <div><div className="k">Blocked</div><div className="v">{progress?.blocked ?? 0}</div></div>
        <div><div className="k">Ready for review</div><div className="v">{progress?.review ?? 0}</div></div>
        <div><div className="k">Next due</div><div className="v">{fmtDate(progress?.next_due)}</div></div>
        {progress?.qty_total != null && <div><div className="k">Quantity done</div><div className="v">{progress.qty_done ?? 0} / {progress.qty_total}</div></div>}
      </div>

      {error && <div className="msg error" style={{ marginTop: 8 }}>Could not load tasks. <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={load}>Retry</button></div>}
      {note && <div className="msg success" style={{ marginTop: 8 }}>{note}</div>}

      {canCreate && open && (
        <div style={{ marginTop: 10 }}>
          {adding ? (
            <FactoryTaskForm lang={lang} lookups={lookups} presetJob={job} onCancel={() => setAdding(false)}
              onCreated={(r) => { setAdding(false); setNote(`Task ${r.task_number} created.`); load(); }} />
          ) : (
            <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setAdding(true)}>+ Add task for this Job Card</button>
          )}
        </div>
      )}

      <div className="fx-list" style={{ marginTop: 10 }}>
        {!error && tasks.length === 0 && <div className="msg info">No tasks yet. Tasks appear here automatically once the Job Card is assigned.</div>}
        {tasks.map((t) => {
          const st = TASK_STATUS[t.status] || { en: t.status, badge: "ASSIGNED" };
          return (
            <Link key={t.id} to={`/?focus=${t.id}`} className={`fx-row${t.is_overdue ? " late" : ""}`}>
              <div className="fx-row-top"><b>{t.title}</b><span className={`badge ${st.badge}`}>{st.en}</span></div>
              <div className="sub">{t.task_number}{t.item_name ? ` · ${t.item_name}` : ""}{t.stage ? ` · ${t.stage}` : ""} · {t.primary_name || "—"}{t.second_name ? ` + ${t.second_name}` : ""}</div>
              <div className="sub">Due {fmtDate(t.due_date)}{t.is_overdue ? " (overdue)" : ""}{t.blocker ? ` · ⚠ ${t.blocker}` : ""}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
