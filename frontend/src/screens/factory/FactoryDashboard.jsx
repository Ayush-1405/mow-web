import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import FactoryHeader from "./FactoryHeader.jsx";
import {
  getDashboardCounts, getDashboardExtraCounts, getMyActions, listFactoryLocations, listJobCards, subscribeJobs,
  getDivisionDashboardCounts, listMaterialRequests, getQcPendingCount,
} from "../../lib/factoryApi";
import { ACTION_LABEL, STATUS, label, fmtDate, roleInfo } from "./factoryConstants";

// Four large Factory segments -- Sofa / Modular / Metal Fabrication / Material to Order -- are the primary,
// worker-readable landing experience (handwritten workflow spec). Everything below them is still real,
// clickable, DB-backed data; nothing here is decorative or hard-coded.
const SEGMENT_META = {
  SOFA: { icon: "🛋️", en: "Sofa", gu: "સોફા" },
  MODULAR: { icon: "🗄️", en: "Modular", gu: "મોડ્યુલર" },
  METAL_FAB: { icon: "🔩", en: "Metal Fabrication", gu: "મેટલ ફેબ્રિકેશન" },
};

export default function FactoryDashboard({ lang, profile, lookups }) {
  const navigate = useNavigate();
  const role = roleInfo(profile, lookups);
  const [counts, setCounts] = useState(null);
  const [extraCounts, setExtraCounts] = useState(null);
  const [actions, setActions] = useState(null);
  const [latest, setLatest] = useState(null);
  const [priorityJobs, setPriorityJobs] = useState(null);
  const [recentCompleted, setRecentCompleted] = useState(null);
  const [materialShortages, setMaterialShortages] = useState(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [locations, setLocations] = useState([]);
  const [location, setLocation] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [divisions, setDivisions] = useState(null);

  useEffect(() => {
    listFactoryLocations().then(({ data }) => setLocations(data || []));
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    const [c, ec, a, l, dv, mr, pj, rc, qc] = await Promise.all([
      getDashboardCounts(location),
      getDashboardExtraCounts(location),
      getMyActions(),
      listJobCards({ tab: "active", location, from: 0, to: 4 }),
      getDivisionDashboardCounts(location),
      listMaterialRequests({ tab: "open" }),
      listJobCards({ tab: "active", location, priority: ["Urgent", "Emergency", "High"], from: 0, to: 4 }),
      listJobCards({ tab: "completed", location, from: 0, to: 4 }),
      getQcPendingCount(location),
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
    // Division tiles and everything below them degrade quietly on their own errors -- never block or error the
    // rest of an already-working dashboard over a piece that depends on a newer migration/RPC.
    setExtraCounts(ec.error ? null : { ...ec.data, qc_pending: qc.error ? null : qc.data });
    setDivisions(dv.error ? [] : dv.data || []);
    setMaterialShortages(mr.error ? [] : mr.data || []);
    setPriorityJobs(pj.error ? [] : pj.data || []);
    setRecentCompleted(rc.error ? [] : rc.data || []);
  }, [location]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeJobs("fx-dashboard-jobs", load), [load]);

  const q = location ? `&loc=${location}` : "";

  const materialStats = useMemo(() => {
    const rows = materialShortages || [];
    const today = new Date().toISOString().slice(0, 10);
    return {
      new_: rows.filter((r) => r.status === "REQUESTED").length,
      progress: rows.filter((r) => r.status === "ORDERED" || r.status === "PARTIALLY_RECEIVED").length,
      overdue: rows.filter((r) => r.required_date && r.required_date < today).length,
    };
  }, [materialShortages]);

  // Top hero: the four segments from the handwritten note. Sofa/Modular/Metal Fabrication come from
  // production_divisions (real job-card counts); Material to Order is a distinct entity (material requests, not
  // production job cards) so its three stats are derived from the same open-requests list the Material to Order
  // screen itself uses.
  const heroSegments = (
    <div className="fx-hero" aria-label="Factory segments">
      {divisions === null && Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton-block" style={{ height: 190 }} />)}
      {divisions && divisions.map((d) => {
        const meta = SEGMENT_META[d.division_code] || { icon: "🏭", en: d.division_name_en, gu: d.division_name_gu };
        return (
          <button key={d.division_id} type="button" className={`fx-seg ${d.total_active > 0 ? "has-work" : ""}`}
            onClick={() => navigate(`/factory/inbox?division=${d.division_id}${q}`)}>
            <span className="icon">{meta.icon}</span>
            <span className="names"><span className="en">{meta.en}</span><span className="gu">{meta.gu}</span></span>
            <span className="stats">
              <span className="stat"><b>{d.new_requests}</b><span>{lang === "gu" ? "નવું" : "New"}</span></span>
              <span className="stat"><b>{d.in_production}</b><span>{lang === "gu" ? "ચાલુ" : "In Progress"}</span></span>
              <span className="stat bad"><b>{d.delayed_blocked}</b><span>{lang === "gu" ? "મોડું" : "Delayed"}</span></span>
            </span>
            <span className="open-btn">{lang === "gu" ? "ખોલો" : "Open"} →</span>
          </button>
        );
      })}
      <button type="button" className={`fx-seg ${materialStats.new_ + materialStats.progress > 0 ? "has-work" : ""}`}
        onClick={() => navigate("/factory/material-to-order")}>
        <span className="icon">📦</span>
        <span className="names"><span className="en">Material to Order</span><span className="gu">મટિરિયલ ઓર્ડર</span></span>
        <span className="stats">
          <span className="stat"><b>{materialShortages === null ? "…" : materialStats.new_}</b><span>{lang === "gu" ? "નવું" : "New"}</span></span>
          <span className="stat"><b>{materialShortages === null ? "…" : materialStats.progress}</b><span>{lang === "gu" ? "ચાલુ" : "In Progress"}</span></span>
          <span className="stat bad"><b>{materialShortages === null ? "…" : materialStats.overdue}</b><span>{lang === "gu" ? "મોડું" : "Delayed"}</span></span>
        </span>
        <span className="open-btn">{lang === "gu" ? "ખોલો" : "Open"} →</span>
      </button>
    </div>
  );

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

  // Production status -- every card is a real, clickable, filtered destination. "QC Pending" is now backed by
  // real data (job_card_stage_updates / current_stage, built in mvp_pilot_factory_stage_workflow_v2_83.sql) --
  // previously disclosed as not derivable, now it is.
  const cards = [
    ["new_requests", { en: "New Work", gu: "નવું કામ" }, `/factory/inbox?tab=new${q}`, "hot"],
    ["accepted_unassigned", { en: "Unassigned", gu: "સોંપવાનું બાકી" }, `/factory/inbox?tab=accepted${q}`, ""],
    ["material_pending", { en: "Material Pending", gu: "મટિરિયલ બાકી" }, `/factory/material-to-order`, "warn"],
    ["assigned", { en: "Ready to Start", gu: "શરૂ કરવા તૈયાર" }, `/factory/inbox?tab=assigned${q}`, ""],
    ["in_production", { en: "In Production", gu: "ઉત્પાદનમાં" }, `/factory/inbox?tab=in_production${q}`, ""],
    ["qc_pending", { en: "QC Pending", gu: "QC બાકી" }, `/factory/job-cards?status=in_production&stage=QC${q}`, "warn"],
    ["blocked", { en: "Blocked", gu: "અટકેલું" }, `/factory/job-cards?status=blocked${q}`, "warn"],
    ["delayed_blocked", { en: "Delayed", gu: "વિલંબિત" }, `/factory/inbox?tab=delayed${q}`, "warn"],
    ["ready_for_dispatch", { en: "Ready for Dispatch", gu: "ડિસ્પેચ માટે તૈયાર" }, `/factory/job-cards?status=ready_for_review${q}`, ""],
    ["done_today", { en: "Completed Today", gu: "આજે પૂર્ણ" }, `/factory/job-cards?tab=done_today${q}`, ""],
  ];
  const merged = { ...(counts || {}), ...(extraCounts || {}) };
  const cardsBlock = (
    <section className="fx-section" aria-label="Production status">
      <h2>{lang === "gu" ? "ઉત્પાદન સ્થિતિ" : "Production Status"}</h2>
      <div className="fx-cards">
        {cards.map(([key, lbl, to, cls]) => {
          const n = merged?.[key];
          return (
            <button key={key} type="button" className={`fx-card ${n > 0 ? cls : ""}`} onClick={() => navigate(to)}>
              <span className="n">{counts ? n ?? 0 : "…"}</span>
              <span className="l">{lang === "gu" ? lbl.gu : lbl.en}</span>
            </button>
          );
        })}
      </div>
    </section>
  );

  const priorityBlock = (
    <section className="fx-section" aria-label="Priority jobs">
      <h2>{lang === "gu" ? "પ્રાથમિકતા કામ" : "Priority Jobs"}</h2>
      {priorityJobs === null && <div className="skeleton-block" style={{ height: 60 }} />}
      {priorityJobs && priorityJobs.length === 0 && <div className="fx-empty">{lang === "gu" ? "કોઈ પ્રાથમિકતા કામ નથી" : "Nothing urgent right now"}</div>}
      {priorityJobs && priorityJobs.map((r) => (
        <Link key={r.id} className="fx-action" to={`/factory-job/${r.id}`}>
          <span className="t">{r.job_order_number} · {r.product_item || "—"}</span>
          <span className="m">{r.customer_name || r.project_code || "—"}{r.required_date ? ` · ${lang === "gu" ? "તારીખ" : "Due"} ${fmtDate(r.required_date)}` : ""}</span>
          <span><span className="fx-tag gold">{r.priority}</span>{r.is_delayed && <span className="fx-tag bad">{lang === "gu" ? "મોડું" : "Delayed"}</span>}</span>
        </Link>
      ))}
    </section>
  );

  const shortagesBlock = (
    <section className="fx-section" aria-label="Material shortages">
      <div className="task-meta" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>{lang === "gu" ? "મટિરિયલની અછત" : "Material Shortages"}</h2>
        <Link to="/factory/material-to-order" className="fx-tag gold">{lang === "gu" ? "બધા જુઓ" : "View all"}</Link>
      </div>
      {materialShortages === null && <div className="skeleton-block" style={{ height: 60, marginTop: 8 }} />}
      {materialShortages && materialShortages.length === 0 && <div className="fx-empty" style={{ marginTop: 8 }}>{lang === "gu" ? "કોઈ મટિરિયલ બાકી નથી" : "No open material requests"}</div>}
      {materialShortages && materialShortages.slice(0, 5).map((m) => (
        <div key={m.id} className="fx-action" style={{ marginTop: 8 }}>
          <span className="t">{m.material} · {m.quantity} {m.unit}</span>
          <span className="m">{m.request_number}{m.job_card?.job_order_number ? ` · ${m.job_card.job_order_number}` : ""}</span>
          <span>
            <span className="fx-tag">{m.status}</span>
            {["Urgent", "Emergency", "High"].includes(m.priority) && <span className="fx-tag gold">{m.priority}</span>}
          </span>
        </div>
      ))}
    </section>
  );

  const recentCompletedBlock = (
    <section className="fx-section" aria-label="Recently completed">
      <h2>{lang === "gu" ? "તાજેતરમાં પૂર્ણ થયેલ" : "Recently Completed"}</h2>
      {recentCompleted === null && <div className="skeleton-block" style={{ height: 60 }} />}
      {recentCompleted && recentCompleted.length === 0 && <div className="fx-empty">{lang === "gu" ? "કોઈ પૂર્ણ કામ નથી" : "Nothing completed yet"}</div>}
      {recentCompleted && recentCompleted.map((r) => (
        <Link key={r.id} className="fx-action" to={`/factory-job/${r.id}`}>
          <span className="t">{r.job_order_number} · {r.product_item || "—"}</span>
          <span className="m">{r.customer_name || r.project_code || "—"}</span>
          <span><span className={`badge ${STATUS[r.factory_status]?.badge}`}>{label(STATUS, r.factory_status, lang)}</span></span>
        </Link>
      ))}
    </section>
  );

  return (
    <div className="fx-page">
      <FactoryHeader lang={lang} profile={profile} title={lang === "gu" ? "ફેક્ટરી ડેશબોર્ડ" : "Factory Dashboard"}
        onRefresh={load} refreshing={refreshing} locations={locations} location={location} onLocation={setLocation} />

      {heroSegments}

      {error && (
        <div className="msg error">
          {lang === "gu" ? "ફેક્ટરી ડેશબોર્ડ લોડ થઈ શક્યું નથી" : "Unable to load the Factory Dashboard"}
          <button type="button" className="btn btn-outline" style={{ width: "auto", marginLeft: 8 }} onClick={load}>{lang === "gu" ? "ફરી પ્રયાસ" : "Retry"}</button>
        </div>
      )}

      {role.isEmployee ? <>{actionsBlock}{cardsBlock}</> : <>{cardsBlock}{actionsBlock}</>}

      <div className="fx-cards" style={{ gridTemplateColumns: "1fr" }}>
        {priorityBlock}
        {shortagesBlock}
        {recentCompletedBlock}
      </div>

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
