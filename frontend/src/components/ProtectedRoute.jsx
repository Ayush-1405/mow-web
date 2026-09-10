import React from "react";
import AccessDenied from "../screens/AccessDenied.jsx";

// Route-level authorization gate. `allowed` must be computed from the
// authenticated user's own profile/role/department (via useCurrentUserAccess
// — see lib/access.js), never from localStorage or any client-only flag.
// This only ever renders once App.jsx has already finished loading the
// profile and department lookups, so there is no loading/flash state to
// handle here — see the routing gate in App.jsx.
export default function ProtectedRoute({ allowed, lang, children }) {
  if (!allowed) return <AccessDenied lang={lang} />;
  return children;
}
