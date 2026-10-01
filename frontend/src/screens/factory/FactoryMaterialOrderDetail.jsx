import React, { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { t } from "../../lib/i18n";
import { getMaterialRequest, updateMaterialRequestStatus } from "../../lib/factoryApi";
import ProofPhotoUpload from "../../components/ProofPhotoUpload.jsx";
import ProofPhotoViewer from "../../components/ProofPhotoViewer.jsx";

const STATUSES = ["REQUESTED", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"];
const STATUS_BADGE = { REQUESTED: "ASSIGNED", ORDERED: "IN_PROGRESS", PARTIALLY_RECEIVED: "IN_PROGRESS", RECEIVED: "VERIFIED", CANCELLED: "RETURNED" };

// The dedicated record route the spec asks for (/factory/material-orders/:materialOrderId) -- a real, full
// single-record view, not a row expanded in place.
export default function FactoryMaterialOrderDetail({ lang }) {
  const { materialOrderId } = useParams();
  const [row, setRow] = useState(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getMaterialRequest(materialOrderId).then(({ data }) => setRow(data || null));
  }, [materialOrderId]);
  useEffect(() => { load(); }, [load]);

  async function changeStatus(status) {
    setBusy(true);
    await updateMaterialRequestStatus(materialOrderId, status, null);
    setBusy(false);
    load();
  }

  if (row === undefined) return <div className="fx-page"><div className="skeleton-block" style={{ height: 160 }} /></div>;
  if (row === null) return <div className="fx-page"><div className="fx-empty">{lang === "gu" ? "મળ્યું નથી" : "Not found"}</div></div>;

  return (
    <div className="fx-page">
      <Link to="/factory/material-orders" className="fx-tag gold" style={{ width: "auto" }}>← {lang === "gu" ? "મટિરિયલ ઓર્ડર" : "Material to Order"}</Link>
      <section className="fx-section">
        <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>{row.request_number} — {row.material}</h2>
          <span className={`badge ${STATUS_BADGE[row.status]}`}>{t(`materialStatus_${row.status}`, lang)}</span>
        </div>
        <div className="fx-kv" style={{ marginTop: 10 }}>
          <div><div className="k">{lang === "gu" ? "જથ્થો" : "Quantity"}</div><div className="v">{row.quantity} {row.unit}</div></div>
          <div><div className="k">{t("requestingDepartmentLabel", lang)}</div><div className="v">{lang === "gu" ? row.requesting_department?.name_gu : row.requesting_department?.name_en}</div></div>
          <div><div className="k">{t("relatedJobCardLabel", lang)}</div><div className="v">{row.job_card ? `${row.job_card.job_order_number} · ${row.job_card.product_item || ""}` : "—"}</div></div>
          <div><div className="k">{t("orderPoReferenceLabel", lang)}</div><div className="v">{row.order_po_reference || "—"}</div></div>
          <div><div className="k">{t("supplierOptionalLabel", lang)}</div><div className="v">{row.supplier || "—"}</div></div>
          <div><div className="k">{t("requiredDateLabel", lang)}</div><div className="v">{row.required_date || "—"}</div></div>
          <div><div className="k">{lang === "gu" ? "પ્રાથમિકતા" : "Priority"}</div><div className="v">{row.priority}</div></div>
          <div><div className="k">{t("notesLabel", lang)}</div><div className="v">{row.notes || "—"}</div></div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div className="sub" style={{ marginBottom: 6 }}>{t("attachPhotoDocumentHintMsg", lang)}</div>
          <ProofPhotoUpload lang={lang} entityType="factory_material_request" entityId={row.id} onUploaded={load} />
          <ProofPhotoViewer lang={lang} entityType="factory_material_request" entityId={row.id} />
        </div>

        {row.status !== "RECEIVED" && row.status !== "CANCELLED" && (
          <div className="task-meta" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {STATUSES.filter((s) => s !== row.status && s !== "REQUESTED").map((s) => (
              <button key={s} type="button" className="btn btn-outline" style={{ minHeight: 44 }} disabled={busy} onClick={() => changeStatus(s)}>
                {t(`materialStatus_${s}`, lang)}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
