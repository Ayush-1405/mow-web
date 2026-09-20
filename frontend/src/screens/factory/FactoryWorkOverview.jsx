import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import FactoryHeader from "./FactoryHeader.jsx";
import { getWorkOverview, listFactoryLocations, listProductionStages, subscribeFactoryTasks } from "../../lib/factoryApi";
import { useForegroundRefresh } from "../../lib/useForegroundRefresh";
import { fmtDate, STATUS, friendlyRpcError } from "./factoryConstants";
import { TASK_STATUS, PRIORITY_LABEL, progressText } from "./factoryTaskStatus";

const CARDS = [
  ["new_job_cards", "New Job Cards", ""], ["pending_acceptance", "Pending Acceptance", ""], ["active_tasks", "Active Tasks", ""],
  ["in_production", "In Production", ""], ["blocked", "Blocked", "warn"], ["delayed", "Delayed", "warn"],
  ["ready_for_review", "Ready for Review", "hot"], ["completed_today", "Completed Today", ""],
];
const EMPTY = { location: "", production_department: "", supervisor: "", employee: "", source_department: "", job: "", status: "", stage: "", priority: "", from: "", to: "", delayed_only: false };

// Director / Central Tower Factory Work Overview. One RPC (factory_work_overview)
// returns counts + Job Cards + tasks; the server excludes Accounts records and
// refuses anyone who is not Factory leadership / Management.
export default function FactoryWorkOverview({ lang, profile, lookups }) {
  const navigate = useNavigate();
  const [filters, setFilters] = useState(EMPTY);
  const [data, setData] = useState(null);
  const [allJobs, setAllJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [group, setGroup] = useState("job");
  const [locations, setLocations] = useState([]);
  const [stages, setStages] = useState([]);
  const loadedOnce = useRef(false);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    const f = filtersRef.current;
    const payload = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "" && v !== false));
    const { data: d, error: err } = await getWorkOverview(payload);
    if (err) {
      console.error("[FactoryWorkOverview] load failed", err);
      setError(friendlyRpcError(err, "Could not load the Factory overview. Please try again."));
    } else {
      setError(null); setData(d);
      if (Object.keys(payload).length === 0) setAllJobs(d.jobs || []);
    }
    loadedOnce.current = true;
    setLoading(false);
  }, []);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => { load(); }, [load, filters]);
  useEffect(() => subscribeFactoryTasks("fx-overview", () => loadRef.current()), []);
  useForegroundRefresh(useCallback(() => loadRef.current(), []));
  useEffect(() => {
    listFactoryLocations().then(({ data: l }) => setLocations(l || []));
    listProductionStages().then(({ data: s }) => setStages(s || []));
  }, []);

  const set = (k, v) => setFilters((s) => ({ ...s, [k]: v }));
  const people = data?.people || [];
  const supervisors = people.filter((p) => p.role === "dept_head" || p.role === "supervisor");
  const activeCount = Object.entries(filters).filter(([, v]) => v !== "" && v !== false).length;

  const tasksByJob = useMemo(() => {
    const m = {};
    (data?.tasks || []).forEach((t) => { if (t.job_card_id) (m[t.job_card_id] ||= []).push(t); });
    return m;
  }, [data]);
  const standalone = useMemo(() => (data?.tasks || []).filter((t) => !t.job_card_id), [data]);

  // Factory -> Supervisor -> Employee -> Task
  const bySupervisor = useMemo(() => {
    const sup = {};
    (data?.tasks || []).forEach((t) => {
      const s = (sup[t.verifier_name || "No supervisor"] ||= {});
      [t.primary_name || "Unassigned", t.second_name].filter(Boolean).forEach((emp) => { (s[emp] ||= []).push(t); });
    });
    return sup;
  }, [data]);
  const byEmployee = useMemo(() => {
    const m = {};
    (data?.tasks || []).forEach((t) => { [t.primary_name || "Unassigned", t.second_name].filter(Boolean).forEach((n) => { (m[n] ||= []).push(t); }); });
    return m;
  }, [data]);

  return (
    <div className="fx-page">
      <FactoryHeader lang={lang} profile={profile} title="Factory Work Overview" onRefresh={load} refreshing={loading} locations={locations} location={filters.location || null} onLocation={(v) => set("location", v || "")} />

      {error && <div className="msg error" role="alert">{error} <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={load}>Retry</button></div>}
      {loading && !data && <div className="msg info">Loading…</div>}

      {data && (
        <div className="fx-cards">
          {CARDS.map(([k, lbl, cls]) => (
            <div key={k} className={`fx-card ${data.counts[k] > 0 ? cls : ""}`} role="group" aria-label={lbl}>
              <div className="n">{data.counts[k] ?? 0}</div>
              <div className="l">{lbl}</div>
            </div>
          ))}
        </div>
      )}

      <details className="fx-section fx-filterbox">
        <summary>Filters{activeCount ? ` (${activeCount})` : ""}</summary>
        <div className="fx-filters">
          <Field label="Supervisor"><select value={filters.supervisor} onChange={(e) => set("supervisor", e.target.value)}><option value="">All</option>{supervisors.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Employee"><select value={filters.employee} onChange={(e) => set("employee", e.target.value)}><option value="">All</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Job Card"><select value={filters.job} onChange={(e) => set("job", e.target.value)}><option value="">All</option>{allJobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.customer_name || j.product_item || ""}</option>)}</select></Field>
          <Field label="Source department"><select value={filters.source_department} onChange={(e) => set("source_department", e.target.value)}><option value="">All</option>{lookups.departments.filter((d) => !d.is_confidential_domain && d.code !== "FACTORY").map((d) => <option key={d.id} value={d.id}>{d.name_en}</option>)}</select></Field>
          <Field label="Task status"><select value={filters.status} onChange={(e) => set("status", e.target.value)}><option value="">All</option>{["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "VERIFIED", "RETURNED"].map((s) => <option key={s} value={s}>{TASK_STATUS[s].en}</option>)}</select></Field>
          <Field label="Stage"><select value={filters.stage} onChange={(e) => set("stage", e.target.value)}><option value="">All</option>{stages.map((s) => <option key={s.code} value={s.code}>{s.name_en}</option>)}</select></Field>
          <Field label="Priority"><select value={filters.priority} onChange={(e) => set("priority", e.target.value)}><option value="">All</option>{Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Production team"><input value={filters.production_department} onChange={(e) => set("production_department", e.target.value)} placeholder="e.g. Carpentry" /></Field>
          <Field label="Due from"><input type="date" value={filters.from} onChange={(e) => set("from", e.target.value)} /></Field>
          <Field label="Due to"><input type="date" value={filters.to} onChange={(e) => set("to", e.target.value)} /></Field>
          <label className="fx-check"><input type="checkbox" checked={filters.delayed_only} onChange={(e) => set("delayed_only", e.target.checked)} /> Delayed only</label>
          <button type="button" className="btn btn-outline" onClick={() => setFilters(EMPTY)} disabled={!activeCount}>Clear filters</button>
        </div>
      </details>

      <div className="fx-tabs" role="tablist" aria-label="Group by">
        {[["job", "By Job Card"], ["supervisor", "By Supervisor"], ["employee", "By Employee"]].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={group === k} className={group === k ? "active" : ""} onClick={() => setGroup(k)}>{l}</button>
        ))}
      </div>

      {data && group === "job" && (
        <div className="fx-list">
          {data.jobs.length === 0 && standalone.length === 0 && <div className="msg info">Nothing matches these filters.</div>}
          {data.jobs.map((j) => (
            <details key={j.id} className="fx-ov-job">
              <summary>
                <div className="fx-row-top"><b>{j.job_order_number}</b><span className="fx-tag gold">{STATUS[j.factory_status]?.en || j.factory_status}</span></div>
                <div className="sub">{[j.customer_name || j.project_code, j.product_item, j.source_department_name].filter(Boolean).join(" · ")}</div>
                <div className="fx-meta">
                  <span className="fx-tag">{[j.assigned_name, j.second_name].filter(Boolean).join(" + ") || "Not assigned"}</span>
                  {j.current_stage && <span className="fx-tag">{j.current_stage}</span>}
                  <span className="fx-tag">{progressText(j.progress)}</span>
                  <span className={`fx-tag${j.is_delayed ? " bad" : ""}`}>Due {fmtDate(j.required_date)}{j.is_delayed ? " · Delayed" : ""}</span>
                  <span className="fx-tag">Updated {fmtDate(j.updated_at)}</span>
                </div>
              </summary>
              <div className="fx-ov-children">
                <Link className="fx-tag gold" to={`/factory-job/${j.id}`}>Open Job Card →</Link>
                {(tasksByJob[j.id] || []).map((t) => <TaskLine key={t.id} t={t} navigate={navigate} />)}
                {!(tasksByJob[j.id] || []).length && <div className="sub">No tasks yet.</div>}
              </div>
            </details>
          ))}
          {standalone.length > 0 && (
            <details className="fx-ov-job" open>
              <summary><b>Standalone tasks</b> <span className="fx-tag">{standalone.length}</span></summary>
              <div className="fx-ov-children">{standalone.map((t) => <TaskLine key={t.id} t={t} navigate={navigate} />)}</div>
            </details>
          )}
        </div>
      )}

      {data && group === "supervisor" && (
        <div className="fx-list">
          {Object.keys(bySupervisor).length === 0 && <div className="msg info">Nothing matches these filters.</div>}
          {Object.entries(bySupervisor).map(([sup, emps]) => (
            <details key={sup} className="fx-ov-job">
              <summary><b>{sup}</b> <span className="fx-tag">{Object.keys(emps).length} people</span></summary>
              <div className="fx-ov-children">
                {Object.entries(emps).map(([emp, list]) => (
                  <details key={emp} className="fx-ov-sub">
                    <summary>{emp} <span className="fx-tag">{list.length} tasks</span></summary>
                    <div className="fx-ov-children">{list.map((t) => <TaskLine key={t.id} t={t} navigate={navigate} showJob />)}</div>
                  </details>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}

      {data && group === "employee" && (
        <div className="fx-list">
          {Object.keys(byEmployee).length === 0 && <div className="msg info">Nothing matches these filters.</div>}
          {Object.entries(byEmployee).map(([emp, list]) => (
            <details key={emp} className="fx-ov-job">
              <summary><b>{emp}</b> <span className="fx-tag">{list.length} tasks</span> <span className="fx-tag">{list.filter((t) => t.is_overdue).length} overdue</span> <span className="fx-tag">{list.filter((t) => t.status === "ON_HOLD").length} blocked</span></summary>
              <div className="fx-ov-children">{list.map((t) => <TaskLine key={t.id} t={t} navigate={navigate} showJob />)}</div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return <div className="field"><label>{label}</label>{children}</div>;
}

// Every row opens its Task (details, timeline, conversation) -- the Job Card link is on the row header.
function TaskLine({ t, navigate, showJob }) {
  const st = TASK_STATUS[t.status] || { en: t.status, badge: "ASSIGNED" };
  return (
    <button type="button" className={`fx-task-line${t.is_overdue ? " late" : ""}`} onClick={() => navigate(`/?focus=${t.id}`)} aria-label={`Open task ${t.task_number}`}>
      <span className="t"><b>{t.title}</b> <span className={`badge ${st.badge}`}>{st.en}</span></span>
      <span className="sub">{t.task_number}{showJob && t.job_order_number ? ` · ${t.job_order_number}` : ""}{t.stage ? ` · ${t.stage}` : ""} · {t.primary_name || "—"}{t.second_name ? ` + ${t.second_name}` : ""} · Due {fmtDate(t.due_date)}{t.is_overdue ? " (overdue)" : ""}</span>
      {t.blocker && <span className="fx-blocker">⚠ {t.blocker}</span>}
    </button>
  );
}
