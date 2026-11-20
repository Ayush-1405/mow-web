import React, { useCallback, useEffect, useState } from "react";
import { getApprovalLimits, getCompanyProfile, saveCompanyProfile, setApprovalThreshold } from "../lib/procurementApi";
import { friendlyError } from "../lib/friendlyError";
import { MOW_LOGO } from "../lib/brand";

// Management: the company information printed on every official order form and PDF, and the optional amount above which
// Procurement orders need Management's approval (empty = no Management step; Department Head -> Procurement is enough).

const FIELDS = [
  ["company_name", "Company name", "કંપનીનું નામ", "full"],
  ["address_line", "Registered / office address", "રજિસ્ટર્ડ / ઓફિસ સરનામું", "full"],
  ["city", "City", "શહેર"], ["state", "State", "રાજ્ય"], ["pin_code", "PIN code", "પિન કોડ"],
  ["phone", "Contact number", "સંપર્ક નંબર"], ["email", "Email", "ઇમેઇલ"], ["gstin", "GST number (if applicable)", "GST નંબર (જો હોય)"],
];
const EMPTY = Object.fromEntries(FIELDS.map(([k]) => [k, ""]));

export default function CompanySettings({ lang }) {
  const L = (en, gu) => (lang === "gu" ? gu : en);
  const [form, setForm] = useState(EMPTY);
  const [threshold, setThreshold] = useState("");
  const [state, setState] = useState({ loading: true, error: null });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const [c, l] = await Promise.all([getCompanyProfile(), getApprovalLimits()]);
    if (c.error) { setState({ loading: false, error: friendlyError(c.error.message) }); return; }
    setForm(Object.fromEntries(FIELDS.map(([k]) => [k, c.data?.[k] || ""])));
    const lim = (l.data || []).find((x) => x.approver === "PROCUREMENT_HEAD")?.max_amount;
    setThreshold(lim == null ? "" : String(Number(lim)));
    setState({ loading: false, error: null });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function saveCompany(e) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const { error } = await saveCompanyProfile(form);
    setBusy(false);
    setMsg(error ? { type: "error", text: friendlyError(error.message) } : { type: "success", text: L("Company information saved. It now prints on every order form.", "કંપની માહિતી સાચવી. હવે દરેક ઓર્ડર ફોર્મ પર છપાશે.") });
    if (!error) load();
  }

  async function saveThreshold(value) {
    setBusy(true); setMsg(null);
    const amount = String(value ?? "").trim() === "" ? null : Number(value);
    if (amount !== null && !(amount > 0)) { setBusy(false); setMsg({ type: "error", text: L("Enter an amount above zero, or leave it empty.", "શૂન્યથી વધુ રકમ લખો, અથવા ખાલી રાખો.") }); return; }
    const { error } = await setApprovalThreshold(amount);
    setBusy(false);
    setMsg(error ? { type: "error", text: friendlyError(error.message) } : { type: "success", text: amount === null
      ? L("No Management approval step: Procurement places approved orders directly.", "મેનેજમેન્ટ મંજૂરી નહીં: ખરીદી વિભાગ સીધા ઓર્ડર મૂકે છે.")
      : L(`Orders above Rs ${amount.toLocaleString("en-IN")} will need Management approval.`, `રૂ. ${amount.toLocaleString("en-IN")} થી વધુના ઓર્ડર માટે મેનેજમેન્ટ મંજૂરી જોઈશે.`) });
    if (!error) load();
  }

  if (state.loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 300 }} /></div>;
  if (state.error) return <div className="dept-dashboard"><div className="msg error">{state.error}</div></div>;

  const place = [form.city, form.state].filter(Boolean).join(", ") + (form.pin_code ? ` - ${form.pin_code}` : "");
  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🏢</div>
        <div className="dept-header-text">
          <h1>{L("Company & settings", "કંપની અને સેટિંગ")}</h1>
          <div className="sub">{L("Printed on every official order form; only Management can change it.", "દરેક સત્તાવાર ઓર્ડર ફોર્મ પર છપાય છે; ફક્ત મેનેજમેન્ટ બદલી શકે.")}</div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <form className="card form-grid" onSubmit={saveCompany} noValidate>
        <h2 className="field full">{L("Company information", "કંપની માહિતી")}</h2>
        {FIELDS.map(([k, en, gu, wide]) => (
          <div key={k} className={`field${wide ? " full" : ""}`}>
            <label>{L(en, gu)}</label>
            <input value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
              inputMode={k === "pin_code" || k === "phone" ? "numeric" : undefined} type={k === "email" ? "email" : "text"} />
          </div>
        ))}
        <div className="field full">
          <label>{L("How it prints", "કેવું છપાશે")}</label>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", border: "1px solid var(--border)", borderRadius: 8, padding: 10, background: "#fff" }}>
            <img src={MOW_LOGO} alt="Mood of Wood" style={{ width: 120, height: 50, objectFit: "contain", objectPosition: "left center" }} />
            <div style={{ fontSize: 12, lineHeight: 1.35, color: "#222" }}>
              {form.company_name && <div style={{ fontWeight: 700 }}>{form.company_name}</div>}
              {form.address_line && <div>{form.address_line}</div>}
              {place.trim() && <div>{place}</div>}
              {(form.phone || form.email) && <div>{[form.phone && `Ph: ${form.phone}`, form.email].filter(Boolean).join(" · ")}</div>}
              {form.gstin && <div>GSTIN: {form.gstin.toUpperCase()}</div>}
              {!form.company_name && !form.address_line && <div className="sub">{L("Nothing entered yet — the form prints the logo only.", "હજુ કંઈ લખ્યું નથી — ફોર્મ પર ફક્ત લોગો છપાશે.")}</div>}
            </div>
          </div>
        </div>
        <div className="field full"><button className="btn btn-primary" type="submit" style={{ width: "auto" }} disabled={busy}>{L("Save company information", "કંપની માહિતી સાચવો")}</button></div>
      </form>

      <div className="card form-grid">
        <h2 className="field full">{L("Procurement approval", "ખરીદી મંજૂરી")}</h2>
        <div className="field full sub">
          {L("Normal orders: Department Head → Procurement → order placed. Management approval is needed only if you set an amount here.",
            "સામાન્ય ઓર્ડર: વિભાગ વડા → ખરીદી વિભાગ → ઓર્ડર મૂકાયો. અહીં રકમ મૂકો તો જ મેનેજમેન્ટ મંજૂરી જોઈશે.")}
        </div>
        <div className="field">
          <label>{L("Management approval above (Rs) — optional", "આનાથી વધુ પર મેનેજમેન્ટ મંજૂરી (રૂ.) — વૈકલ્પિક")}</label>
          <input type="number" min="1" step="any" inputMode="decimal" value={threshold} placeholder={L("No threshold", "કોઈ મર્યાદા નથી")} onChange={(e) => setThreshold(e.target.value)} />
        </div>
        <div className="field full btn-row">
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy} onClick={() => saveThreshold(threshold)}>{L("Save", "સાચવો")}</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={() => saveThreshold("")}>{L("Remove threshold", "મર્યાદા દૂર કરો")}</button>
        </div>
      </div>
    </div>
  );
}
