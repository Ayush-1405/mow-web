import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import FactoryHeader from "./FactoryHeader.jsx";
import { getDashboardCounts, getMyActions, listFactoryLocations, listJobCards, subscribeJobs } from "../../lib/factoryApi";
import { ACTION_LABEL, STATUS, label, fmtDate, roleInfo } from "./factoryConstants";

// The whole page answers six questions from real data: what arrived, what
// needs verifying, what is accepted but unassigned, what is in production,
// what is late or blocked, and what THIS user must do today. Every number is
// a click-through to the matching list, and one Realtime subscription
// refreshes the page when any Job Card changes.
export default function FactoryDashboard({ lang, profile, lookups }) {
  const navigate = useNavigate();
  const role = roleInfo(profile, lookups);
  const [counts, setCounts] = useState(null);
  const [actions, setActions] = useState(null);
  const [latest, setLatest] = useState(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [locations, setLocations] = useState([]);
  const [location, setLocation] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    listFactoryLocations().then(({ data }) => setLocations(data || []));
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    const [c, a, l] = await Promise.all([
      getDashboardCounts(location),
      getMyActions(),
      listJobCards({ tab: "active", location, from: 0, to: 4 }),
    ]);
    if (c.error || a.error || l.error) {
      console.error("[FactoryDashboard] load failed", { counts: c.error?.message, actions: a.error?.message, latest: l.error?.message });
      setError(true);
    } else {
      setError(false);
      setCounts(c.data);
      setActions(a.data || []);
      setLatest(l.data || []);
    }
    setRefreshing(false);
  }, [location]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeJobs("fx-dashboard-jobs", load), [load]);

  const q = location ? `&loc=${location}` : "";
  const cards = [
    ["new_requests", { en: "New Requests", gu: "નવી વિનંતી" }, `/factory/inbox?tab=new${q}`, "hot"],
    ["needs_verification", { en: "Needs Verification", gu: "ચકાસણી બાકી" }, `/factory/inbox?tab=verify${q}`, ""],
    ["accepted_unassigned", { en: "Accepted – Not Assigned", gu: "સ્વીકાર્યું – સોંપવાનું બાકી" }, `/factory/inbox?tab=accepted${q}`, ""],
    ["in_production", { en: "In Production", gu: "ઉત્પાદનમાં" }, `/factory/inbox?tab=in_production${q}`, ""],
    ["delayed_blocked", { en: "Delayed / Blocked", gu: "વિલંબિત / અટકેલું" }, `/factory/inbox?tab=delayed${q}`, "warn"],
    ["done_today", { en: "Ready / Completed Today", gu: "આજે તૈયાર / પૂર્ણ" }, `/factory/job-cards?tab=done_today${q}`, ""],
  ];

  const actionsBlock = (
    <section className="fx-section" aria-label="My actions today">
      <h2>{lang === "gu" ? "આજે મારા કાર્યો" : "My Actions Today"}</h2>
      {actions === null && !error && <div className="skeleton-block" style={{ height: 90 }} />}
      {actions && actions.length === 0 && (
        <div className="fx-empty">{role.isEmployee
          ? (lang === "gu" ? "આજે તમને કોઈ કાર્ય સોંપાયું નથી" : "No tasks assigned to you today")
          : (lang === "gu" ? "આજે કોઈ કાર્ય બાકી નથી" : "Nothing needs your action today")}</div>
      )}
      {actions && (showAll ? actions : actions.slice(0, 6)).map((a) => (
        <Link key={`${a.job_id}-${a.action_code}`} className="fx-action" to={`/factory-job/${a.job_id}`}>
          <span className="t">{label(ACTION_LABEL, a.action_code, lang)} · {a.job_order_number}</span>
          <span className="m">
            {a.title || "—"}{a.source_department_name ? ` · ${a.source_department_name}` : ""}
          </span>
          <span>
            {a.is_overdue && <span className="fx-tag bad">{lang === "gu" ? "મુદત વીતી" : "Overdue"}</span>}
            {a.required_date && <span className="fx-tag">{lang === "gu" ? "તારીખ" : "Due"} {fmtDate(a.required_date)}</span>}
            {["Urgent", "Emergency", "High"].includes(a.priority) && <span className="fx-tag gold">{a.priority}</span>}
          </span>
        </Link>
      ))}
      {actions && actions.length > 6 && (
        <button type="button" className="btn btn-outline" onClick={() => setShowAll((v) => !v)}>
          {showAll ? (lang === "gu" ? "ઓછું બતાવો" : "Show less") : `${lang === "gu" ? "બધા બતાવો" : "Show all"} (${actions.length})`}
        </button>
      )}
    </section>
  );

  const cardsBlock = (
    <div className="fx-cards" aria-label="Factory summary">
      {cards.map(([key, lbl, to, cls]) => {
        const n = counts?.[key];
        return (
          <button key={key} type="button" className={`fx-card ${n > 0 ? cls : ""}`} onClick={() => navigate(to)}>
            <span className="n">{counts ? n ?? 0 : "…"}</span>
            <span className="l">{lang === "gu" ? lbl.gu : lbl.en}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="fx-page">
      <FactoryHeader lang={lang} profile={profile} title={lang === "gu" ? "ફેક્ટરી ડેશબોર્ડ" : "Factory Dashboard"}
        onRefresh={load} refreshing={refreshing} locations={locations} location={location} onLocation={setLocation} />

      {error && (
        <div className="msg error">
          {lang === "gu" ? "ફેક્ટરી ડેશબોર્ડ લોડ થઈ શક્યું નથી" : "Unable to load the Factory Dashboard"}
          <button type="button" className="btn btn-outline" style={{ width: "auto", marginLeft: 8 }} onClick={load}>{lang === "gu" ? "ફરી પ્રયાસ" : "Retry"}</button>
        </div>
      )}

      {role.isEmployee ? <>{actionsBlock}{cardsBlock}</> : <>{cardsBlock}{actionsBlock}</>}

      <section className="fx-section" aria-label="Latest requests">
        <div className="task-meta" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>{lang === "gu" ? "તાજેતરના જોબ કાર્ડ" : "Latest Job Cards"}</h2>
          <Link to="/factory/job-cards" className="fx-tag gold">{lang === "gu" ? "બધા જુઓ" : "View all"}</Link>
        </div>
        {latest === null && !error && <div className="skeleton-block" style={{ height: 70, marginTop: 8 }} />}
        {latest && latest.length === 0 && <div className="fx-empty" style={{ marginTop: 8 }}>{lang === "gu" ? "હજી કોઈ ફેક્ટરી વિનંતી નથી" : "No Factory requests yet"}</div>}
        {latest && latest.map((r) => (
          <Link key={r.id} className="fx-action" to={`/factory-job/${r.id}`} style={{ marginTop: 8 }}>
            <span className="t">{r.job_order_number} · {r.product_item || "—"}</span>
            <span className="m">{r.source_department_name || "—"} · {r.customer_name || r.project_code || "—"}</span>
            <span><span className={`badge ${STATUS[r.factory_status]?.badge}`}>{label(STATUS, r.factory_status, lang)}</span></span>
          </Link>
        ))}
      </section>
    </div>
  );
}
