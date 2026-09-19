import React from "react";

// Renders the currently-active filters as removable chips (always visible,
// any screen size) — `chips` is an array of {key, label, onClear}. Used
// alongside a `.collapsible-filters` block so a user on mobile can see what
// filters are applied without expanding the (collapsed-by-default) filter
// controls themselves.
export default function FilterChips({ chips }) {
  const active = chips.filter(Boolean);
  if (active.length === 0) return null;
  return (
    <div className="filter-chips-row">
      {active.map((c) => (
        <span key={c.key} className="filter-chip">
          {c.label}
          <button type="button" onClick={c.onClear} aria-label={`Clear ${c.label}`}>✕</button>
        </span>
      ))}
    </div>
  );
}
