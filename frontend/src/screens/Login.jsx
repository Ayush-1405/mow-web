import React, { useState } from "react";
import { staffLogin } from "../lib/api";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";

// Login screen: Employee Code + Password -> staff-login Edge Function.
// On success, hands the returned access/refresh token pair to the shared
// Supabase client via setSession() so every subsequent .from()/.rpc() call
// in the app runs as this authenticated user, under RLS. The password
// field is cleared the instant the request body is built; nothing here is
// ever logged to the console.
export default function Login({ lang, onLoggedIn }) {
  const [employeeCode, setEmployeeCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!employeeCode.trim() || !password) {
      setError("Please fill in both fields. / કૃપા કરીને બંને ફીલ્ડ ભરો.");
      return;
    }
    setBusy(true);
    try {
      const result = await staffLogin(employeeCode.trim(), password);
      setPassword("");
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: result.access_token,
        refresh_token: result.refresh_token,
      });
      if (sessionError) throw sessionError;
      onLoggedIn({ mustChangePassword: !!result.must_change_password });
    } catch (err) {
      setPassword("");
      setError(err.message || "Login failed. / લોગિન નિષ્ફળ થયું.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <div className="auth-card">
        <div className="logo-title">
          <h1>Mood of Wood</h1>
          <div className="sub">{t("loginTitle", lang)} / સ્ટાફ લોગિન</div>
        </div>
        <form onSubmit={handleSubmit} autoComplete="off">
          <label htmlFor="employee_code">{t("employeeCode", lang)}</label>
          <input
            id="employee_code"
            autoComplete="off"
            value={employeeCode}
            onChange={(e) => setEmployeeCode(e.target.value)}
            maxLength={40}
            required
          />
          <label htmlFor="password">{t("password", lang)}</label>
          <input
            id="password"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={200}
            required
          />
          {error && <div className="msg error">{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy && <span className="spinner" />}
            {busy ? t("loggingIn", lang) : t("login", lang)}
          </button>
        </form>
      </div>
    </div>
  );
}
