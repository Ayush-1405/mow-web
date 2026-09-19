import React from "react";

// Lightweight, dependency-free horizontal bar chart for a single magnitude
// series (e.g. "count by department", "count by status") — one hue, direct
// value labels, sorted by the caller. No categorical color needed here
// since each bar's identity is already given by its own text label, not by
// color — exactly the case the dataviz guidance calls for a single sequential
// hue rather than a categorical palette.
export default function SimpleBarChart({ data, color = "var(--brand)", valueSuffix = "" }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) return <div className="msg info">No data for the current filters.</div>;
  return (
    <div role="img" aria-label="Bar chart" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {data.map((d) => (
        <div key={d.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 140, flexShrink: 0, fontSize: 12, color: "var(--ink-soft)", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.label}>{d.label}</div>
          <div style={{ flex: 1, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden", height: 18 }}>
            <div style={{ width: `${Math.max((d.value / max) * 100, d.value > 0 ? 2 : 0)}%`, background: color, height: "100%", borderRadius: 4, transition: "width 200ms" }} />
          </div>
          <div style={{ width: 44, flexShrink: 0, fontSize: 12, fontWeight: 700 }}>{d.value}{valueSuffix}</div>
        </div>
      ))}
    </div>
  );
}
