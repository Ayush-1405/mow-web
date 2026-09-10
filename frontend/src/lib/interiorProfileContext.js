import { createContext, useContext } from "react";

// Provides the CURRENT user's row in the external Interior system's own
// `profiles` table (resolved/created by InteriorProfileGate.jsx via the
// interior_ensure_profile() RPC) to every Interior screen, so attribution
// fields (submitted_by, requested_by, uploaded_by, user_id...) can be
// populated with a real profiles.id instead of staying NULL forever.
export const InteriorProfileContext = createContext(null);

export function useInteriorProfile() {
  return useContext(InteriorProfileContext);
}
