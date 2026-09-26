import React from "react";
import { t } from "../lib/i18n";
import ProofPhotoViewer from "./ProofPhotoViewer.jsx";

// Amazon-style "seller to customer" order tracker. Every step below is derived from the SAME live, connected
// records this session already built (retail_orders.pipeline_status, retail_packing_records, retail_godown_handovers,
// retail_dispatch_records, retail_deliveries, retail_installations) — this component only changes how that real
// data is PRESENTED (a proper step tracker with the real proof photo inline), it never invents a new status.
const REACHED = {
  sentToGodown: ["ASSIGNED_TO_GODOWN", "RECEIVED_AT_GODOWN", "OUT_FOR_DELIVERY", "ARRIVED_AT_SITE", "DELIVERY_PROOF_UPLOADED", "DELIVERY_SUCCESSFUL", "DELIVERY_FAILED", "INSTALLATION_PENDING", "INSTALLATION_IN_PROGRESS", "INSTALLATION_PROOF_UPLOADED", "COMPLETED"],
  acceptedByGodown: ["RECEIVED_AT_GODOWN", "OUT_FOR_DELIVERY", "ARRIVED_AT_SITE", "DELIVERY_PROOF_UPLOADED", "DELIVERY_SUCCESSFUL", "INSTALLATION_PENDING", "INSTALLATION_IN_PROGRESS", "INSTALLATION_PROOF_UPLOADED", "COMPLETED"],
  packed: ["READY_FOR_GODOWN", "ASSIGNED_TO_GODOWN", "RECEIVED_AT_GODOWN", "OUT_FOR_DELIVERY", "ARRIVED_AT_SITE", "DELIVERY_PROOF_UPLOADED", "DELIVERY_SUCCESSFUL", "INSTALLATION_PENDING", "INSTALLATION_IN_PROGRESS", "INSTALLATION_PROOF_UPLOADED", "COMPLETED"],
  dispatched: ["OUT_FOR_DELIVERY", "ARRIVED_AT_SITE", "DELIVERY_PROOF_UPLOADED", "DELIVERY_SUCCESSFUL", "INSTALLATION_PENDING", "INSTALLATION_IN_PROGRESS", "INSTALLATION_PROOF_UPLOADED", "COMPLETED"],
  delivered: ["DELIVERY_SUCCESSFUL", "INSTALLATION_PENDING", "INSTALLATION_IN_PROGRESS", "INSTALLATION_PROOF_UPLOADED", "COMPLETED"],
  installed: ["COMPLETED"],
};

export default function OrderTracker({ lang, pipelineStatus, installationRequired, deliveryId, detail }) {
  const failed = pipelineStatus === "DELIVERY_FAILED";
  const onHold = pipelineStatus === "ON_HOLD";
  const cancelled = pipelineStatus === "CANCELLED";

  const steps = [
    { key: "confirmed", label: "orderConfirmedStepLabel", icon: "✅", reached: true },
    { key: "sentToGodown", label: "sentToGodownStepLabel", icon: "📦", reached: REACHED.sentToGodown.includes(pipelineStatus) },
    { key: "acceptedByGodown", label: "acceptedByGodownStepLabel", icon: "🏬", reached: REACHED.acceptedByGodown.includes(pipelineStatus) },
    { key: "packed", label: "packedStepLabel", icon: "📦", reached: REACHED.packed.includes(pipelineStatus), photoEntity: detail?.packing ? { type: "retail_packing", id: detail.packing.id } : null },
    { key: "dispatched", label: "dispatchedStepLabel", icon: "🚚", reached: REACHED.dispatched.includes(pipelineStatus), photoEntity: detail?.dispatch ? { type: "retail_dispatch", id: detail.dispatch.id } : null },
    { key: "delivered", label: "deliveredStepLabel", icon: "📬", reached: REACHED.delivered.includes(pipelineStatus), photoEntity: deliveryId ? { type: "retail_delivery", id: deliveryId } : null },
  ];
  if (installationRequired) {
    steps.push({ key: "installed", label: "installedStepLabel", icon: "🔧", reached: REACHED.installed.includes(pipelineStatus) && detail?.installation?.status === "COMPLETED", photoEntity: detail?.installation ? { type: "retail_installation", id: detail.installation.id } : null });
  }
  steps.push({ key: "completed", label: "completedTrackerStepLabel", icon: "🏁", reached: pipelineStatus === "COMPLETED" });

  return (
    <div style={{ display: "grid", gap: 4 }}>
      {failed && <div className="msg error">⚠️ {t("deliveryFailedTrackerMsg", lang)}</div>}
      {onHold && <div className="msg info">⏸️ {t("orderOnHoldTrackerMsg", lang)}</div>}
      {cancelled && <div className="msg info">✕ {t("orderCancelledTrackerMsg", lang)}</div>}
      {steps.map((s) => (
        <div key={s.key} style={{ display: "flex", alignItems: "flex-start", gap: 10, opacity: s.reached ? 1 : 0.45 }}>
          <span style={{ fontSize: 20, lineHeight: 1 }}>{s.reached ? "✅" : s.icon}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: s.reached ? 700 : 500 }}>{t(s.label, lang)}</div>
            {s.reached && s.photoEntity && (
              <ProofPhotoViewer lang={lang} entityType={s.photoEntity.type} entityId={s.photoEntity.id} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
