import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";
import { FILTER_FIELDS } from "../lib/taskFilters";

// Reusable pieces of the Today's Tasks date/filter toolbar. None of them own
// filter state -- TodayTasks keeps the single source of truth and passes
// values + setters in, so the mobile sheet, the tablet panel and the desktop
// row all drive exactly the same state (and only one set of controls is ever
// in the DOM at a time).

function ChevronIcon({ dir }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {dir === "left" ? <polyline points="12.5 4.5 7 10 12.5 15.5" /> : <polyline points="7.5 4.5 13 10 7.5 15.5" />}
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 5h14M6 10h8M8.5 15h3" />
    </svg>
  );
}

// [‹] [ date ] [›] -- icon-first; the words only appear from tablet up.
export function DateNavigator({ lang, value, onChange, onPrev, onNext }) {
  return (
    <div className="tt-datenav">
      <button type="button" className="btn btn-outline tt-navbtn" onClick={onPrev} aria-label={t("tfPrevDay", lang)}>
        <ChevronIcon dir="left" />
        <span className="tt-navtext">{t("tfPrevDay", lang)}</span>
      </button>
      <input type="date" className="tt-dateinput" value={value} onChange={(e) => onChange(e.target.value)} aria-label={t("tfDateLabel", lang)} />
      <button type="button" className="btn btn-outline tt-navbtn" onClick={onNext} aria-label={t("tfNextDay", lang)}>
        <span className="tt-navtext">{t("tfNextDay", lang)}</span>
        <ChevronIcon dir="right" />
      </button>
    </div>
  );
}

// One scrollable row. `chips` = [{ key, label, active, onSelect }].
export function QuickDateChips({ lang, chips }) {
  return (
    <div className="tt-chips" role="group" aria-label={t("tfQuickDates", lang)}>
      {chips.map((c) => (
        <button key={c.key} type="button" aria-pressed={c.active} className={`btn tt-chip ${c.active ? "btn-gold" : "btn-outline"}`} onClick={c.onSelect}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

export function TaskSearchBar({ lang, value, onChange, children }) {
  return (
    <div className="tt-searchrow">
      <input
        type="search"
        className="tt-search"
        placeholder={t("tfSearchPlaceholder", lang)}
        aria-label={t("searchLabel", lang)}
        enterKeyHint="search"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {children}
    </div>
  );
}

export function FilterButton({ lang, count, expanded, controls, hasPopup, onClick }) {
  return (
    <button
      type="button"
      className={`btn tt-filterbtn ${count > 0 ? "btn-gold" : "btn-outline"}`}
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-haspopup={hasPopup ? "dialog" : undefined}
    >
      <FilterIcon />
      <span>{t("tfFilters", lang)}{count > 0 ? ` (${count})` : ""}</span>
    </button>
  );
}

// The labelled selects. Used inline (tablet/desktop, live) and inside the
// mobile sheet (draft, applied on demand) -- the caller decides which values
// object and setter to bind.
export function FilterFields({ lang, idPrefix, values, options, onChange }) {
  return (
    <div className="tt-fields">
      {FILTER_FIELDS.filter((f) => f.key !== "project" || options.projects.length > 0).map((f) => (
        <div className="tt-field" key={f.key}>
          <label htmlFor={`${idPrefix}-${f.key}`}>{t(f.labelKey, lang)}</label>
          <select id={`${idPrefix}-${f.key}`} value={values[f.key]} onChange={(e) => onChange(f.key, e.target.value)}>
            <option value="">{t(f.allKey, lang)}</option>
            {options[f.optionsKey].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      ))}
      <div className="tt-field">
        <label htmlFor={`${idPrefix}-filterType`}>{t("tfFilterTypeField", lang)}</label>
        <select id={`${idPrefix}-filterType`} value={values.filterType} onChange={(e) => onChange("filterType", e.target.value)}>
          <option value="due">{t("dueDateFilterTypeLabel", lang)}</option>
          <option value="assigned">{t("assignedDateFilterTypeLabel", lang)}</option>
        </select>
      </div>
    </div>
  );
}

export function ActiveFilterChips({ lang, filters, onRemove, onClearAll }) {
  if (filters.length === 0) return null;
  return (
    <div className="tt-active">
      <ul className="tt-active-list" aria-label={t("tfActiveFilters", lang)}>
        {filters.map((f) => (
          <li key={f.key}>
            <button type="button" className="tt-activechip" onClick={() => onRemove(f.key)} aria-label={`${t("tfRemoveFilter", lang)}: ${f.label} ${f.value}`}>
              <span className="tt-activechip-text"><b>{f.label}:</b> {f.value}</span>
              <span aria-hidden="true" className="tt-activechip-x">×</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="tt-textbtn" onClick={onClearAll}>{t("tfClearAll", lang)}</button>
      <span className="tt-sr" role="status" aria-live="polite">{filters.length} {t("tfActiveCount", lang)}</span>
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Bottom sheet for phones. Edits a DRAFT copy of the filter values; nothing
// is applied until "Apply Filters". Closing (X, backdrop, Escape) discards
// the draft. Reopening starts from the currently applied values.
export function MobileFilterSheet({ lang, open, values, options, onApply, onClearAll, onClose }) {
  const [draft, setDraft] = useState(values);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const titleId = useId();
  const idPrefix = useId();

  // Fresh draft every time the sheet opens.
  useEffect(() => { if (open) setDraft(values); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lock background scroll, move focus into the dialog, give it back on close.
  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement;
    const htmlOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.documentElement.style.overflow = htmlOverflow;
      document.body.style.overflow = bodyOverflow;
      if (previouslyFocused && typeof previouslyFocused.focus === "function") previouslyFocused.focus();
    };
  }, [open]);

  if (!open) return null;

  function onKeyDown(e) {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab") return;
    const nodes = dialogRef.current?.querySelectorAll(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  return createPortal(
    <div className="tt-sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="tt-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <div className="tt-sheet-head">
          <h2 id={titleId}>{t("tfFiltersTitle", lang)}</h2>
          <button ref={closeRef} type="button" className="tt-sheet-close" onClick={onClose} aria-label={t("close", lang)}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="tt-sheet-body">
          <FilterFields lang={lang} idPrefix={idPrefix} values={draft} options={options} onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))} />
        </div>
        <div className="tt-sheet-foot">
          <button type="button" className="btn btn-outline" onClick={onClearAll}>{t("tfClearAll", lang)}</button>
          <button type="button" className="btn btn-primary" onClick={() => onApply(draft)}>{t("tfApply", lang)}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
