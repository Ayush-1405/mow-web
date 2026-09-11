// Mood of Wood — MVP Pilot — staff-reset-password
//
// Authenticated endpoint. Accepts { user_id, new_password }. Lets
// Management/Sysadmin (any user) or a Dept Head (only within their own
// staff_dept_in_hod_scope, and never for an elevated role) set a new
// temporary password for a staff member who has forgotten theirs and
// cannot use the self-service Change Password screen.
//
// ALL role/scope authorization is delegated to the
// staff_authorize_password_reset() RPC, called through a client scoped to
// the caller's own verified session (never the service-role admin client)
// so auth.uid() inside that function resolves to the real caller. This
// file never re-implements that scope logic in JS — it only acts once the
// database has already said yes.
//
// Deploy with default JWT verification ON (do not pass --no-verify-jwt).

import { handlePreflight } from "../_shared/cors.ts";
import { errorResponse, okResponse } from "../_shared/response.ts";
import { MSG } from "../_shared/messages.ts";
import { adminClient, extractBearerToken, userScopedClient, verifyCaller } from "../_shared/clients.ts";
import { isUuid, isValidPassword } from "../_shared/validation.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(405, MSG.methodNotAllowed, origin);
  }

  const token = extractBearerToken(req);
  if (!token) {
    return errorResponse(401, MSG.unauthorized, origin);
  }

  const verifiedUser = await verifyCaller(token);
  if (!verifiedUser) {
    return errorResponse(401, MSG.unauthorized, origin);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, MSG.invalidJson, origin);
  }
  if (typeof body !== "object" || body === null) {
    return errorResponse(400, MSG.invalidJson, origin);
  }
  const payload = body as Record<string, unknown>;

  const targetUserId = isUuid(payload.user_id) ? (payload.user_id as string) : null;
  // Never log this destructured value — it is the new password.
  const newPassword = payload.new_password;

  if (!targetUserId) {
    return errorResponse(400, MSG.missingFields, origin);
  }
  if (!isValidPassword(newPassword)) {
    return errorResponse(400, MSG.weakPassword, origin);
  }

  // ---- Authorization, run AS the caller (never the admin client) so
  // auth.uid() inside staff_authorize_password_reset resolves to the real
  // verified caller. Mirrors the exact scope rule staff_set_user_active
  // already enforces for editing a roster row. ----
  const caller = userScopedClient(token);
  const { error: authError } = await caller.rpc("staff_authorize_password_reset", { p_user_id: targetUserId });
  if (authError) {
    console.error("staff-reset-password: authorization denied:", authError.message);
    return errorResponse(403, MSG.notAuthorized, origin);
  }

  const admin = adminClient();

  // ---- Set the new Auth password for the TARGET user (never the caller —
  // targetUserId here was already verified authorized above, and this is
  // the only place in this file that touches Supabase Auth). ----
  const { error: updateError } = await admin.auth.admin.updateUserById(targetUserId, {
    password: newPassword,
  });
  if (updateError) {
    console.error("staff-reset-password: Auth password update failed:", updateError.message);
    return errorResponse(500, MSG.serverError, origin);
  }

  // ---- Force the target to change this temporary password on next login
  // (same as a freshly created account), and write the audit row -- both
  // done inside staff_mark_password_reset(), a SECURITY DEFINER RPC
  // EXECUTE-granted only to service_role (service_role itself has no
  // direct UPDATE grant on user_profiles, same as every other
  // password/profile mutation in this codebase). ----
  const { error: markError } = await admin.rpc("staff_mark_password_reset", { p_user_id: targetUserId });
  if (markError) {
    // The Auth password itself already changed successfully at this
    // point — log and continue rather than pretending the reset didn't
    // happen.
    console.error("staff-reset-password: staff_mark_password_reset failed:", markError.message);
  }

  return okResponse(
    {
      success: true,
      message: { en: "Password reset successfully.", gu: "પાસવર્ડ સફળતાપૂર્વક રીસેટ થયો." },
    },
    origin,
  );
});
