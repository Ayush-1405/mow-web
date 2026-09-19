import React from "react";

// Small, reusable checkbox shown only to Management/Super Admin/dept_head
// (gated upstream by useIncludeTestData's `canToggle`). Renders nothing for
// anyone else, so it is always safe to drop into a screen's filter bar.
export default function IncludeTestDataToggle({ canToggle, includeTestData, onChange }) {
  if (!canToggle) return null;
  return (
    <label
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, whiteSpace: "nowrap", cursor: "pointer" }}
      title="Show UAT/test-batch records (TEST-FJ-2026-xxxx) alongside real data. Visible to Management/Super Admin/Factory Head only."
    >
      <input type="checkbox" checked={includeTestData} onChange={(e) => onChange(e.target.checked)} />
      Show Test Data
    </label>
  );
}
