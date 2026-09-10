import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { downloadTaskProof } from "../lib/api";
import { t } from "../lib/i18n";

// Bilingual label lookups for the raw values staff_audit_log actually
// stores. Built directly from every staff_write_audit()/staff-create-user
// call site in the live schema (confirmed against pg_proc, not guessed) —
// an action or entity_type this map doesn't recognize still renders (the
// raw string, snake_case turned into Title Case for unmapped JSON keys)
// rather than disappearing, so a future action added on the server never
// silently breaks this screen.
const ACTION_KEYS = {
  CREATE: "actionCreate",
  ACCEPT: "actionAccept",
  START: "actionStart",
  COMPLETE: "actionComplete",
  VERIFY: "actionVerify",
  CLOSE: "actionClose",
  RETURN: "actionReturn",
  REASSIGN: "actionReassign",
  REQUEST_HELP: "actionRequestHelp",
  ATTACH: "actionAttach",
  ACTIVATE: "actionActivate",
  DEACTIVATE: "actionDeactivate",
  UPDATE_PROFILE: "actionUpdateProfile",
  CREATE_USER: "actionCreateUser",
  BOOTSTRAP_MANAGEMENT: "actionBootstrapManagement",
  PASSWORD_CHANGED: "actionPasswordChanged",
};

const ENTITY_KEYS = {
  task: "entityTask",
  bridge: "entityBridge",
  user_profile: "entityUser",
  user_profiles: "entityUser",
};

// Maps a raw old_value/new_value JSON key to the i18n key for its label.
// Anything not listed here still renders — see fieldLabel() below.
const FIELD_KEYS = {
  status: "status",
  assigned_to: "fieldAssignedTo",
  verifier_id: "verifier",
  to_department_id: "fieldToDepartment",
  from_department_id: "fieldFromDepartment",
  department_id: "department",
  reason: "reason",
  employee_code: "fieldEmployeeCode",
  full_name: "fullName",
  role_code: "fieldRoleCode",
  phone: "phone",
  file_type: "fileType",
  quantity: "quantity",
};

const FILE_TYPE_KEYS = {
  image: "fileTypeImage",
  pdf: "fileTypePdf",
  word: "fileTypeWord",
  excel: "fileTypeExcel",
  drawing: "fileTypeDrawing",
  voice: "fileTypeVoice",
};

const PERSON_FIELDS = new Set(["assigned_to", "verifier_id"]);
const DEPARTMENT_FIELDS = new Set(["department_id", "to_department_id", "from_department_id"]);

// Keys shown via the dedicated attachment preview control instead of the
// generic key/value list — attachment_id is never useful as raw text to an
// admin, and file_type is restated there next to the Play/Download button.
const ATTACH_HIDDEN_FIELDS = new Set(["attachment_id", "file_type"]);

function fieldLabel(key, lang) {
  const mapKey = FIELD_KEYS[key];
  if (mapKey) return t(mapKey, lang);
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderFieldValue(key, value, { lang, usersById, lookups }) {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "is_active") return value ? t("active", lang) : t("inactive", lang);
  if (PERSON_FIELDS.has(key)) return userLabel(usersById, value);
  if (DEPARTMENT_FIELDS.has(key)) {
    const d = lookups?.departmentById?.[value];
    return d ? (lang === "gu" ? d.name_gu : d.name_en) : "—";
  }
  if (key === "status") {
    const s = (lookups?.statuses || []).find((x) => x.code === value);
    return s ? (lang === "gu" ? s.name_gu : s.name_en) : value;
  }
  if (key === "role_code") {
    const r = (lookups?.roles || []).find((x) => x.code === value);
    return r ? (lang === "gu" ? r.name_gu : r.name_en) : value;
  }
  if (key === "file_type") {
    const fk = FILE_TYPE_KEYS[value];
    return fk ? t(fk, lang) : value;
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? t("active", lang) : t("inactive", lang);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function userLabel(usersById, id) {
  if (!id) return "—";
  const u = usersById[id];
  return u ? `${u.full_name} (${u.employee_code})` : "—";
}

// Renders old_value/new_value as a labeled key/value list instead of a raw
// JSON dump. Returns null when there's nothing left to show (e.g. every
// key in the object was hidden for the attachment preview instead).
function ValueFields({ value, ctx, hiddenKeys }) {
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value).filter(([k]) => !hiddenKeys?.has(k));
  if (entries.length === 0) return null;
  return (
    <div className="timeline">
      {entries.map(([k, v]) => (
        <div className="timeline-item" key={k}>
          <span className="timeline-label">{fieldLabel(k, ctx.lang)}</span>
          <span className="timeline-value">{renderFieldValue(k, v, ctx)}</span>
        </div>
      ))}
    </div>
  );
}

// Lets an admin actually open/listen to the file an ATTACH entry refers to,
// instead of seeing only its id. Fetches a signed URL on demand (same
// pattern as TaskDetail's AttachmentsList) — nothing is pre-fetched for an
// entry the admin hasn't opened.
function AttachmentPreview({ attachmentId, fileType, lang, showToast }) {
  const [playing, setPlaying] = useState(false);
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleOpen() {
    if (fileType === "voice" && playing) {
      setPlaying(false);
      return;
    }
    setBusy(true);
    try {
      const res = await downloadTaskProof(attachmentId);
      if (fileType === "voice") {
        setUrl(res.signed_url);
        setPlaying(true);
      } else {
        window.open(res.signed_url, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setBusy(false);
    }
  }

  const fileTypeLabel = fileType ? t(FILE_TYPE_KEYS[fileType] || "", lang) || fileType : null;

  return (
    <div style={{ marginTop: 8 }}>
      <div className="timeline-label">{t("auditAttachment", lang)}</div>
      <div className="btn-row" style={{ marginTop: 4, alignItems: "center" }}>
        <button
          type="button"
          className="btn btn-outline"
          style={{ width: "auto", margin: 0, minHeight: 36, padding: "6px 10px" }}
          disabled={busy}
          onClick={handleOpen}
        >
          {fileType === "voice" ? (playing ? t("hideDetails", lang) : `▶ ${t("play", lang)}`) : t("download", lang)}
        </button>
        {fileTypeLabel && <span style={{ fontSize: 13 }}>{fileTypeLabel}</span>}
      </div>
      {playing && url && <audio controls autoPlay src={url} style={{ width: "100%", marginTop: 6 }} />}
    </div>
  );
}

// Audit Log. staff_audit_log_select_scoped already restricts rows to what
// this caller is allowed to see (Management: all; Dept Head: own
// department/group only) — this screen adds no visibility filter of its
// own beyond that RLS policy. Every staff_* RPC writes here via the
// internal-only staff_write_audit() helper; nothing on this screen writes
// to the table. Each entry is clickable, revealing a readable before/after
// breakdown (action, entity, and every JSON field translated to a label
// and a resolved value — person/department ids become names, status/role
// codes become their display names) plus, for a file-attachment entry, a
// working Play/Download control for the actual file. The raw JSON is still
// available behind a "Show raw data" toggle for anyone who wants it.
export default function AuditLog({ lang, lookups, showToast }) {
  const [entries, setEntries] = useState([]);
  const [usersById, setUsersById] = useState({});
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [rawVisible, setRawVisible] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [logRes, dirRes] = await Promise.all([
      supabase.from("staff_audit_log").select("*").order("performed_at", { ascending: false }).limit(200),
      supabase.rpc("staff_list_assignable_users_all"),
    ]);
    if (logRes.error) showToast("error", logRes.error.message);
    else setEntries(logRes.data || []);
    if (!dirRes.error) setUsersById(Object.fromEntries((dirRes.data || []).map((u) => [u.id, u])));
    setLoading(false);
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const deptName = (id) => lookups.departmentById[id]?.[lang === "gu" ? "name_gu" : "name_en"] || "—";

  function toggleExpanded(id) {
    setExpandedId((cur) => (cur === id ? null : id));
    setRawVisible(false);
  }

  const ctx = { lang, usersById, lookups };

  return (
    <div>
      <div className="section-title">{t("auditLog", lang)}</div>
      <button className="btn btn-outline" style={{ marginBottom: 10 }} onClick={load} disabled={loading}>
        {t("refresh", lang)}
      </button>

      {loading && entries.length === 0 && <div className="msg info">…</div>}
      {!loading && entries.length === 0 && <div className="msg info">{t("noAuditEntries", lang)}</div>}

      <div className="audit-grid">
        {entries.map((e) => {
          const expanded = expandedId === e.id;
          const isAttach = e.action === "ATTACH" && e.new_value?.attachment_id;
          const actionLabel = t(ACTION_KEYS[e.action] || "", lang) || e.action;
          const entityLabel = t(ENTITY_KEYS[e.entity_type] || "", lang) || e.entity_type;
          const hiddenKeys = isAttach ? ATTACH_HIDDEN_FIELDS : undefined;

          return (
            <div
              className="task-card audit-card"
              key={e.id}
              onClick={() => toggleExpanded(e.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") toggleExpanded(e.id); }}
            >
              <div className="top-row">
                <div>
                  <div className="task-title">{actionLabel} — {entityLabel}</div>
                  {e.department_id && <div className="task-number">{deptName(e.department_id)}</div>}
                </div>
                <span className="badge">{expanded ? "▲" : "▼"}</span>
              </div>
              <div className="task-meta">
                <span>{t("performedBy", lang)}: {userLabel(usersById, e.performed_by)}</span>
                <span>{t("when", lang)}: {new Date(e.performed_at).toLocaleString()}</span>
              </div>
              {e.remarks && <div style={{ fontSize: 13, marginTop: 6 }}>{t("remarks", lang)}: {e.remarks}</div>}

              {expanded && (
                <div onClick={(ev) => ev.stopPropagation()}>
                  {isAttach && (
                    <AttachmentPreview
                      attachmentId={e.new_value.attachment_id}
                      fileType={e.new_value.file_type}
                      lang={lang}
                      showToast={showToast}
                    />
                  )}

                  {e.old_value && (
                    <div>
                      <div className="timeline-label" style={{ marginTop: 8 }}>{t("before", lang)}</div>
                      <ValueFields value={e.old_value} ctx={ctx} hiddenKeys={hiddenKeys} />
                    </div>
                  )}
                  {e.new_value && (
                    <div>
                      <div className="timeline-label" style={{ marginTop: 8 }}>{t("after", lang)}</div>
                      <ValueFields value={e.new_value} ctx={ctx} hiddenKeys={hiddenKeys} />
                    </div>
                  )}
                  {!e.old_value && !e.new_value && !isAttach && (
                    <div className="msg info" style={{ marginTop: 8 }}>{t("auditNoDetails", lang)}</div>
                  )}

                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ width: "auto", margin: "10px 0 0", minHeight: 32, padding: "4px 10px", fontSize: 12 }}
                    onClick={() => setRawVisible((v) => !v)}
                  >
                    {rawVisible ? t("auditHideRaw", lang) : t("auditShowRaw", lang)}
                  </button>
                  {rawVisible && (
                    <div style={{ marginTop: 6 }}>
                      <div className="timeline-item">
                        <span className="timeline-label">{t("entity", lang)}</span>
                        <span className="timeline-value">{e.entity_type} · {e.entity_id}</span>
                      </div>
                      {e.old_value && <pre className="audit-json">{JSON.stringify(e.old_value, null, 2)}</pre>}
                      {e.new_value && <pre className="audit-json">{JSON.stringify(e.new_value, null, 2)}</pre>}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
