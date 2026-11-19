import React, { useState } from "react";
import { supabase } from "../lib/supabase";
import { friendlyError } from "../lib/friendlyError";

// Shown right after sign-in to anyone whose profile has no mobile number, until they add one. The number is also a
// login id (staff_set_my_phone checks the shape and that nobody else has it).
export default function AddPhone({ lang, profile, onDone, onLogout }) {
  const gu = lang === "gu";
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13) {
      setError("Enter a mobile number with 10 to 13 digits. / 10 થી 13 અંકનો મોબાઇલ નંબર લખો.");
      return;
    }
    setBusy(true);
    const { error: err } = await supabase.rpc("staff_set_my_phone", { p_phone: phone.trim() });
    setBusy(false);
    if (err) { setError(friendlyError(err.message)); return; }
    onDone();
  }

  return (
    <div className="center-page">
      <div className="auth-card">
        <div className="logo-title">
          <h1>{gu ? "તમારો મોબાઇલ નંબર ઉમેરો" : "Add your mobile number"}</h1>
          <div className="sub">
            {gu
              ? `નમસ્તે ${profile.full_name}. આગળ વધતા પહેલાં તમારો મોબાઇલ નંબર ઉમેરો. પછીથી તમે આ નંબરથી પણ લોગિન કરી શકશો.`
              : `Hello ${profile.full_name}. Please add your mobile number to continue. You can also sign in with this number from now on.`}
          </div>
        </div>
        <form onSubmit={handleSubmit} autoComplete="off">
          <label htmlFor="my_phone">{gu ? "મોબાઇલ નંબર" : "Mobile number"}</label>
          <input id="my_phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="98765 43210"
            value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} required />
          {error && <div className="msg error">{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy && <span className="spinner" />}
            {gu ? "સાચવો અને આગળ વધો" : "Save and continue"}
          </button>
          <button className="btn btn-outline" type="button" onClick={onLogout} disabled={busy}>{gu ? "લોગ આઉટ" : "Log out"}</button>
        </form>
      </div>
    </div>
  );
}
