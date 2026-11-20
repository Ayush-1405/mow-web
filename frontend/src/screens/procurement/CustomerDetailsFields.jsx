import React, { useEffect, useState } from "react";
import { searchCustomers } from "../../lib/procurementApi";
import { L, toCustomerForm } from "../../lib/procurementRules";
import { useDebouncedValue } from "../../lib/useDebouncedValue";

// Customer details on the order form: pick an existing customer (Retail customers you may see, and customers on your
// earlier orders) to fill everything in, or type a new one. Billing and delivery addresses are separate; "same as
// billing" copies the billing address into delivery (the delivery contact stays the delivery's own).

const ERR = {
  required: ["Required", "જરૂરી"], mobile: ["Enter a 10-digit mobile number", "10 અંકનો મોબાઇલ નંબર લખો"], email: ["Email is not valid", "ઇમેઇલ ખોટો છે"],
  gst: ["GST number is not valid (e.g. 24ABCDE1234F1Z5)", "GST નંબર ખોટો છે (દા.ત. 24ABCDE1234F1Z5)"], pin: ["PIN code must be 6 digits", "પિન કોડ 6 અંકનો હોવો જોઈએ"],
};

export default function CustomerDetailsFields({ lang, value, onChange, errors = {}, nameRequired }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const q = useDebouncedValue(query, 300);
  const c = value;

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return undefined; }
    let alive = true;
    setSearching(true);
    searchCustomers(q.trim()).then(({ data }) => { if (alive) { setResults(data || []); setSearching(false); } });
    return () => { alive = false; };
  }, [q]);

  const set = (k) => (e) => onChange({ ...c, [k]: e.target.value });
  const setAddr = (part, k) => (e) => {
    const next = { ...c, [part]: { ...c[part], [k]: e.target.value } };
    onChange(next);
  };
  const err = (k) => errors[k] && <div className="sub" style={{ color: "var(--danger, #a23434)" }}>{L(lang, ...ERR[errors[k]])}</div>;
  const pick = (r) => {
    onChange({ ...toCustomerForm(r.customer), retail_customer_id: r.retail_customer_id || null });
    setQuery(""); setResults([]);
  };
  const same = c.delivery_same_as_billing;
  const field = (part, k, en, gu, extra = {}) => (
    <div className={`field${extra.full ? " full" : ""}`} key={`${part}.${k}`}>
      <label>{L(lang, en, gu)}</label>
      <input value={c[part][k] || ""} onChange={setAddr(part, k)} disabled={part === "delivery" && same && !["contact_person", "contact_phone"].includes(k)}
        inputMode={extra.numeric ? "numeric" : undefined} maxLength={extra.max} />
      {err(`${part}.${k}`)}
    </div>
  );

  return (
    <div className="field full customer-box">
      <label style={{ fontSize: 15 }}>{L(lang, "Customer details", "ગ્રાહકની વિગતો")}</label>
      <div className="customer-search">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={L(lang, "Find an existing customer by name or mobile…", "નામ કે મોબાઇલથી ગ્રાહક શોધો…")}
          aria-label={L(lang, "Find customer", "ગ્રાહક શોધો")} />
        {(results.length > 0 || (searching && q.trim().length >= 2)) && (
          <ul className="customer-results" role="listbox">
            {searching && <li className="sub">{L(lang, "Searching…", "શોધાય છે…")}</li>}
            {results.map((r, n) => (
              <li key={`${r.retail_customer_id || r.customer?.mobile || n}`}>
                <button type="button" onClick={() => pick(r)}>
                  <strong>{r.customer?.name}</strong> {r.customer?.mobile && <span>· {r.customer.mobile}</span>}
                  <span className="sub"> · {r.source === "RETAIL" ? L(lang, "Retail customer", "રિટેલ ગ્રાહક") : L(lang, "from an earlier order", "અગાઉના ઓર્ડરમાંથી")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {c.retail_customer_id && <div className="sub">{L(lang, "Linked to the Retail customer record.", "રિટેલ ગ્રાહક રેકોર્ડ સાથે જોડાયેલ.")}</div>}
      </div>
      <div className="form-grid">
        <div className="field"><label>{L(lang, "Customer / client name", "ગ્રાહકનું નામ")}{nameRequired && " *"}</label><input value={c.name} onChange={set("name")} />{err("name")}</div>
        <div className="field"><label>{L(lang, "Mobile number", "મોબાઇલ નંબર")}</label><input type="tel" inputMode="tel" value={c.mobile} onChange={set("mobile")} />{err("mobile")}</div>
        <div className="field"><label>{L(lang, "Alternate mobile", "બીજો મોબાઇલ")}</label><input type="tel" inputMode="tel" value={c.alt_mobile} onChange={set("alt_mobile")} />{err("alt_mobile")}</div>
        <div className="field"><label>{L(lang, "Email address", "ઇમેઇલ")}</label><input type="email" value={c.email} onChange={set("email")} />{err("email")}</div>
        <div className="field"><label>{L(lang, "GST number (optional)", "GST નંબર (વૈકલ્પિક)")}</label><input value={c.gstin} onChange={(e) => onChange({ ...c, gstin: e.target.value.toUpperCase() })} maxLength={15} />{err("gstin")}</div>
      </div>
      <fieldset className="customer-addr">
        <legend>{L(lang, "Billing address", "બિલિંગ સરનામું")}</legend>
        <div className="form-grid">
          {field("billing", "line1", "Address line 1", "સરનામું લાઇન 1", { full: true })}
          {field("billing", "line2", "Address line 2", "સરનામું લાઇન 2", { full: true })}
          {field("billing", "city", "City", "શહેર")}
          {field("billing", "state", "State", "રાજ્ય")}
          {field("billing", "pin", "PIN code", "પિન કોડ", { numeric: true, max: 6 })}
        </div>
      </fieldset>
      <fieldset className="customer-addr">
        <legend>{L(lang, "Delivery address", "ડિલિવરી સરનામું")}</legend>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600, marginBottom: 6 }}>
          <input type="checkbox" checked={same} style={{ width: "auto", margin: 0 }}
            onChange={(e) => onChange({ ...c, delivery_same_as_billing: e.target.checked,
              delivery: e.target.checked ? { ...c.delivery, line1: c.billing.line1, line2: c.billing.line2, city: c.billing.city, state: c.billing.state, pin: c.billing.pin } : c.delivery })} />
          {L(lang, "Delivery address same as billing address", "ડિલિવરી સરનામું બિલિંગ જેવું જ")}
        </label>
        <div className="form-grid">
          {field("delivery", "line1", "Address line 1", "સરનામું લાઇન 1", { full: true })}
          {field("delivery", "line2", "Address line 2", "સરનામું લાઇન 2", { full: true })}
          {field("delivery", "city", "City", "શહેર")}
          {field("delivery", "state", "State", "રાજ્ય")}
          {field("delivery", "pin", "PIN code", "પિન કોડ", { numeric: true, max: 6 })}
          {field("delivery", "contact_person", "Delivery contact person", "ડિલિવરી સંપર્ક વ્યક્તિ")}
          {field("delivery", "contact_phone", "Delivery contact number", "ડિલિવરી સંપર્ક નંબર")}
        </div>
      </fieldset>
    </div>
  );
}
