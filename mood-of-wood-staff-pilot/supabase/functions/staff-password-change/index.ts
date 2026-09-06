// Mood of Wood — MVP Pilot — staff-password-change
//
// Authenticated endpoint. Accepts { new_password }. The acting user id is
// ALWAYS the server-verified id from the Bearer token — a client-supplied
// user id is never read or accepted, anywhere in this file.
//
// Deploy with default JWT verification ON (do not pass --no-verify-jwt).

import { handlePreflight } from "../_shared/cors.ts";
import { errorResponse, okResponse } from "../_shared/response.ts";
import { MSG } from "../_shared/messages.ts";
import { adminClient, extractBearerToken, verifyCaller } from "../_shared/clients.ts";
import { isValidPassword } from "../_shared/validation.ts";

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

  const admin = adminClient();

  // Require an active pilot profile. (This endpoint is deliberately exempt
  // from the must_change_password gate elsewhere — it's how that flag gets
  // cleared in the first place.)
  const { data: profile, error: profileError } = await admin
    .from("user_profiles")
    .select("id, is_active")
    .eq("id", verifiedUser.id)
    .maybeSingle();

  if (profileError) {
    console.error("staff-password-change: profile lookup failed:", profileError.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  if (!profile || !profile.is_active) {
    return errorResponse(403, MSG.accountInactive, origin);
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

  // Never log this destructured value — it is the new password.
  const { new_password } = body as Record<string, unknown>;

  if (!isValidPassword(new_password)) {
    return errorResponse(400, MSG.weakPassword, origin);
  }

  // ---- Update Auth password for the verified caller ONLY ----
  const { error: updateError } = await admin.auth.admin.updateUserById(verifiedUser.id, {
    password: new_password,
  });

  if (updateError) {
    console.error("staff-password-change: Auth password update failed:", updateError.message);
    return errorResponse(500, MSG.serverError, origin);
  }

  // ---- Clear must_change_password for the SAME verified id (never from the client) ----
  // staff_complete_password_change is granted to service_role only — must be
  // called via the admin client, not a user-scoped one.
  const { error: rpcError } = await admin.rpc("staff_complete_password_change", {
    p_user_id: verifiedUser.id,
  });

  if (rpcError) {
    // The Auth password itself already changed successfully at this point.
    // The RPC is idempotent (plain UPDATE ... SET must_change_password = false),
    // so a retry of this same endpoint is always safe.
    console.error("staff-password-change: staff_complete_password_change failed:", rpcError.message);
    return errorResponse(500, MSG.serverError, origin);
  }

  return okResponse(
    {
      success: true,
      message: { en: "Password updated successfully.", gu: "પાસવર્ડ સફળતાપૂર્વક અપડેટ થયો." },
    },
    origin,
  );
});
