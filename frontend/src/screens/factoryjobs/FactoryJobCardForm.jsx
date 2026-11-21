import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { BLANK_ITEM, FILE_KINDS, L, PRIORITIES, createJobCard, guessFileKind, todayIST, uploadJobFile, validateJobCard } from "../../lib/factoryJobApi";
import { friendlyError } from "../../lib/friendlyError";

// CREATE FACTORY JOB CARD -- any department sends a production order straight to the Factory. On send the database
// gives it a Job Card number (MW-FJC-YYYY-NNNN), a Factory task and a Bridge, and tells the Factory; no approval step.
// Files are previewed here and uploaded to the card right after it is created.

const ERR = {
  required: ["Required", "જરૂરી"], past: ["Cannot be in the past", "ભૂતકાળની ન હોઈ શકે"], quantity: ["More than 0", "0 થી વધુ"],
  none: ["Add at least one product", "ઓછામાં ઓછું એક ઉત્પાદન ઉમેરો"],
};

export default function FactoryJobCardForm({ lang, profile, lookups }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const dept = lookups.departmentById?.[profile.department_id];
  const isInterior = dept?.code === "INTERIOR";
  const [header, setHeader] = useState({
    client_name: "", project_name: "", project_id: params.get("project") || "", due_date: "", priority: "NORMAL", delivery_location: "",
    special_instructions: "", source_task_id: params.get("task") || "",
  });
  const [items, setItems] = useState([{ ...BLANK_ITEM }]);
  const [files, setFiles] = useState([]); // [{file, kind}]
  const [projects, setProjects] = useState([]);
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [saving, setSaving] = useState(false);
  const key = useRef(crypto.randomUUID()); // one key per form: a double click or retry never makes a second card

  useEffect(() => {
    if (!isInterior) return undefined;
    let alive = true;
    supabase.rpc("staff_list_interior_project_options").then(({ data }) => { if (alive) setProjects(data || []); });
    return () => { alive = false; };
  }, [isInterior]);

  const [deptHead, setDeptHead] = useState("");
  const headRole = useMemo(() => lookups.roles.find((r) => r.code === "dept_head")?.id, [lookups.roles]);
  useEffect(() => {
    if (!headRole || !profile.department_id) return undefined;
    let alive = true;
    supabase.from("user_profiles").select("full_name").eq("department_id", profile.department_id).eq("role_id", headRole).eq("is_active", true)
      .then(({ data }) => { if (alive) setDeptHead((data || []).map((u) => u.full_name).join(", ")); });
    return () => { alive = false; };
  }, [headRole, profile.department_id]);

  const setH = (k) => (e) => { const v = e.target.value; setHeader((h) => ({ ...h, [k]: v })); setErrors((x) => ({ ...x, [k]: undefined })); };
  const setItem = (n, k) => (e) => {
    const v = e.target.value;
    setItems((l) => l.map((it, i) => (i === n ? { ...it, [k]: v } : it)));
    setErrors((x) => ({ ...x, items: undefined, lines: undefined }));
  };
  function pickProject(id) {
    const p = projects.find((x) => x.id === id);
    setHeader((h) => ({ ...h, project_id: id, project_name: p ? p.project_code : h.project_name, client_name: p?.customer || h.client_name,
      delivery_location: h.delivery_location || p?.location || "" }));
  }

  async function submit(e) {
    e.preventDefault();
    const found = validateJobCard(header, items);
    setErrors(found);
    if (Object.keys(found).length) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    setSaving(true); setServerError(null);
    const { data, error } = await createJobCard(header, items, key.current);
    if (error) { setSaving(false); setServerError(friendlyError(error.message)); return; }
    const failed = [];
    for (const f of files) { const { error: ue } = await uploadJobFile(data.id, f.file, f.kind); if (ue) failed.push(f.file.name); }
    setSaving(false);
    navigate(`/factory-job-cards/${data.id}${failed.length ? `?upload_failed=${encodeURIComponent(failed.join(", "))}` : ""}`);
  }

  const err = (k) => errors[k] && <div className="sub" style={{ color: "var(--danger)" }}>{L(lang, ...ERR[errors[k]])}</div>;
  const lineErr = (n, k) => errors.lines?.[n]?.[k] && <div className="sub" style={{ color: "var(--danger)" }}>{L(lang, ...ERR[errors.lines[n][k]])}</div>;

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🏭</div>
        <div className="dept-header-text">
          <h1>{L(lang, "Create Factory Job Card", "ફેક્ટરી જોબ કાર્ડ બનાવો")}</h1>
          <div className="sub">{L(lang, "Goes straight to the Factory. The Job Card number is given when you send it.", "સીધું ફેક્ટરીને જશે. મોકલતાં જ જોબ કાર્ડ નંબર મળશે.")}</div>
        </div>
      </div>

      <form className="card form-grid" onSubmit={submit} noValidate>
        <h2 className="field full">{L(lang, "Order information", "ઓર્ડર માહિતી")}</h2>
        <div className="field"><label>{L(lang, "Job Card number", "જોબ કાર્ડ નંબર")}</label><input readOnly value={L(lang, "Given automatically on sending", "મોકલતાં આપોઆપ")} /></div>
        <div className="field"><label>{L(lang, "Requesting department", "વિનંતી કરનાર વિભાગ")}</label><input readOnly value={dept ? L(lang, dept.name_en, dept.name_gu) : "—"} /></div>
        <div className="field"><label>{L(lang, "Requested by", "વિનંતી કરનાર")}</label><input readOnly value={profile.full_name} /></div>
        <div className="field"><label>{L(lang, "Department Head", "વિભાગના વડા")}</label><input readOnly value={deptHead || "—"} /></div>
        {isInterior && (
          <div className="field">
            <label>{L(lang, "Interior project", "ઇન્ટિરિયર પ્રોજેક્ટ")}</label>
            <select value={header.project_id} onChange={(e) => pickProject(e.target.value)}>
              <option value="">{L(lang, "— No project —", "— પ્રોજેક્ટ વગર —")}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          </div>
        )}
        <div className="field"><label>{L(lang, "Client name", "ગ્રાહકનું નામ")}</label><input value={header.client_name} onChange={setH("client_name")} /></div>
        <div className="field"><label>{L(lang, "Project name", "પ્રોજેક્ટનું નામ")}</label><input value={header.project_name} onChange={setH("project_name")} /></div>
        <div className="field"><label>{L(lang, "Order date", "ઓર્ડર તારીખ")}</label><input readOnly value={todayIST().split("-").reverse().join("-")} /></div>
        <div className="field">
          <label>{L(lang, "Required completion date", "પૂર્ણ કરવાની તારીખ")} *</label>
          <input type="date" min={todayIST()} value={header.due_date} onChange={setH("due_date")} />{err("due_date")}
        </div>
        <div className="field">
          <label>{L(lang, "Priority", "પ્રાથમિકતા")}</label>
          <select value={header.priority} onChange={setH("priority")}>
            {PRIORITIES.map((p) => <option key={p.code} value={p.code}>{L(lang, p.en, p.gu)}</option>)}
          </select>
        </div>
        <div className="field full"><label>{L(lang, "Delivery location", "ડિલિવરી સ્થળ")}</label><input value={header.delivery_location} onChange={setH("delivery_location")} /></div>

        <h2 className="field full" style={{ marginTop: 8 }}>{L(lang, "Product information", "ઉત્પાદન માહિતી")}</h2>
        {items.map((it, n) => (
          <div key={n} className="field full fjc-item">
            <div className="fjc-item-head">
              <b>{L(lang, "Product", "ઉત્પાદન")} {n + 1}</b>
              {items.length > 1 && <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0 }} onClick={() => setItems((l) => l.filter((_, i) => i !== n))}>✕ {L(lang, "Remove", "દૂર કરો")}</button>}
            </div>
            <div className="form-grid">
              <div className="field"><label>{L(lang, "Product name", "ઉત્પાદનનું નામ")} *</label><input value={it.product_name} onChange={setItem(n, "product_name")} />{lineErr(n, "product_name")}</div>
              <div className="field"><label>{L(lang, "Product category", "કેટેગરી")}</label><input value={it.product_category} onChange={setItem(n, "product_category")} placeholder={L(lang, "Sofa, modular, metal…", "સોફા, મોડ્યુલર…")} /></div>
              <div className="field"><label>{L(lang, "Item code", "આઇટમ કોડ")}</label><input value={it.item_code} onChange={setItem(n, "item_code")} /></div>
              <div className="field">
                <label>{L(lang, "Quantity", "જથ્થો")} *</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input type="number" min="0" step="any" inputMode="decimal" value={it.quantity} onChange={setItem(n, "quantity")} style={{ flex: 1 }} />
                  <input value={it.unit} onChange={setItem(n, "unit")} style={{ width: 80 }} aria-label={L(lang, "Unit", "એકમ")} />
                </div>
                {lineErr(n, "quantity")}
              </div>
              <div className="field"><label>{L(lang, "Dimensions / size", "માપ")}</label><input value={it.dimensions} onChange={setItem(n, "dimensions")} placeholder="84 x 36 x 32 in" /></div>
              <div className="field"><label>{L(lang, "Finish / colour", "ફિનિશ / રંગ")}</label><input value={it.finish_colour} onChange={setItem(n, "finish_colour")} /></div>
              <div className="field full"><label>{L(lang, "Product description", "વર્ણન")}</label><textarea rows={2} value={it.description} onChange={setItem(n, "description")} /></div>
              <div className="field"><label>{L(lang, "Material specifications", "મટિરિયલ સ્પષ્ટીકરણ")}</label><textarea rows={2} value={it.material_spec} onChange={setItem(n, "material_spec")} /></div>
              <div className="field"><label>{L(lang, "Laminate / fabric / hardware", "લેમિનેટ / ફેબ્રિક / હાર્ડવેર")}</label><textarea rows={2} value={it.laminate_fabric_hardware} onChange={setItem(n, "laminate_fabric_hardware")} /></div>
              <div className="field full"><label>{L(lang, "Special instructions", "ખાસ સૂચના")}</label><input value={it.instructions} onChange={setItem(n, "instructions")} /></div>
            </div>
          </div>
        ))}
        <div className="field full">
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setItems((l) => [...l, { ...BLANK_ITEM }])}>+ {L(lang, "Add another product", "બીજું ઉત્પાદન ઉમેરો")}</button>
          {err("items")}
        </div>
        <div className="field full"><label>{L(lang, "Instructions for the whole order", "આખા ઓર્ડર માટે સૂચના")}</label><textarea rows={2} value={header.special_instructions} onChange={setH("special_instructions")} /></div>

        <h2 className="field full" style={{ marginTop: 8 }}>{L(lang, "Drawings and references", "ડ્રોઇંગ અને સંદર્ભ")}</h2>
        <div className="field full">
          <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.dwg,.dxf"
            onChange={(e) => { const picked = Array.from(e.target.files || []).map((file) => ({ file, kind: guessFileKind(file) })); setFiles((l) => [...l, ...picked]); e.target.value = ""; }} />
          <div className="sub">{L(lang, "Product images, technical drawings, PDFs and reference photos. Check each one below before sending.", "ઉત્પાદન ફોટા, ડ્રોઇંગ, PDF અને સંદર્ભ ફોટા. મોકલતાં પહેલાં નીચે તપાસો.")}</div>
          <FilePreviews files={files} lang={lang} onKind={(n, kind) => setFiles((l) => l.map((f, i) => (i === n ? { ...f, kind } : f)))}
            onRemove={(n) => setFiles((l) => l.filter((_, i) => i !== n))} />
        </div>

        {Object.keys(errors).length > 0 && <div className="msg error field full">{L(lang, "Please complete the fields marked in red.", "લાલ રંગમાં દર્શાવેલ ખાના ભરો.")}</div>}
        {serverError && <div className="msg error field full">{serverError}</div>}
        <div className="field full btn-row">
          <button className="btn btn-primary" type="submit" disabled={saving} style={{ fontSize: 17, minHeight: 52 }}>
            {saving ? L(lang, "Sending…", "મોકલાય છે…") : `🏭 ${L(lang, "Send to Factory", "ફેક્ટરીને મોકલો")}`}
          </button>
          <button className="btn btn-outline" type="button" disabled={saving} onClick={() => navigate(-1)}>{L(lang, "Cancel", "રદ કરો")}</button>
        </div>
      </form>
    </div>
  );
}

// Chosen files before sending: photos as real thumbnails (click to view large), PDFs open in a new tab; each has its kind.
function FilePreviews({ files, lang, onKind, onRemove }) {
  const [urls, setUrls] = useState([]);
  const [big, setBig] = useState(null);
  useEffect(() => {
    const u = files.map((f) => (/^image\//i.test(f.file.type) || /pdf/i.test(f.file.type) ? URL.createObjectURL(f.file) : null));
    setUrls(u);
    return () => u.forEach((x) => x && URL.revokeObjectURL(x));
  }, [files]);
  if (!files.length) return null;
  return (
    <>
      <div className="att-grid" style={{ marginTop: 8 }}>
        {files.map((f, n) => {
          const image = /^image\//i.test(f.file.type) && urls[n];
          return (
            <div key={`${f.file.name}-${f.file.size}-${n}`} className="att-tile" style={{ cursor: "default" }}>
              {image ? <img src={urls[n]} alt={f.file.name} onClick={() => setBig(urls[n])} style={{ cursor: "zoom-in" }} />
                : <span className="att-icon" onClick={() => urls[n] && window.open(urls[n], "_blank", "noopener")} style={{ cursor: urls[n] ? "pointer" : "default" }}>
                    {/pdf/i.test(f.file.type) ? "📄" : "📐"}</span>}
              <span className="att-name">{f.file.name}</span>
              <select value={f.kind} onChange={(e) => onKind(n, e.target.value)} style={{ margin: "4px 0 0", fontSize: 12, padding: "2px 4px", minHeight: 0 }}
                aria-label={L(lang, "File kind", "ફાઇલનો પ્રકાર")}>
                {FILE_KINDS.map((k) => <option key={k.code} value={k.code}>{L(lang, k.en, k.gu)}</option>)}
              </select>
              <button type="button" className="att-remove" onClick={() => onRemove(n)} aria-label={L(lang, `Remove ${f.file.name}`, `${f.file.name} દૂર કરો`)}>✕</button>
            </div>
          );
        })}
      </div>
      {big && (
        <div className="att-lightbox" role="dialog" onClick={() => setBig(null)}>
          <img src={big} alt="" />
        </div>
      )}
    </>
  );
}
