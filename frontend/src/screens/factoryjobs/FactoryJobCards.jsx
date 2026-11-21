import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  L, SECTIONS, amFactoryLead, amFactoryMember, daysLeft, effectiveDue, fmtQty, isOverdue, jobStatusLabel, JOB_STATUS, listJobCards, peopleNames,
  priorityLabel, sectionCounts, todayIST,
} from "../../lib/factoryJobApi";
import { subscribeTable } from "../../lib/realtime";
import { friendlyError } from "../../lib/friendlyError";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import PerformanceStrip from "../../components/PerformanceStrip.jsx";

// The Factory home: seven sections with counters, one list. A Factory Head sees every card; a Factory employee sees new
// cards (to accept) and their own; any other department sees the cards it sent (same sections, so it can follow them).

const fmtDate = (d) => (d ? d.split("-").reverse().join("-") : "—");

export default function FactoryJobCards({ lang, profile, lookups }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState([]);
  const [names, setNames] = useState({});
  const [state, setState] = useState({ loading: true, error: null });
  const [me, setMe] = useState({ member: false, lead: false });
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search, 250).trim().toLowerCase();
  const today = todayIST();
  const isFactory = lookups.departmentById?.[profile.department_id]?.code === "FACTORY";
  const section = SECTIONS.find((s) => s.key === params.get("section")) || null;

  const load = useCallback(async () => {
    const [{ data, error }, m, l] = await Promise.all([listJobCards(), amFactoryMember(), amFactoryLead()]);
    if (error) { setState({ loading: false, error: friendlyError(error.message) }); return; }
    setRows(data || []);
    setMe({ member: !!m.data, lead: !!l.data });
    setNames(await peopleNames((data || []).flatMap((j) => [j.assigned_to, j.requested_by])));
    setState({ loading: false, error: null });
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory-job-cards", "factory_job_cards", null, () => load()), [load]);

  const counts = useMemo(() => sectionCounts(rows, today), [rows, today]);
  // Default view: everything still open, most urgent first; a section narrows it.
  const visible = useMemo(() => rows.filter((j) => (section ? section.test(j, today) : !["COMPLETED", "CANCELLED"].includes(j.status)))
    .filter((j) => !q || [j.job_card_number, j.client_name, j.project_name, j.departments?.name_en, names[j.assigned_to],
      ...(j.factory_job_card_items || []).map((i) => i.product_name)].filter(Boolean).some((x) => String(x).toLowerCase().includes(q)))
    .sort((a, b) => (isOverdue(b, today) - isOverdue(a, today)) || String(effectiveDue(a)).localeCompare(String(effectiveDue(b)))),
  [rows, section, today, q, names]);

  if (state.loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 90 }} /><div className="skeleton-block" style={{ height: 300 }} /></div>;
  if (state.error) return <div className="dept-dashboard"><div className="msg error">{state.error}</div><button className="btn btn-primary" onClick={load}>{L(lang, "Retry", "ફરી પ્રયાસ")}</button></div>;

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🏭</div>
        <div className="dept-header-text">
          <h1>{isFactory || me.lead ? L(lang, "Factory Job Cards", "ફેક્ટરી જોબ કાર્ડ") : L(lang, "Job Cards sent to the Factory", "ફેક્ટરીને મોકલેલા જોબ કાર્ડ")}</h1>
          <div className="sub">{me.lead ? L(lang, "Every Job Card: accept and assign new ones, follow production, approve QC.", "બધા જોબ કાર્ડ: નવા સ્વીકારો, સોંપો, ઉત્પાદન અને QC.")
            : me.member ? L(lang, "New Job Cards to accept and the ones assigned to you.", "સ્વીકારવાના નવા અને તમને સોંપાયેલા જોબ કાર્ડ.")
              : L(lang, "Your department's production orders and where each one stands.", "તમારા વિભાગના ઉત્પાદન ઓર્ડર અને તેની સ્થિતિ.")}</div>
        </div>
        <div className="btn-row" style={{ marginLeft: "auto" }}>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => navigate("/factory-job-cards/new")}>+ {L(lang, "Create Job Card", "જોબ કાર્ડ બનાવો")}</button>
          {isFactory && <Link className="btn btn-outline" style={{ width: "auto" }} to="/factory/advanced">{L(lang, "Advanced tools", "વધુ સાધનો")}</Link>}
        </div>
      </div>

      <PerformanceStrip lang={lang} />

      <div className="fjc-sections">
        {SECTIONS.map((s) => (
          <button key={s.key} type="button" className={`fjc-section${section?.key === s.key ? " on" : ""}${s.danger && counts[s.key] ? " danger" : ""}`}
            onClick={() => setParams(section?.key === s.key ? {} : { section: s.key })}>
            <span className="n">{counts[s.key]}</span><span className="t">{L(lang, s.en, s.gu)}</span>
          </button>
        ))}
      </div>

      <div className="card">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <b>{section ? L(lang, section.en, section.gu) : L(lang, "Open Job Cards", "ચાલુ જોબ કાર્ડ")}</b>
          <span className="sub">({visible.length})</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginLeft: "auto", maxWidth: 280, margin: 0 }}
            placeholder={L(lang, "Search number, product, client", "નંબર, ઉત્પાદન, ગ્રાહક શોધો")} />
        </div>
        {visible.length === 0 && <div className="msg info">{L(lang, "No Job Cards here.", "અહીં કોઈ જોબ કાર્ડ નથી.")}</div>}
        <div className="fjc-list">
          {visible.map((j) => <JobRow key={j.id} j={j} lang={lang} names={names} today={today} onOpen={() => navigate(`/factory-job-cards/${j.id}`)} />)}
        </div>
      </div>
    </div>
  );
}

function JobRow({ j, lang, names, today, onOpen }) {
  const items = j.factory_job_card_items || [];
  const total = items.reduce((s, i) => s + Number(i.quantity || 0), 0);
  const overdue = isOverdue(j, today);
  const left = daysLeft(j, today);
  const st = JOB_STATUS[j.status];
  return (
    <button type="button" className={`fjc-row${overdue ? " overdue" : ""}`} onClick={onOpen}>
      <div className="fjc-row-main">
        <div className="fjc-row-top">
          <b>{j.job_card_number}</b>
          <span className={`badge ${st?.tone || "ASSIGNED"}`}>{jobStatusLabel(j.status, lang)}</span>
          {j.priority !== "NORMAL" && <span className={`badge ${j.priority === "EMERGENCY" ? "RETURNED" : "ON_HOLD"}`}>{priorityLabel(j.priority, lang)}</span>}
          {j.qc_status === "FAILED" && j.status === "IN_PROGRESS" && <span className="badge RETURNED">{L(lang, "QC failed — rework", "QC નિષ્ફળ")}</span>}
        </div>
        <div className="fjc-row-product">{items[0]?.product_name || "—"}{items.length > 1 && <span className="sub"> +{items.length - 1} {L(lang, "more", "વધુ")}</span>}</div>
        <div className="sub">{[L(lang, j.departments?.name_en, j.departments?.name_gu), j.client_name, j.project_name].filter(Boolean).join(" · ")}</div>
      </div>
      <dl className="fjc-row-facts">
        <div><dt>{L(lang, "Qty", "જથ્થો")}</dt><dd>{fmtQty(total)}</dd></div>
        <div><dt>{L(lang, "Due", "નિયત")}</dt><dd className={overdue ? "danger" : ""}>{fmtDate(effectiveDue(j))}{j.revised_due_date && " *"}
          {left !== null && !["COMPLETED", "CANCELLED", "DISPATCHED"].includes(j.status) && (
            <span className="sub"> · {overdue ? L(lang, `${-left} d late`, `${-left} દિ મોડું`) : left === 0 ? L(lang, "today", "આજે") : L(lang, `${left} d`, `${left} દિ`)}</span>)}</dd></div>
        <div><dt>{L(lang, "Assigned", "સોંપાયેલ")}</dt><dd>{names[j.assigned_to] || L(lang, "Not yet", "હજુ નહીં")}</dd></div>
        <div><dt>{L(lang, "Progress", "પ્રગતિ")}</dt><dd>{j.progress_pct}%</dd></div>
      </dl>
    </button>
  );
}
