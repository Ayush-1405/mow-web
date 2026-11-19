import React from "react";
import { useProcurementContact } from "../lib/useProcurementContact";
import { L, telHref } from "../lib/procurementRules";

// When the profile has no phone, Management is told to add it in User Management instead of being shown a placeholder.
export default function ProcurementContactCard({ lang, profile, compact = false }) {
  const contact = useProcurementContact();
  if (!contact) return null;
  const href = telHref(contact.phone);
  const isManagement = !!profile?.permissions?.hasGlobalOversight;
  return (
    <div className={compact ? "msg info" : "card"} style={compact ? { marginTop: 8 } : undefined}>
      {!compact && <h2>{L(lang, "Procurement Head", "ખરીદી વિભાગના વડા")}</h2>}
      {contact.name ? (
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <span style={{ fontWeight: 700 }}>{compact && `${L(lang, "Procurement Head", "ખરીદી વડા")}: `}{contact.name}</span>
          {href ? (
            <a className="btn btn-outline" style={{ width: "auto" }} href={href}>📞 {contact.phone}</a>
          ) : (
            <span className="sub">{L(lang, "Phone number not set", "ફોન નંબર ઉમેરેલ નથી")}</span>
          )}
        </div>
      ) : (
        <div className="sub">{L(lang, "No active Procurement Head is set up.", "કોઈ સક્રિય ખરીદી વડા સેટ નથી.")}</div>
      )}
      {isManagement && (contact.phone_missing || !contact.name) && (
        <div className="msg warning" style={{ marginTop: 8 }}>
          {L(lang,
            "Management: add the Procurement Head's phone number in User Management, so requesters can call them.",
            "મેનેજમેન્ટ: યુઝર મેનેજમેન્ટમાં ખરીદી વડાનો ફોન નંબર ઉમેરો, જેથી વિનંતી કરનાર તેમને કૉલ કરી શકે.")}
        </div>
      )}
    </div>
  );
}
