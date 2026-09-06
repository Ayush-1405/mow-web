// Mood of Wood — Node API — caller verification + role/HOD-scope helpers.
//
// Ported from the live Postgres functions staff_assert_operational(),
// staff_current_role_code(), staff_current_department_id(),
// staff_is_management(), staff_is_dept_head(), staff_is_accounts_head(),
// staff_dept_in_hod_scope(), and staff_user_dept_in_hod_scope() (source
// fetched directly from the live database, not guessed). Every endpoint
// that needs to know "who is calling, and what can they do" should use
// requireCaller() rather than re-deriving this.

import { adminClient, extractBearerToken, verifyCaller } from "./supabaseClients.js";
import { MSG } from "./messages.js";
import { sendError } from "./response.js";

/**
 * Verifies the bearer token, loads the caller's user_profiles row (joined
 * to their role code), and checks they're operational. On any failure,
 * sends the appropriate error response itself and returns null — callers
 * should do `const caller = await requireCaller(req, res); if (!caller) return;`.
 *
 * Set `requireOperational: false` for the one endpoint (password-change)
 * that must remain usable even while must_change_password is still true —
 * mirrors staff-password-change/index.ts's deliberate exemption from that
 * gate (it's how the flag gets cleared in the first place). is_active is
 * still always required; only the must_change_password check is skippable.
 */
export async function requireCaller(req, res, { requireOperational = true } = {}) {
  const token = extractBearerToken(req);
  if (!token) {
    sendError(res, 401, MSG.unauthorized);
    return null;
  }

  const verifiedUser = await verifyCaller(token);
  if (!verifiedUser) {
    sendError(res, 401, MSG.unauthorized);
    return null;
  }

  const admin = adminClient();
  const { data: profile, error } = await admin
    .from("user_profiles")
    .select("id, is_active, must_change_password, role_id, department_id, roles(code)")
    .eq("id", verifiedUser.id)
    .maybeSingle();

  if (error) {
    console.error("requireCaller: profile lookup failed:", error.message);
    sendError(res, 500, MSG.serverError);
    return null;
  }
  if (!profile || !profile.is_active) {
    sendError(res, 403, MSG.accountInactive);
    return null;
  }
  if (requireOperational && profile.must_change_password) {
    sendError(res, 403, MSG.mustChangePassword);
    return null;
  }

  const roleCode = Array.isArray(profile.roles) ? profile.roles[0]?.code : profile.roles?.code;
  if (!roleCode) {
    console.error("requireCaller: caller has no resolvable role code, user id:", verifiedUser.id);
    sendError(res, 500, MSG.serverError);
    return null;
  }

  return {
    user: verifiedUser,
    admin,
    id: profile.id,
    roleId: profile.role_id,
    departmentId: profile.department_id,
    roleCode,
    isActive: profile.is_active,
    mustChangePassword: profile.must_change_password,
  };
}

export function isManagement(caller) {
  return caller.roleCode === "management";
}

export function isDeptHead(caller) {
  return caller.roleCode === "dept_head";
}

export function isAccountsHead(caller) {
  return caller.roleCode === "accounts_head";
}

/**
 * Ported from staff_user_dept_in_hod_scope(p_user_id, p_department_id).
 * True if p_department_id is: the target user's own department, OR a
 * sibling department sharing the same non-null department_group_id
 * (shared-Head groups, e.g. Retail+Franchise), OR a department whose
 * parent_department_id points at the target user's own department (the
 * Customer-Service-under-Retail-Head oversight pattern). These are two
 * DIFFERENT, non-interchangeable relationships — do not collapse them.
 */
export async function userDeptInHodScope(admin, userId, departmentId) {
  const { data: userDept, error: userDeptError } = await admin
    .from("user_profiles")
    .select("department_id")
    .eq("id", userId)
    .maybeSingle();
  if (userDeptError) throw userDeptError;
  const ownDepartmentId = userDept?.department_id ?? null;
  if (!ownDepartmentId) return false;
  if (departmentId === ownDepartmentId) return true;

  const { data: ownDept, error: ownDeptError } = await admin
    .from("departments")
    .select("department_group_id")
    .eq("id", ownDepartmentId)
    .maybeSingle();
  if (ownDeptError) throw ownDeptError;

  const { data: targetDept, error: targetDeptError } = await admin
    .from("departments")
    .select("department_group_id, parent_department_id")
    .eq("id", departmentId)
    .maybeSingle();
  if (targetDeptError) throw targetDeptError;
  if (!targetDept) return false;

  if (ownDept?.department_group_id && targetDept.department_group_id === ownDept.department_group_id) {
    return true;
  }
  if (targetDept.parent_department_id === ownDepartmentId) {
    return true;
  }
  return false;
}

/** Ported from staff_dept_in_hod_scope(p_department_id) — the caller's own version of the check above. */
export async function deptInHodScope(caller, departmentId) {
  return userDeptInHodScope(caller.admin, caller.id, departmentId);
}
