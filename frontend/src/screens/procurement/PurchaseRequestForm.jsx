import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { createPurchaseRequest, getPurchaseRequest, submitPurchaseRequest, updatePurchaseRequest } from "../../lib/procurementApi";
import { L, PROC_CATEGORIES, PROC_PRIORITIES, SETUP_MISSING_TEXT, isProcurementSetupMissing, validateRequestForm } from "../../lib/procurementRules";
import { uploadPurchaseAttachment } from "../../lib/interiorApi";
import { friendlyError } from "../../lib/friendlyError";
import { kolkataDateStr } from "../../lib/kolkataTime";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import ProcurementContactCard from "../../components/ProcurementContactCard";

const EMPTY = {
  project_id: "", material_name: "", material_category: "", specifications: "", quantity: "", unit: "", required_by_date: "",
  priority: "NORMAL", remarks: "", delivery_location: "", procurement_category: "MATERIAL", is_emergency: false, emergency_reason: "",
};

const ERROR_TEXT = {
  required: ["Required", "જરૂરી"],
  positive: ["Must be more than zero", "શૂન્યથી વધુ હોવું જોઈએ"],
};

// Raise (or, for a draft / returned request, edit) a purchase request. Any department can raise one; it goes to that
// department's Head first, and only reaches Procurement once the Head approves.
export default function PurchaseRequestForm({ lang, profile, lookups }) {
  const navigate = useNavigate();
  const { id: editId } = useParams();
  const [params] = useSearchParams();
  const interiorProfile = useInteriorProfile();
  const [form, setForm] = useState({ ...EMPTY, project_id: params.get("project") || "" });
  const [errors, setErrors] = useState({});
  const [projects, setProjects] = useState([]);
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [loading, setLoading] = useState(!!editId);

  const department = lookups.departmentById?.[profile.department_id];
  const isInterior = department?.code === "INTERIOR";
  const selectedProject = useMemo(() => projects.find((p) => p.id === form.project_id), [projects, form.project_id]);

  useEffect(() => {
    if (!isInterior && !form.project_id) return undefined;
    let alive = true;
    supabase.rpc("staff_list_interior_project_options").then(({ data }) => { if (alive) setProjects(data || []); });
    return () => { alive = false; };
  }, [isInterior, form.project_id]);

  useEffect(() => {
    if (!editId) return undefined;
    let alive = true;
    getPurchaseRequest(editId).then(({ data }) => {
      if (!alive) return;
      if (data) {
        setForm({
          project_id: data.project_id || "", material_name: data.material_name || "", material_category: data.material_category || "",
          specifications: data.specifications || "", quantity: String(data.quantity ?? ""), unit: data.unit || "", required_by_date: data.required_by_date || "",
          priority: data.priority || "NORMAL", remarks: data.remarks || "", delivery_location: data.delivery_location || "",
          procurement_category: data.procurement_category || "MATERIAL", is_emergency: !!data.is_emergency, emergency_reason: data.emergency_reason || "",
        });
      }
      setLoading(false);
    });
    return () => { alive = false; };
  }, [editId]);

  const set = (k) => (e) => {
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: value }));
    setErrors((x) => ({ ...x, [k]: undefined }));
  };

  async function save(submit) {
    const found = validateRequestForm(form);
    if (isInterior && !form.project_id) found.project_id = "required";
    if (form.required_by_date && form.required_by_date < kolkataDateStr()) found.required_by_date = "past";
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    setServerError(null);
    let requestId = editId;
    let result;
    if (editId) {
      result = await updatePurchaseRequest(editId, form);
      if (!result.error && submit) result = await submitPurchaseRequest(editId);
    } else {
      result = await createPurchaseRequest(form, { submit });
      requestId = result.data?.id;
    }
    if (result.error) {
      setSaving(false);
      setServerError(isProcurementSetupMissing(result.error) ? L(lang, ...SETUP_MISSING_TEXT) : friendlyError(result.error.message));
      return;
    }
    // Supporting files: project requests file them with the project's purchase documents.
    const failed = [];
    if (form.project_id && files.length) {
      for (const file of files) {
        const { error } = await uploadPurchaseAttachment({
          projectId: form.project_id, purchaseRequestId: requestId, module: "request", file, fileCategory: "Supporting Document",
          uploadedBy: interiorProfile?.id || null,
        });
        if (error) failed.push(file.name);
      }
    }
    setSaving(false);
    navigate(`/purchase-requests/${requestId}`, { replace: true, state: failed.length ? { uploadFailed: failed } : null });
  }

  const err = (k) => errors[k] && (
    <div className="sub" style={{ color: "var(--danger, #a23434)" }}>
      {errors[k] === "past" ? L(lang, "Cannot be in the past", "ભૂતકાળની તારીખ ન હોઈ શકે") : L(lang, ...(ERROR_TEXT[errors[k]] || ERROR_TEXT.required))}
    </div>
  );

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 300 }} /></div>;

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🧾</div>
        <div className="dept-header-text">
          <h1>{editId ? L(lang, "Edit purchase request", "ખરીદી વિનંતી સુધારો") : L(lang, "New purchase request", "નવી ખરીદી વિનંતી")}</h1>
          <div className="sub">
            {L(lang, "Goes to your Department Head for approval, then to Procurement.", "પહેલા તમારા વિભાગના વડા પાસે મંજૂરી માટે, પછી ખરીદી વિભાગને જશે.")}
          </div>
        </div>
      </div>

      <form className="card form-grid" onSubmit={(e) => { e.preventDefault(); save(true); }} noValidate>
        <div className="field">
          <label>{L(lang, "Requester", "વિનંતી કરનાર")}</label>
          <input value={`${profile.full_name} — ${department ? (lang === "gu" ? department.name_gu : department.name_en) : "—"}`} readOnly />
        </div>
        {(isInterior || form.project_id) && (
          <div className="field">
            <label>{L(lang, "Project", "પ્રોજેક્ટ")} {isInterior && "*"}</label>
            <select value={form.project_id} onChange={set("project_id")} disabled={!!editId}>
              <option value="">—</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
            {selectedProject && <div className="sub">{L(lang, "Customer", "ગ્રાહક")}: {selectedProject.customer}{selectedProject.location ? ` · ${selectedProject.location}` : ""}</div>}
            {err("project_id")}
          </div>
        )}
        <div className="field">
          <label>{L(lang, "Material name", "સામગ્રીનું નામ")} *</label>
          <input value={form.material_name} onChange={set("material_name")} maxLength={200} />
          {err("material_name")}
        </div>
        <div className="field">
          <label>{L(lang, "Material category", "સામગ્રી પ્રકાર")} *</label>
          <input value={form.material_category} onChange={set("material_category")} placeholder={L(lang, "e.g. Plywood, Hardware, Fabric", "દા.ત. પ્લાયવુડ, હાર્ડવેર, ફેબ્રિક")} />
          {err("material_category")}
        </div>
        <div className="field">
          <label>{L(lang, "Purchase type", "ખરીદીનો પ્રકાર")} *</label>
          <select value={form.procurement_category} onChange={set("procurement_category")}>
            {PROC_CATEGORIES.map((c) => <option key={c.code} value={c.code}>{lang === "gu" ? c.gu : c.en}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{L(lang, "Quantity", "જથ્થો")} *</label>
          <input type="number" min="0" step="any" inputMode="decimal" value={form.quantity} onChange={set("quantity")} />
          {err("quantity")}
        </div>
        <div className="field">
          <label>{L(lang, "Unit", "એકમ")} *</label>
          <input value={form.unit} onChange={set("unit")} placeholder={L(lang, "e.g. sheet, kg, piece, sq ft", "દા.ત. શીટ, કિલો, નંગ, ચો.ફૂટ")} />
          {err("unit")}
        </div>
        <div className="field">
          <label>{L(lang, "Required by", "ક્યારે જોઈએ")} *</label>
          <input type="date" min={kolkataDateStr()} value={form.required_by_date} onChange={set("required_by_date")} />
          {err("required_by_date")}
        </div>
        <div className="field">
          <label>{L(lang, "Priority", "પ્રાથમિકતા")} *</label>
          <select value={form.priority} onChange={set("priority")}>
            {PROC_PRIORITIES.map((p) => <option key={p.code} value={p.code}>{lang === "gu" ? p.gu : p.en}</option>)}
          </select>
        </div>
        <div className="field full">
          <label>{L(lang, "Delivery location", "ડિલિવરી સ્થળ")} *</label>
          <input value={form.delivery_location} onChange={set("delivery_location")} placeholder={selectedProject?.location || ""} />
          {err("delivery_location")}
        </div>
        <div className="field full">
          <label>{L(lang, "Description / specifications", "વર્ણન / સ્પષ્ટીકરણ")}</label>
          <textarea value={form.specifications} onChange={set("specifications")} rows={3} />
        </div>
        <div className="field full">
          <label>{L(lang, "Remarks", "નોંધ")}</label>
          <textarea value={form.remarks} onChange={set("remarks")} rows={2} />
        </div>
        <div className="field full">
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={form.is_emergency} onChange={set("is_emergency")} style={{ width: "auto" }} />
            {L(lang, "Emergency purchase", "તાત્કાલિક ખરીદી")}
          </label>
          {form.is_emergency && (
            <>
              <textarea value={form.emergency_reason} onChange={set("emergency_reason")} rows={2}
                placeholder={L(lang, "Why can't this wait for the normal process?", "સામાન્ય પ્રક્રિયાની રાહ કેમ ન જોઈ શકાય?")} />
              {err("emergency_reason")}
            </>
          )}
        </div>
        {form.project_id && !editId && (
          <div className="field full">
            <label>{L(lang, "Supporting drawings / files", "સહાયક ડ્રોઇંગ / ફાઇલો")}</label>
            <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} />
          </div>
        )}
        {serverError && <div className="msg error field full">{serverError}</div>}
        <div className="field full btn-row">
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? L(lang, "Sending…", "મોકલાય છે…") : L(lang, "Send for approval", "મંજૂરી માટે મોકલો")}
          </button>
          <button className="btn btn-outline" type="button" disabled={saving} onClick={() => save(false)}>{L(lang, "Save as draft", "ડ્રાફ્ટ સાચવો")}</button>
          <button className="btn btn-outline" type="button" disabled={saving} onClick={() => navigate(-1)}>{L(lang, "Cancel", "રદ કરો")}</button>
        </div>
      </form>

      <ProcurementContactCard lang={lang} profile={profile} />
    </div>
  );
}
