import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getOrderTaskInfo, getRequestContext, listPurchaseRequests, raiseLowStockRequests } from "../../lib/procurementApi";
import {
  DUE_WATCH_STATUSES, L, PROC_CATEGORIES, PROC_PRIORITIES, PROC_STATUS, QUEUES, SETUP_MISSING_TEXT, daysLeft, fmtDate, isProcurementSetupMissing, procStatusLabel,
  procurementRoles, remainingText, taskStageLabel,
} from "../../lib/procurementRules";
import { subscribeTable } from "../../lib/realtime";
import { useForegroundRefresh } from "../../lib/useForegroundRefresh";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { friendlyError } from "../../lib/friendlyError";
import { reuseRows } from "../../lib/stableData";
import ProcurementContactCard from "../../components/ProcurementContactCard";

// Tabs per mode. "requests": what any employee sees -- their own requests and, for a Department Head, the ones waiting for
// them. "procurement": Procurement's working queue. Requests still waiting for their department are listed separately and
// can't be acted on, so nothing reaches Procurement's queue before the Head approves it.
const TABS = {
  requests: [
    { key: "mine", en: "My requests", gu: "મારી વિનંતીઓ" },
    { key: "approve", en: "Waiting for my approval", gu: "મારી મંજૂરી બાકી", headOnly: true },
    { key: "department", en: "Department requests", gu: "વિભાગની વિનંતીઓ", headOnly: true },
    { key: "receive", en: "To receive", gu: "પ્રાપ્ત કરવાનું", role: "isGodown", statuses: QUEUES.ordered },
    { key: "verify", en: "GRN to verify", gu: "GRN ચકાસવાનું", role: "isGodownLead", statuses: ["RECEIVED"] },
    { key: "invoices", en: "Invoices & payments", gu: "ઇન્વોઇસ અને ચુકવણી", role: "isAccounts", statuses: ["GRN_VERIFIED", "INVOICE_VERIFIED", "PAYMENT_PENDING", "PARTIALLY_PAID"] },
    { key: "emergency", en: "Emergency approvals", gu: "તાત્કાલિક મંજૂરી", role: "isManagement", statuses: ["EMERGENCY_APPROVAL_PENDING"] },
  ],
  procurement: [
    { key: "new", en: "New requests", gu: "નવી વિનંતીઓ", statuses: QUEUES.procurementNew },
    { key: "working", en: "In progress", gu: "ચાલુ", statuses: QUEUES.procurementWorking },
    { key: "ordered", en: "Ordered", gu: "ઓર્ડર થયેલ", statuses: QUEUES.ordered },
    { key: "done", en: "Received & closed", gu: "પ્રાપ્ત અને બંધ", statuses: QUEUES.closed },
    { key: "stopped", en: "Rejected & cancelled", gu: "નામંજૂર અને રદ", statuses: QUEUES.stopped },
    { key: "waiting", en: "Waiting for departments", gu: "વિભાગોની મંજૂરી બાકી", statuses: QUEUES.deptApproval },
  ],
};

export default function PurchaseRequestList({ lang, profile, lookups, mode = "requests" }) {
  const [params, setParams] = useSearchParams();
  const perms = profile.permissions || {};
  const canSeeHeadTabs = perms.isDepartmentHead || perms.hasGlobalOversight;
  const roles = useMemo(() => procurementRoles(profile, lookups.departments), [profile, lookups.departments]);
  const tabs = TABS[mode].filter((tb) => (!tb.headOnly || canSeeHeadTabs) && (!tb.role || roles[tb.role]));
  // ?category=LABOUR,TURNKEY -- the Procurement function cards (Raw Material, Labour, Turnkey ...) open this list filtered.
  const categories = (params.get("category") || "").split(",").filter(Boolean);
  const [lowStock, setLowStock] = useState(null);
  const tab = tabs.find((tb) => tb.key === params.get("tab"))?.key || tabs[0].key;
  const [rows, setRows] = useState([]);
  const [ctx, setCtx] = useState({});
  const [taskInfo, setTaskInfo] = useState({});
  const [state, setState] = useState({ loading: true, error: null });
  const [search, setSearch] = useState("");
  const [dept, setDept] = useState("");
  const [priority, setPriority] = useState("");
  const [sort, setSort] = useState("newest");
  const q = useDebouncedValue(search, 250).trim().toLowerCase();

  const load = useCallback(async () => {
    const { data, error } = await listPurchaseRequests();
    if (error) { setState({ loading: false, error: isProcurementSetupMissing(error) ? L(lang, ...SETUP_MISSING_TEXT) : friendlyError(error.message) }); return; }
    const list = data || [];
    setRows((cur) => reuseRows(cur, list));
    const ids = list.map((r) => r.id);
    const [c, ti] = await Promise.all([getRequestContext(ids), getOrderTaskInfo(ids)]);
    setCtx(c);
    setTaskInfo(ti);
    setState({ loading: false, error: null });
  }, [lang]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let timer = null;
    const unsub = subscribeTable(`purchase-requests-${mode}`, "purchase_requests", null, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 300);
    });
    return () => { window.clearTimeout(timer); unsub(); };
  }, [load, mode]);
  useForegroundRefresh(load);

  const visible = useMemo(() => {
    let list = rows;
    const def = TABS[mode].find((tb) => tb.key === tab);
    if (def?.statuses) list = list.filter((r) => def.statuses.includes(r.proc_status));
    if (tab === "mine") list = list.filter((r) => r.requester_user_id === profile.id);
    if (tab === "approve") list = list.filter((r) => r.proc_status === "PENDING_DEPT_APPROVAL" && r.requester_user_id !== profile.id);
    if (tab === "department") list = list.filter((r) => r.requester_user_id !== profile.id);
    if (params.get("emergency") === "1") list = list.filter((r) => r.is_emergency);
    if (categories.length) list = list.filter((r) => categories.includes(r.procurement_category));
    if (dept) list = list.filter((r) => r.requesting_department_id === dept);
    if (priority) list = list.filter((r) => r.priority === priority);
    if (q) {
      list = list.filter((r) => [r.request_number, r.material_name, r.material_category, ctx[r.id]?.project_code, ctx[r.id]?.customer, ctx[r.id]?.requester_name]
        .filter(Boolean).some((x) => String(x).toLowerCase().includes(q)));
    }
    const rank = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
    const sorted = list.slice();
    if (sort === "oldest") sorted.sort((a, b) => a.created_at.localeCompare(b.created_at));
    else if (sort === "required") sorted.sort((a, b) => (a.required_by_date || "9").localeCompare(b.required_by_date || "9"));
    else if (sort === "priority") sorted.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || a.created_at.localeCompare(b.created_at));
    else sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return sorted;
  }, [rows, ctx, mode, tab, profile.id, params, categories.join(","), dept, priority, q, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runLowStock() {
    setLowStock({ busy: true });
    const { data, error } = await raiseLowStockRequests();
    setLowStock(error ? { error: friendlyError(error.message) } : { count: data });
    if (!error) load();
  }

  const counts = useMemo(() => Object.fromEntries(TABS[mode].map((tb) => [tb.key, tb.statuses ? rows.filter((r) => tb.statuses.includes(r.proc_status)).length : null])), [rows, mode]);
  const departments = useMemo(() => {
    const ids = new Set(rows.map((r) => r.requesting_department_id));
    return lookups.departments.filter((d) => ids.has(d.id));
  }, [rows, lookups.departments]);

  if (state.loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 60 }} /><div className="skeleton-block" style={{ height: 300 }} /></div>;
  if (state.error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{state.error}</div>
        <button className="btn btn-primary" onClick={load}>{L(lang, "Retry", "ફરી પ્રયાસ")}</button>
      </div>
    );
  }

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🧾</div>
        <div className="dept-header-text">
          <h1>{mode === "procurement" ? L(lang, "Purchase requirements", "ખરીદી જરૂરિયાત") : L(lang, "Purchase requests", "ખરીદી વિનંતીઓ")}</h1>
          {categories.length > 0 && (
            <div className="sub">{categories.map((c) => { const x = PROC_CATEGORIES.find((pc) => pc.code === c); return x ? L(lang, x.en, x.gu) : c; }).join(" · ")}</div>
          )}
        </div>
        <Link className="btn btn-primary" style={{ width: "auto", marginLeft: "auto" }} to="/orders/new">📝 {L(lang, "New order", "નવો ઓર્ડર")}</Link>
      </div>

      {roles.canRaiseLowStock && mode === "requests" && (
        <div className="card">
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={lowStock?.busy} onClick={runLowStock}>
            📉 {L(lang, "Raise requests for low-stock raw materials", "ઓછા સ્ટોકની કાચી સામગ્રી માટે વિનંતી કરો")}
          </button>
          {lowStock?.error && <div className="msg error">{lowStock.error}</div>}
          {lowStock?.count != null && <div className="msg info">{L(lang, `${lowStock.count} new request(s) raised. They wait for your Department Head's approval.`, `${lowStock.count} નવી વિનંતી. તે તમારા વિભાગના વડાની મંજૂરી માટે છે.`)}</div>}
        </div>
      )}

      <div className="card">
        <div className="tab-strip" role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {tabs.map((tb) => (
            <button key={tb.key} role="tab" aria-selected={tab === tb.key} className={`btn ${tab === tb.key ? "btn-primary" : "btn-outline"}`} style={{ width: "auto" }}
              onClick={() => { const next = new URLSearchParams(params); next.set("tab", tb.key); setParams(next, { replace: true }); }}>
              {L(lang, tb.en, tb.gu)}{counts[tb.key] != null ? ` (${counts[tb.key]})` : ""}
            </button>
          ))}
        </div>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div className="field">
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={L(lang, "Search number, material, project, person", "નંબર, સામગ્રી, પ્રોજેક્ટ, વ્યક્તિ શોધો")} />
          </div>
          {departments.length > 1 && (
            <div className="field">
              <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label={L(lang, "Department", "વિભાગ")}>
                <option value="">{L(lang, "All departments", "બધા વિભાગ")}</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{lang === "gu" ? d.name_gu : d.name_en}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label={L(lang, "Priority", "પ્રાથમિકતા")}>
              <option value="">{L(lang, "Any priority", "કોઈપણ પ્રાથમિકતા")}</option>
              {PROC_PRIORITIES.map((p) => <option key={p.code} value={p.code}>{lang === "gu" ? p.gu : p.en}</option>)}
            </select>
          </div>
          <div className="field">
            <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label={L(lang, "Sort", "ક્રમ")}>
              <option value="newest">{L(lang, "Newest first", "નવી પહેલા")}</option>
              <option value="oldest">{L(lang, "Oldest first", "જૂની પહેલા")}</option>
              <option value="required">{L(lang, "Needed soonest", "જલ્દી જોઈતી")}</option>
              <option value="priority">{L(lang, "Highest priority", "ઊંચી પ્રાથમિકતા")}</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        {visible.length === 0 && <div className="msg info">{L(lang, "No requests here.", "અહીં કોઈ વિનંતી નથી.")}</div>}
        {visible.map((r) => {
          const c = ctx[r.id] || {};
          const n = DUE_WATCH_STATUSES.includes(r.proc_status) ? daysLeft(r.required_by_date) : null;
          return (
            <div key={r.id} className="proc-row">
              <Link to={`/purchase-requests/${r.id}`}>
                <div style={{ fontWeight: 700 }}>{r.request_number} — {r.material_name}</div>
                <div className="sub">
                  {r.quantity} {r.unit} · {L(lang, "due", "ડ્યુ")} {fmtDate(r.required_by_date)} · {c.department_name || "—"}
                  {c.project_code ? ` · ${c.project_code}` : ""}{c.requester_name ? ` · ${c.requester_name}` : ""}
                  {c.expected_delivery_date ? ` · ${L(lang, "expected", "અપેક્ષિત")} ${fmtDate(c.expected_delivery_date)}` : ""}
                </div>
                {taskInfo[r.id]?.stage && (
                  <div className="sub">
                    {L(lang, "Procurement", "ખરીદી")}: <strong>{taskStageLabel(taskInfo[r.id].stage, lang)}</strong>
                    {taskInfo[r.id].accepted_by ? ` · ${L(lang, "handled by", "સંભાળનાર")} ${taskInfo[r.id].assigned_name}` : ""}
                  </div>
                )}
                {c.latest_update && <div className="sub" style={{ fontStyle: "italic" }}>{c.latest_update}</div>}
              </Link>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {n !== null && <span className={`due-chip ${n < 0 ? "due-overdue" : n <= 1 ? "due-near" : n <= 3 ? "due-soon" : ""}`} style={{ margin: 0 }}>{remainingText(n, lang)}</span>}
                {r.is_emergency && <span className="badge RETURNED">{L(lang, "Emergency", "તાત્કાલિક")}</span>}
                {r.priority === "URGENT" && !r.is_emergency && <span className="badge RETURNED">{L(lang, "Urgent", "તાત્કાલિક")}</span>}
                <span className={`badge ${PROC_STATUS[r.proc_status]?.tone || "ASSIGNED"}`}>{procStatusLabel(r.proc_status, lang)}</span>
              </div>
            </div>
          );
        })}
      </div>

      <ProcurementContactCard lang={lang} profile={profile} />
    </div>
  );
}
