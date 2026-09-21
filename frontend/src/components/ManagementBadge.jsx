import React from "react";

// Slim in-flow strip shown to Director / Management / Super Admin so it is always obvious that the lists on screen are organization-wide
// (every department), not just "mine". Purely informational -- the scope itself is enforced by RLS, not by this component.
export default function ManagementBadge({ label = "Management View — All Departments" }) {
  return (
    <div className="mgmt-badge" role="status">
      <span aria-hidden="true">🛡</span> {label}
    </div>
  );
}
