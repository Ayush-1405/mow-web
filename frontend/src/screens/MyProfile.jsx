import React, { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { friendlyError } from "../lib/friendlyError";

const L = (lang, en, gu) => (lang === "gu" ? gu : en);
const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const PERSONAL_FIELDS = [
  ["alternate_phone", "Alternate phone", "બીજો ફોન", "tel"],
  ["personal_email", "Personal email", "વ્યક્તિગત ઇમેઇલ", "email"],
  ["date_of_birth", "Date of birth", "જન્મ તારીખ", "date"],
  ["city", "City", "શહેર", "text"],
  ["emergency_contact_name", "Emergency contact name", "કટોકટી સંપર્ક નામ", "text"],
  ["emergency_contact_phone", "Emergency contact phone", "કટોકટી સંપર્ક ફોન", "tel"],
];
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

// One person's profile: official details (from User Management), personal details and a work summary. Your own profile is
// editable; Management and Department Heads open anyone in their scope (/profile/:userId) read-only. staff_get_profile()
// decides who may see whom.
export default function MyProfile({ lang, onSaved }) {
  const { userId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [state, setState] = useState({ loading: true, error: null });
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const { data: d, error } = await supabase.rpc("staff_get_profile", { p_user_id: userId || null });
    if (error) { setState({ loading: false, error: friendlyError(error.message) }); return; }
    setData(d);
    setForm({ phone: d.phone || "", address: d.personal?.address || "", blood_group: d.personal?.blood_group || "",
      ...Object.fromEntries(PERSONAL_FIELDS.map(([k]) => [k, d.personal?.[k] || ""])) });
    setState({ loading: false, error: null });
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const { phone, ...details } = form;
    const { error } = await supabase.rpc("staff_save_my_profile", { p_phone: phone, p_details: details });
    setBusy(false);
    if (error) { setMsg({ kind: "error", text: friendlyError(error.message) }); return; }
    setMsg({ kind: "success", text: L(lang, "Profile saved.", "પ્રોફાઇલ સાચવી.") });
    await load();
    if (onSaved) onSaved();
  }

  if (state.loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 120 }} /><div className="skeleton-block" style={{ height: 260 }} /></div>;
  if (state.error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{state.error}</div>
        <button className="btn btn-outline" onClick={() => navigate(-1)}>{L(lang, "Back", "પાછા")}</button>
      </div>
    );
  }

  const s = data.stats || {};
  const p = data.personal || {};
  const editable = data.is_self;
  const official = [
    [L(lang, "Employee code", "કર્મચારી કોડ"), data.employee_code],
    [L(lang, "Mobile (login id)", "મોબાઇલ (લોગિન આઈડી)"), data.phone],
    [L(lang, "Role", "ભૂમિકા"), data.role],
    [L(lang, "Department", "વિભાગ"), data.department],
    [L(lang, "Location", "સ્થળ"), data.location],
    [L(lang, "Reports to", "કોને રિપોર્ટ કરે"), data.reports_to],
    [L(lang, "Joined", "જોડાયા"), fmtDate(data.joining_date || data.created_at)],
    [L(lang, "Last sign-in", "છેલ્લું લોગિન"), fmtDateTime(data.last_sign_in_at)],
    [L(lang, "Status", "સ્થિતિ"), data.is_active ? L(lang, "Active", "સક્રિય") : L(lang, "Inactive", "નિષ્ક્રિય")],
  ];

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">👤</div>
        <div className="dept-header-text">
          <h1>{data.full_name}</h1>
          <div className="sub">{[data.role, data.department].filter(Boolean).join(" · ")}</div>
        </div>
      </div>

      <div className="proc-kpis">
        {[[s.tasks_open, "Open tasks", "ખુલ્લા કાર્યો"], [s.tasks_overdue, "Overdue tasks", "મોડા કાર્યો"], [s.tasks_done_30d, "Tasks done (30 days)", "પૂર્ણ કાર્યો (30 દિવસ)"],
          [s.purchase_requests, "Purchase requests", "ખરીદી વિનંતીઓ"], [s.logins_30d, "Sign-ins (30 days)", "લોગિન (30 દિવસ)"]].map(([n, en, gu]) => (
          <div key={en} className="proc-kpi" style={{ cursor: "default" }}><strong>{n ?? 0}</strong><span>{L(lang, en, gu)}</span></div>
        ))}
      </div>

      <div className="card">
        <h2>{L(lang, "Official details", "સત્તાવાર વિગતો")}</h2>
        <div className="form-grid">
          {official.map(([label, value]) => (
            <div className="field" key={label}><label>{label}</label><div>{value || "—"}</div></div>
          ))}
        </div>
        {editable && <div className="sub" style={{ marginTop: 8 }}>{L(lang, "Name, code, role and department are changed by your Department Head or Management in User Management.", "નામ, કોડ, ભૂમિકા અને વિભાગ તમારા વિભાગના વડા અથવા મેનેજમેન્ટ યુઝર મેનેજમેન્ટમાં બદલે છે.")}</div>}
      </div>

      {editable ? (
        <form className="card form-grid" onSubmit={save}>
          <h2 className="field full">{L(lang, "My details", "મારી વિગતો")}</h2>
          <div className="field">
            <label>{L(lang, "Mobile number (login id)", "મોબાઇલ નંબર (લોગિન આઈડી)")} *</label>
            <input type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} required maxLength={20} />
          </div>
          {PERSONAL_FIELDS.map(([k, en, gu, type]) => (
            <div className="field" key={k}>
              <label>{L(lang, en, gu)}</label>
              <input type={type} inputMode={type === "tel" ? "tel" : undefined} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
            </div>
          ))}
          <div className="field">
            <label>{L(lang, "Blood group", "બ્લડ ગ્રુપ")}</label>
            <select value={form.blood_group} onChange={(e) => setForm((f) => ({ ...f, blood_group: e.target.value }))}>
              <option value="">—</option>
              {BLOOD_GROUPS.map((b) => <option key={b}>{b}</option>)}
            </select>
          </div>
          <div className="field full">
            <label>{L(lang, "Address", "સરનામું")}</label>
            <textarea rows={2} value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
          </div>
          {msg && <div className={`msg ${msg.kind} field full`}>{msg.text}</div>}
          <div className="field full"><button className="btn btn-primary" type="submit" disabled={busy}>{L(lang, "Save profile", "પ્રોફાઇલ સાચવો")}</button></div>
        </form>
      ) : (
        <div className="card">
          <h2>{L(lang, "Personal details", "વ્યક્તિગત વિગતો")}</h2>
          <div className="form-grid">
            {PERSONAL_FIELDS.map(([k, en, gu, type]) => (
              <div className="field" key={k}><label>{L(lang, en, gu)}</label><div>{(type === "date" ? (p[k] && fmtDate(p[k])) : p[k]) || "—"}</div></div>
            ))}
            <div className="field"><label>{L(lang, "Blood group", "બ્લડ ગ્રુપ")}</label><div>{p.blood_group || "—"}</div></div>
            <div className="field full"><label>{L(lang, "Address", "સરનામું")}</label><div>{p.address || "—"}</div></div>
          </div>
          {p.updated_at && <div className="sub" style={{ marginTop: 8 }}>{L(lang, "Last updated", "છેલ્લે અપડેટ")}: {fmtDateTime(p.updated_at)}</div>}
        </div>
      )}
    </div>
  );
}
