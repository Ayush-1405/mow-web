import React, { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import FactoryHeader from "./FactoryHeader.jsx";
import { StagesTab } from "./FactoryJobCardPage.jsx";
import { getJobCard, subscribeJobDetail } from "../../lib/factoryApi";
import { roleInfo } from "./factoryConstants";

// The dedicated WIP page (/factory/:segment/:jobCardId/wip) the spec asks for -- a full-page version of the
// same real stage engine already built for the Job Card's Stages tab (Start/Complete, mandatory photo gate,
// auto-advance, auto completion %), not a duplicate implementation.
export default function FactorySegmentWip({ lang, profile, lookups }) {
  const { segment, jobCardId } = useParams();
  const role = roleInfo(profile, lookups);
  const [job, setJob] = useState(undefined);

  const load = useCallback(() => {
    getJobCard(jobCardId).then(({ data }) => setJob(data || null));
  }, [jobCardId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeJobDetail(jobCardId, load), [jobCardId, load]);

  if (job === undefined) return <div className="fx-page"><div className="skeleton-block" style={{ height: 200 }} /></div>;
  if (job === null) return <div className="fx-page"><div className="fx-empty">{lang === "gu" ? "મળ્યું નથી" : "Not found"}</div></div>;

  const mine = !!profile?.id && (job.assigned_factory_coordinator === profile.id || job.second_assignee_coordinator === profile.id);

  return (
    <div className="fx-page">
      <FactoryHeader lang={lang} profile={profile} title={`${job.job_order_number} · ${lang === "gu" ? "WIP" : "WIP"}`} showNav={false} />
      <Link to={`/factory/${segment}/${jobCardId}`} className="fx-tag gold" style={{ width: "auto" }}>
        ← {lang === "gu" ? "જોબ કાર્ડ" : "Job Card"}
      </Link>
      <div className="task-meta" style={{ gap: 8, flexWrap: "wrap" }}>
        <strong>{job.product_item || "—"}</strong>
        <span className="fx-tag">{job.customer_name || "—"}</span>
        <span className="fx-tag gold">{job.priority}</span>
      </div>
      <section className="fx-section">
        <StagesTab job={job} lang={lang} canAct={role.isManager || mine} onDone={load} />
      </section>
    </div>
  );
}
