import React from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../lib/i18n";

// Shown for any authenticated user who hits a department route (or direct
// URL) they are not authorized for. This is a UI courtesy only — the same
// request would also be refused at the Postgres RLS layer if it tried to
// read data, so there is nothing sensitive to protect further here.
export default function AccessDenied({ lang }) {
  const navigate = useNavigate();
  return (
    <div className="access-denied-wrap">
      <div className="card access-denied-card">
        <div className="access-denied-icon" aria-hidden="true">🔒</div>
        <h2>{t("accessDeniedTitle", lang)}</h2>
        <p className="sub">{t("accessDeniedBody", lang)}</p>
        <div className="btn-row">
          <button className="btn btn-outline" onClick={() => navigate(-1)}>{t("goBack", lang)}</button>
          <button className="btn btn-primary" onClick={() => navigate("/")}>{t("backToTasks", lang)}</button>
        </div>
      </div>
    </div>
  );
}
