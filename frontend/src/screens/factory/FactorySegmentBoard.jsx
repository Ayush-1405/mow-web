import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import FactoryHeader from "./FactoryHeader.jsx";
import { listDivisions, listJobCards, subscribeJobs } from "../../lib/factoryApi";
import { DIVISION_META, STATUS, fmtDate, label, roleInfo } from "./factoryConstants";

const DIVISION_BY_ROUTE = { sofa: "SOFA", modular: "MODULAR", "metal-fabrication": "METAL_FAB" };

function JobCard({ r, lang, routeSegment }) {
  return (
    <Link to={`/factory/${routeSegment}/${r.id}`} className="fx-row">
      <div className="top">
        <div><div className="no">{r.job_order_number}</div><div className="meta">{r.customer_name || "—"}</div></div>
        <div><div className="item">{r.product_item || "—"}</div><div className="meta">{r.qty_summary || `${r.total_qty ?? "—"}`}</div></div>
        <div><div className="meta">{lang === "gu" ? "જરૂરી" : "Due"}: <strong>{fmtDate(r.required_date)}</strong></div><div className="meta">{r.priority}</div></div>
        <div><div className="meta">{r.current_stage || "—"} · {r.completion_percentage ?? 0}%</div></div>
        <div>
          <span className={`badge ${STATUS[r.factory_status]?.badge}`}>{label(STATUS, r.factory_status, lang)}</span>
          <div className="meta">{r.assigned_name || (lang === "gu" ? "સોંપાયું નથી" : "Unassigned")}</div>
        </div>
      </div>
    </Link>
  );
}

// A real, dedicated board per segment -- its own counts, its own filtered list, its own "New Job" button --
// not a shared Inbox wrapper with a division filter slapped on. The three production segments (Sofa/Modular/
// Metal Fabrication) all use this same component (explicitly allowed: "shared technical form components are
// allowed internally, but the user must see four different pages") because their underlying record shape,
// status model and stage engine are genuinely identical -- only DIVISION_META (icon/names/spec fields) differs.
export default function FactorySegmentBoard({ lang, profile, lookups }) {
  const { segment } = useParams();
  const navigate = useNavigate();
  const role = roleInfo(profile, lookups);
  const divisionCode = DIVISION_BY_ROUTE[segment];
  const meta = DIVISION_META[divisionCode];

  const [divisionId, setDivisionId] = useState(null);
  const [tab, setTab] = useState("active");
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    listDivisions().then(({ data }) => setDivisionId((data || []).find((d) => d.code === divisionCode)?.id || null));
  }, [divisionCode]);

  const TABS = [
    ["active", { en: "All Active", gu: "બધા સક્રિય" }],
    ["new", { en: "New", gu: "નવું" }],
    ["accepted", { en: "Unassigned", gu: "સોંપવાનું બાકી" }],
    ["assigned", { en: "Ready to Start", gu: "શરૂ કરવા તૈયાર" }],
    ["in_production", { en: "In Progress", gu: "ચાલુ" }],
    ["delayed", { en: "Delayed", gu: "વિલંબિત" }],
    ["done_today", { en: "Ready / Completed Today", gu: "આજે તૈયાર / પૂર્ણ" }],
    ["completed", { en: "Completed", gu: "પૂર્ણ" }],
  ];

  const load = useCallback(async () => {
    if (!divisionId) return;
    const [list, ...countResults] = await Promise.all([
      listJobCards({ tab, division: divisionId, from: 0, to: 49 }),
      ...TABS.map(([k]) => listJobCards({ tab: k, division: divisionId, from: 0, to: 0 })),
    ]);
    if (list.error) { setError(true); return; }
    setError(false);
    setRows(list.data || []);
    const c = {};
    TABS.forEach(([k], i) => { c[k] = countResults[i].count ?? 0; });
    setCounts(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [divisionId, tab]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeJobs(`fx-segment-${segment}`, load), [segment, load]);

  if (!meta) return <div className="fx-page"><div className="fx-empty">Unknown Factory segment</div></div>;

  return (
    <div className="fx-page">
      <FactoryHeader lang={lang} profile={profile} title={`${meta.icon} ${lang === "gu" ? meta.gu : meta.en}`} onRefresh={load} />
      <Link to="/factory" className="fx-tag gold" style={{ width: "auto" }}>← {lang === "gu" ? "ફેક્ટરી ડેશબોર્ડ" : "Factory Dashboard"}</Link>

      {role.isManager && (
        <button type="button" className="btn btn-primary" style={{ minHeight: 48 }} onClick={() => navigate(`/factory/${segment}/new`)}>
          ➕ {lang === "gu" ? `નવું ${meta.gu} કામ` : `New ${meta.en} Job`}
        </button>
      )}

      <div className="fx-cards">
        {TABS.map(([k, lbl]) => (
          <button key={k} type="button" className={`fx-card ${tab === k ? "hot" : ""}`} onClick={() => setTab(k)}>
            <span className="n">{counts ? counts[k] ?? 0 : "…"}</span>
            <span className="l">{lang === "gu" ? lbl.gu : lbl.en}</span>
          </button>
        ))}
      </div>

      {error && <div className="msg error">{lang === "gu" ? "લોડ કરવામાં નિષ્ફળ" : "Unable to load"} <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={load}>{lang === "gu" ? "ફરી પ્રયાસ" : "Retry"}</button></div>}
      {rows === null && !error && <div className="skeleton-block" style={{ height: 200 }} />}
      {rows && rows.length === 0 && <div className="fx-empty">{lang === "gu" ? "કોઈ કામ નથી" : "No jobs here"}</div>}
      <div className="fx-list">
        {rows && rows.map((r) => <JobCard key={r.id} r={r} lang={lang} routeSegment={segment} />)}
      </div>
    </div>
  );
}
