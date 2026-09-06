import React, { useState } from "react";
import { staffPasswordChange } from "../lib/api";
import { t } from "../lib/i18n";

export default function ChangePassword({ lang, onDone }) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match. / નવો પાસવર્ડ અને પુષ્ટિ મેળ ખાતા નથી.");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters. / પાસવર્ડ ઓછામાં ઓછો 8 અક્ષરોનો હોવો જોઈએ.");
      return;
    }
    setBusy(true);
    try {
      await staffPasswordChange(newPassword);
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(true);
      setTimeout(() => onDone(), 900);
    } catch (err) {
      setNewPassword("");
      setConfirmPassword("");
      setError(err.message || "Password change failed. / પાસવર્ડ બદલવામાં નિષ્ફળ.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <div className="auth-card">
        <div className="logo-title">
          <h1>{t("changePasswordTitle", lang)}</h1>
          <div className="sub">{t("changePasswordSubtitle", lang)}</div>
        </div>
        {success ? (
          <div className="msg success">{t("passwordUpdated", lang)}</div>
        ) : (
          <form onSubmit={handleSubmit} autoComplete="off">
            <label htmlFor="new_password">{t("newPassword", lang)}</label>
            <input
              id="new_password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={8}
              maxLength={200}
              required
            />
            <label htmlFor="confirm_password">{t("confirmPassword", lang)}</label>
            <input
              id="confirm_password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={8}
              maxLength={200}
              required
            />
            {error && <div className="msg error">{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy && <span className="spinner" />}
              {t("changePassword", lang)}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
