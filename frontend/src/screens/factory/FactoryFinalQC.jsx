import React from "react";
import FactoryQcBoardShared from "./FactoryQcBoardShared.jsx";

export default function FactoryFinalQC({ lang, profile }) {
  return <FactoryQcBoardShared lang={lang} profile={profile} qcStage="final" titleKey="factoryFinalQcTitle" titleFallback="Final QC" />;
}
