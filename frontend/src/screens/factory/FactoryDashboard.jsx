import React from "react";
import { useNavigate } from "react-router-dom";
import FactoryHeader from "./FactoryHeader.jsx";

// Phase 1 "complete redesign": the Factory Dashboard is now ONLY the four segment cards -- no counters, no
// tabs, no production-status grid, no priority/shortage/recent panels. Everything that used to live here
// (live counts, My Actions Today, Latest Job Cards) is still real and still reachable from the simplified
// Factory navigation (Home/New Orders/Job Cards/My Work/...) and each segment's own board page -- it just
// isn't crammed onto the landing screen anymore, per the explicit "should not contain ... unnecessary
// counters, complicated tables or multiple navigation sections".
const SEGMENTS = [
  { route: "/factory/material-to-order", icon: "📦", en: "Material to be Ordered", gu: "મટિરિયલ ઓર્ડર",
    desc: { en: "Request and track material needed for production.", gu: "ઉત્પાદન માટે જરૂરી મટિરિયલ મંગાવો અને ટ્રેક કરો." } },
  { route: "/factory/sofa", icon: "🛋️", en: "Sofa", gu: "સોફા",
    desc: { en: "Sofa orders, production stages and dispatch.", gu: "સોફા ઓર્ડર, ઉત્પાદન સ્ટેજ અને ડિસ્પેચ." } },
  { route: "/factory/modular", icon: "🗄️", en: "Modular", gu: "મોડ્યુલર",
    desc: { en: "Modular furniture orders, production and dispatch.", gu: "મોડ્યુલર ફર્નિચર ઓર્ડર, ઉત્પાદન અને ડિસ્પેચ." } },
  { route: "/factory/metal-fabrication", icon: "🔧", en: "Metal Fabrication", gu: "મેટલ ફેબ્રિકેશન",
    desc: { en: "Metal fabrication orders, production and dispatch.", gu: "મેટલ ફેબ્રિકેશન ઓર્ડર, ઉત્પાદન અને ડિસ્પેચ." } },
];

export default function FactoryDashboard({ lang, profile }) {
  const navigate = useNavigate();
  return (
    <div className="fx-page">
      <FactoryHeader lang={lang} profile={profile} title={lang === "gu" ? "ફેક્ટરી ડેશબોર્ડ" : "Factory Dashboard"} />
      <div className="fx-hero">
        {SEGMENTS.map((s) => (
          <button key={s.route} type="button" className="fx-seg" onClick={() => navigate(s.route)}>
            <span className="icon">{s.icon}</span>
            <span className="names"><span className="en">{s.en}</span><span className="gu">{s.gu}</span></span>
            <span className="sub">{lang === "gu" ? s.desc.gu : s.desc.en}</span>
            <span className="open-btn">{lang === "gu" ? "ખોલો" : "Open"} →</span>
          </button>
        ))}
      </div>
    </div>
  );
}
