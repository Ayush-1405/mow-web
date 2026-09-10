// Mood of Wood — MVP Pilot — staff-login
//
// Public endpoint. Accepts { employee_code, password }. Resolves the
// employee code to an internal Auth email via the service-role-only
// resolve_employee_login() RPC, then signs in through Supabase Auth.
// Returns ONLY access_token / refresh_token / expires_in / must_change_password
// — never the internal email, never a full session/user object.
//
// Deploy with --no-verify-jwt (this is the one function with no caller token
// to verify yet).

import { handlePreflight } from "../_shared/cors.ts";
import { errorResponse, okResponse } from "../_shared/response.ts";
import { MSG } from "../_shared/messages.ts";
import { adminClient, anonClient } from "../_shared/clients.ts";
import { normalizeEmployeeCode, isNonEmptyString } from "../_shared/validation.ts";

const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

interface ResolvedLogin {
  auth_user_id: string;
  auth_email: string;
  is_active: boolean;
  must_change_password: boolean;
}

Deno.serve(async (req) => {
  // CORS preflight is handled before any JSON parsing, auth check, or other
  // logic — this must stay the very first thing in the handler.
  const origin = req.headers.get("origin");
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  // Everything else is wrapped in try/catch so that ANY unexpected error
  // (a thrown exception from a client library, a network blip, a bug) still
  // returns a JSON response carrying the same CORS headers as every other
  // response — never a bare/uncaught error with no CORS headers, which is
  // what the browser reports as a generic CORS/network failure.
  try {
    if (req.method !== "POST") {
      return errorResponse(405, MSG.methodNotAllowed, origin);
    }

    // JSON parsing only ever happens for POST, after the method check above.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(400, MSG.invalidJson, origin);
    }
    if (typeof body !== "object" || body === null) {
      return errorResponse(400, MSG.invalidJson, origin);
    }

    const { employee_code, password } = body as Record<string, unknown>;
    const normalizedCode = normalizeEmployeeCode(employee_code);

    // Never log the raw request body — it may contain the password.
    if (!normalizedCode || !isNonEmptyString(password, 200)) {
      return errorResponse(400, MSG.missingFields, origin);
    }

    const admin = adminClient();
    const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();

    // ---- Rate limit: 5 failed attempts / 15 minutes for this employee_code ----
    const { count: failedCount, error: countError } = await admin
      .from("login_attempts")
      .select("id", { count: "exact", head: true })
      .eq("employee_code", normalizedCode)
      .eq("success", false)
      .gte("attempted_at", windowStart);

    if (countError) {
      console.error("staff-login: rate-limit lookup failed:", countError.message);
      return errorResponse(500, MSG.serverError, origin);
    }
    if ((failedCount ?? 0) >= MAX_FAILED_ATTEMPTS) {
      return errorResponse(429, MSG.tooManyAttempts, origin);
    }

    const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const userAgent = req.headers.get("user-agent") ?? null;

    const recordAttempt = async (success: boolean) => {
      const { error } = await admin.from("login_attempts").insert({
        employee_code: normalizedCode,
        success,
        ip_address: ipAddress,
        user_agent: userAgent,
      });
      if (error) console.error("staff-login: failed to record login_attempts row:", error.message);
    };

    // ---- Resolve employee_code -> internal auth email (service-role only) ----
    const { data: resolved, error: resolveError } = await admin.rpc("resolve_employee_login", {
      p_employee_code: normalizedCode,
    });

    if (resolveError) {
      console.error("staff-login: resolve_employee_login failed:", resolveError.message);
      await recordAttempt(false);
      return errorResponse(500, MSG.serverError, origin);
    }

    const row: ResolvedLogin | undefined = Array.isArray(resolved) ? resolved[0] : resolved;

    if (!row || !row.auth_user_id || !row.auth_email) {
      // Unknown employee code — same generic message as wrong password.
      await recordAttempt(false);
      return errorResponse(401, MSG.invalidLogin, origin);
    }
    if (!row.is_active) {
      // Inactive account — same generic message, no distinct signal to the client.
      await recordAttempt(false);
      return errorResponse(401, MSG.invalidLogin, origin);
    }

    // ---- Authenticate with the internally resolved email ----
    const anon = anonClient();
    const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
      email: row.auth_email,
      password,
    });

    if (signInError || !signInData?.session) {
      await recordAttempt(false);
      return errorResponse(401, MSG.invalidLogin, origin);
    }

    await recordAttempt(true);

    return okResponse(
      {
        access_token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token,
        expires_in: signInData.session.expires_in,
        must_change_password: !!row.must_change_password,
      },
      origin,
    );
  } catch (err) {
    console.error("staff-login: unexpected error:", err instanceof Error ? err.message : String(err));
    return errorResponse(500, MSG.serverError, origin);
  }
});
