import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import FactoryHeader from "./FactoryHeader.jsx";
import { getDashboardCounts, listFactoryLocations, listFactoryPeople, listJobCards, subscribeJobs } from "../../lib/factoryApi";
import { INBOX_TABS, PRIORITIES, STATUS, fmtDate, label, roleInfo } from "./factoryConstants";

const PAGE = 30;

const MODE_TABS = {
  inbox: INBOX_TABS,
  jobcards: [
    ["active", { en: "Active", gu: "સક્રિય" }], ["all", { en: "All", gu: "બધા" }], ["delayed", { en: "Delayed", gu: "વિલંબિત" }],
    ["done_today", { en: "Ready / Completed Today", gu: "આજે તૈયાર / પૂર્ણ" }], ["completed", { en: "Completed", gu: "પૂર્ણ" }],
  ],
  requests: [
    ["all", { en: "All", gu: "બધા" }], ["active", { en: "Active", gu: "સક્રિય" }],
    ["returned", { en: "Returned", gu: "પરત" }], ["completed", { en: "Completed", gu: "પૂર્ણ" }],
  ],
};
const MODE_DEFAULT = { inbox: "new", jobcards: "active", requests: "all", mytasks: "mine", completed: "completed" };
const MODE_TITLE = {
  inbox: { en: "Factory Inbox", gu: "ફેક્ટરી ઇનબોક્સ" }, jobcards: { en: "Job Cards", gu: "જોબ કાર્ડ" },
  mytasks: { en: "My Tasks", gu: "મારા કાર્યો" }, completed: { en: "Completed", gu: "પૂર્ણ" },
  requests: { en: "My Factory Requests", gu: "મારી ફેક્ટરી વિનંતીઓ" },
};
const TAB_COUNT_KEY = { new: "new_requests", verify: "needs_verification", accepted: "accepted_unassigned", assigned: "assigned", in_production: "in_production", returned: "needs_clarification", delayed: "delayed_blocked" };

function JobRow({ r, lang }) {
  const deptName = lang === "gu" ? r.source_department_name_gu || r.source_department_name : r.source_department_name;
  return (
    <Link to={`/factory-job/${r.id}`} className="fx-row">
      <div className="top">
        <div>
          <div className="no">{r.job_order_number}</div>
          <div className="meta">{deptName || "—"}{r.source_reference ? ` · ${r.source_reference}` : ""}</div>
        </div>
        <div>
          <div className="item">{r.product_item || "—"}</div>
          <div className="meta">{r.customer_name || r.project_code || "—"}{r.project_code && r.customer_name ? ` · ${r.project_code}` : ""}</div>
        </div>
        <div>
          <div className="meta">{r.item_count} {lang === "gu" ? "આઇટમ" : r.item_count === 1 ? "item" : "items"}{r.qty_summary ? ` · ${r.qty_summary}` : ""}</div>
        </div>
        <div>
          <div className="meta">{lang === "gu" ? "જરૂરી" : "Required"}: <strong>{fmtDate(r.required_date)}</strong></div>
          <div className="meta">{r.priority}</div>
        </div>
        <div>
          <span className={`badge ${STATUS[r.factory_status]?.badge}`}>{label(STATUS, r.factory_status, lang)}</span>
          <div className="meta">{r.assigned_name ? `👤 ${r.assigned_name}${r.second_name ? ` +1` : ""}` : (lang === "gu" ? "સોંપાયું નથી" : "Unassigned")}</div>
        </div>
      </div>
      <div className="flags">
        {r.missing_count > 0 && <span className="fx-tag gold">⚠ {r.missing_count} {lang === "gu" ? "માહિતી ખૂટે છે" : "missing"}</span>}
        <span className="fx-tag">{r.drawing_count > 0 ? "📎" : "🚫"} {r.file_count} {lang === "gu" ? "ફાઇલ" : "files"}{r.drawing_count === 0 ? (lang === "gu" ? " · ડ્રોઈંગ નથી" : " · no drawing") : ""}</span>
        {r.is_delayed && <span className="fx-tag bad">{r.is_blocked ? (lang === "gu" ? "અટકેલું" : "Blocked") : (lang === "gu" ? "વિલંબિત" : "Delayed")}</span>}
      </div>
    </Link>
  );
}

// ONE list component behind Factory Inbox, Job Cards, My Tasks, Completed and
// (for source departments) My Factory Requests -- different presets over the
// same real query, never separate boards.
export default function FactoryInbox({ lang, profile, lookups, mode = "inbox" }) {
  const navigate = useNavigate();
  const role = roleInfo(profile, lookups);
  const [params, setParams] = useSearchParams();
  const tabs = MODE_TABS[mode] || null;
  const tab = tabs ? (tabs.some(([k]) => k === params.get("tab")) ? params.get("tab") : MODE_DEFAULT[mode]) : MODE_DEFAULT[mode];
  const loc = params.get("loc") || null;

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [f, setF] = useState({ dept: "", status: "", assignee: "", dueFrom: "", dueTo: "", priority: "", delayed: "" });
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [limitTo, setLimitTo] = useState(PAGE);
  const [error, setError] = useState(false);
  const [counts, setCounts] = useState(null);
  const [people, setPeople] = useState([]);
  const [locations, setLocations] = useState([]);
  const [myProfile, setMyProfile] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const reqId = useRef(0);

  useEffect(() => { const h = window.setTimeout(() => setDebounced(search), 250); return () => window.clearTimeout(h); }, [search]);
  useEffect(() => { listFactoryLocations().then(({ data }) => setLocations(data || [])); }, []);
  useEffect(() => { if (mode === "mytasks") supabase.rpc("factory_my_profile_id").then(({ data }) => setMyProfile(data || "none")); }, [mode]);
  useEffect(() => { if (role.isManager) listFactoryPeople().then(({ data }) => setPeople(data || [])); }, [role.isManager]);
  useEffect(() => { setLimitTo(PAGE); }, [tab, debounced, f, loc, mode]);

  const load = useCallback(async () => {
    if (mode === "mytasks" && !myProfile) return;
    if (mode === "mytasks" && myProfile === "none") { setRows([]); setTotal(0); setError(false); return; }
    const id = ++reqId.current;
    setRefreshing(true);
    const [list, c] = await Promise.all([
      listJobCards({
        tab, search: debounced, sourceDept: f.dept, status: f.status, location: loc, assignee: f.assignee, dueFrom: f.dueFrom, dueTo: f.dueTo,
        priority: f.priority, delayed: f.delayed === "yes" ? true : f.delayed === "no" ? false : undefined,
        profileId: myProfile && myProfile !== "none" ? myProfile : null, from: 0, to: limitTo - 1,
      }),
      mode === "inbox" ? getDashboardCounts(loc) : Promise.resolve({ data: null }),
    ]);
    if (id !== reqId.current) return;
    if (list.error) {
      console.error("[FactoryInbox] load failed", { message: list.error.message, code: list.error.code });
      setError(true);
    } else {
      setError(false);
      setRows(list.data || []);
      setTotal(list.count ?? (list.data || []).length);
      if (c.data) setCounts(c.data);
    }
    setRefreshing(false);
  }, [mode, tab, debounced, f, loc, limitTo, myProfile]);

  useEffect(() => { load(); }, [load]);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => subscribeJobs(`fx-list-${mode}`, () => loadRef.current()), [mode]);

  const setTab = (k) => { const p = new URLSearchParams(params); p.set("tab", k); setParams(p, { replace: true }); };
  const clearFilters = () => { setF({ dept: "", status: "", assignee: "", dueFrom: "", dueTo: "", priority: "", delayed: "" }); setSearch(""); };
  const activeFilters = useMemo(() => Object.values(f).filter(Boolean).length + (debounced ? 1 : 0), [f, debounced]);
  const depts = (lookups?.departments || []).filter((d) => d.is_active);
  const title = label(MODE_TITLE, mode, lang);

  const emptyText = {
    inbox: lang === "gu" ? "કોઈ નવી ફેક્ટરી વિનંતી નથી" : "No Factory requests here",
    mytasks: lang === "gu" ? "આજે તમને કોઈ કાર્ય સોંપાયું નથી" : "No tasks assigned to you today",
    jobcards: lang === "gu" ? "કોઈ જોબ કાર્ડ મળ્યા નથી" : "No Job Cards found",
    completed: lang === "gu" ? "હજી કોઈ પૂર્ણ થયું નથી" : "Nothing completed yet",
    requests: lang === "gu" ? "તમે હજી કોઈ વિનંતી મોકલી નથી" : "You have not sent any Factory requests yet",
  }[mode];

  return (
    <div className="fx-page">
      <FactoryHeader lang={lang} profile={profile} title={title} onRefresh={load} refreshing={refreshing}
        showNav={role.inFactory || role.admin} locations={locations} location={loc}
        onLocation={(v) => { const p = new URLSearchParams(params); if (v) p.set("loc", v); else p.delete("loc"); setParams(p, { replace: true }); }} />

      {mode === "requests" && !role.inFactory && !role.admin && (
        <div className="btn-row">
          <button type="button" className="btn btn-primary" style={{ width: "auto", marginTop: 0 }} onClick={() => navigate("/factory-request")}>
            {lang === "gu" ? "ફેક્ટરીને મોકલો" : "Send to Factory"}
          </button>
        </div>
      )}

      {tabs && (
        <div className="fx-tabs" role="tablist">
          {tabs.map(([k, lbl]) => {
            const n = mode === "inbox" && counts ? counts[TAB_COUNT_KEY[k]] : undefined;
            return (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
                {lang === "gu" ? lbl.gu : lbl.en}{n !== undefined && <span className="c">{n}</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="fx-section">
        <div className="task-meta" style={{ gap: 8, flexWrap: "wrap" }}>
          <input style={{ flex: "1 1 220px" }} value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={lang === "gu" ? "જોબ નં., ઓર્ડર, ગ્રાહક, પ્રોજેક્ટ, આઇટમ, કર્મચારી શોધો" : "Search job no., order, customer, project, item, employee"} aria-label="Search" />
          <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={() => setShowFilters((v) => !v)}>
            {lang === "gu" ? "ફિલ્ટર" : "Filters"}{activeFilters > 0 ? ` (${activeFilters})` : ""}
          </button>
        </div>
        {showFilters && (
          <div className="fx-filters" style={{ marginTop: 8 }}>
            <div className="field"><label>{lang === "gu" ? "સ્રોત વિભાગ" : "Source department"}</label>
              <select value={f.dept} onChange={(e) => setF({ ...f, dept: e.target.value })}>
                <option value="">—</option>{depts.map((d) => <option key={d.id} value={d.id}>{lang === "gu" ? d.name_gu || d.name_en : d.name_en}</option>)}
              </select></div>
            {(mode === "jobcards" || mode === "requests") && (
              <div className="field"><label>{lang === "gu" ? "સ્થિતિ" : "Status"}</label>
                <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
                  <option value="">—</option>{Object.keys(STATUS).map((k) => <option key={k} value={k}>{label(STATUS, k, lang)}</option>)}
                </select></div>
            )}
            {role.isManager && (
              <div className="field"><label>{lang === "gu" ? "સોંપાયેલ" : "Assigned person"}</label>
                <select value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
                  <option value="">—</option>{people.map((p) => <option key={p.profile_id} value={p.profile_id}>{p.name}</option>)}
                </select></div>
            )}
            <div className="field"><label>{lang === "gu" ? "જરૂરી તારીખ (થી)" : "Required from"}</label><input type="date" value={f.dueFrom} onChange={(e) => setF({ ...f, dueFrom: e.target.value })} /></div>
            <div className="field"><label>{lang === "gu" ? "જરૂરી તારીખ (સુધી)" : "Required to"}</label><input type="date" value={f.dueTo} onChange={(e) => setF({ ...f, dueTo: e.target.value })} /></div>
            <div className="field"><label>{lang === "gu" ? "અગ્રતા" : "Priority"}</label>
              <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
                <option value="">—</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select></div>
            <div className="field"><label>{lang === "gu" ? "વિલંબ" : "Delay"}</label>
              <select value={f.delayed} onChange={(e) => setF({ ...f, delayed: e.target.value })}>
                <option value="">—</option><option value="yes">{lang === "gu" ? "વિલંબિત" : "Delayed"}</option><option value="no">{lang === "gu" ? "સમયસર" : "Not delayed"}</option>
              </select></div>
            <button type="button" className="btn btn-outline" style={{ marginTop: 0 }} onClick={clearFilters}>{lang === "gu" ? "ફિલ્ટર સાફ કરો" : "Clear filters"}</button>
          </div>
        )}
      </div>

      {error && (
        <div className="msg error">
          {lang === "gu" ? "ઇનબોક્સ લોડ થઈ શક્યું નથી" : "Unable to load Factory Inbox"}
          <button type="button" className="btn btn-outline" style={{ width: "auto", marginLeft: 8 }} onClick={load}>{lang === "gu" ? "ફરી પ્રયાસ" : "Retry"}</button>
        </div>
      )}
      {rows === null && !error && <div className="skeleton-block" style={{ height: 160 }} />}
      {rows && rows.length === 0 && !error && (
        <div className="fx-empty">{activeFilters > 0 ? (lang === "gu" ? "ફિલ્ટરને અનુરૂપ કંઈ નથી" : "Nothing matches these filters") : emptyText}</div>
      )}
      {rows && rows.length > 0 && (
        <>
          <div className="sub">{total} {lang === "gu" ? "જોબ કાર્ડ" : total === 1 ? "Job Card" : "Job Cards"}</div>
          <div className="fx-list">{rows.map((r) => <JobRow key={r.id} r={r} lang={lang} />)}</div>
          {rows.length < total && (
            <button type="button" className="btn btn-outline" onClick={() => setLimitTo((n) => n + PAGE)}>{lang === "gu" ? "વધુ બતાવો" : "Load more"}</button>
          )}
        </>
      )}
    </div>
  );
}
