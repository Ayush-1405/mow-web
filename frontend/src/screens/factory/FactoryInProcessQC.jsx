import React from "react";
import FactoryQcBoardShared from "./FactoryQcBoardShared.jsx";

export default function FactoryInProcessQC({ lang, profile }) {
  return <FactoryQcBoardShared lang={lang} profile={profile} qcStage="in_process" titleKey="factoryInProcessQcTitle" titleFallback="In-process QC" />;
}
