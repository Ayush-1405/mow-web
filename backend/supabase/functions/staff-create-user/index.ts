// Mood of Wood — MVP Pilot — staff-create-user
//
// Authenticated endpoint. Creates a new pilot Auth user + user_profiles +
// user_location_access row, enforcing public.role_creation_rules and
// department/group scope server-side against the VERIFIED caller's own
// profile — never against anything the client claims about itself.
//
// Deploy with default JWT verification ON (do not pass --no-verify-jwt).
//
// Rollback: user_profiles.id -> auth.users(id) ON DELETE CASCADE, and
// user_location_access.user_id -> user_profiles(id) ON DELETE CASCADE (both
// confirmed against the live schema before writing this). So if ANY
// insert after Auth user creation fails — user_profiles, user_location_access,
// OR (as of v2.1b) the CREATE_USER staff_audit_log row — deleting the Auth
// user via admin.auth.admin.deleteUser() is sufficient to remove every
// partial row. A successful response is only ever returned once the audit
// row exists too: there is no path that leaves an orphan profile, an orphan
// location-access row, or a created-but-unaudited user.

import { handlePreflight } from "../_shared/cors.ts";
import { errorResponse, okResponse } from "../_shared/response.ts";
import { MSG } from "../_shared/messages.ts";
import { adminClient, extractBearerToken, verifyCaller } from "../_shared/clients.ts";
import {
  normalizeEmployeeCode,
  isValidEmployeeCode,
  isNonEmptyString,
  isOptionalString,
  isValidPassword,
  isUuid,
  isUuidArray,
} from "../_shared/validation.ts";

const INTERNAL_EMAIL_DOMAIN = Deno.env.get("STAFF_INTERNAL_EMAIL_DOMAIN") ?? "staff.moodofwood.internal";

// Roles that may hold Accounts-only visibility/creation rights, mirrored
// from the confidentiality carve-out in staff_create_task / staff_list_assignable_users.
const ACCOUNTS_ROLE_CODES = ["management", "cfo", "accounts_head", "accounts_employee"];

// v2.1b: roles that exist ONLY to operate inside the confidential Accounts
// department — never valid outside it.
const ACCOUNTS_ONLY_ROLE_CODES = ["cfo", "accounts_head", "accounts_employee"];

// v2.1b: until the Accounts RPC/RLS layer is patched to handle generic
// roles consistently inside a confidential domain, these three are blocked
// from being created INSIDE Accounts — Accounts staff must use one of
// ACCOUNTS_ONLY_ROLE_CODES instead.
const GENERIC_ROLES_BLOCKED_IN_ACCOUNTS = ["supervisor", "employee", "dept_head"];

// v2.1b: this pilot allows exactly one Management account, created once via
// staff_bootstrap_management — never through this endpoint. (sysadmin is
// handled by its own dedicated check above, kept separate for its own
// distinct message.)
const SINGLETON_ROLE_CODES = ["management"];

interface CallerProfile {
  id: string;
  is_active: boolean;
  must_change_password: boolean;
  role_id: string;
  department_id: string | null;
  roles: { code: string } | { code: string }[] | null;
}

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

  // ---- Load the VERIFIED caller's own profile + role. Never trust anything
  // about "who is calling" from the request body. ----
  const { data: callerProfile, error: callerError } = await admin
    .from("user_profiles")
    .select("id, is_active, must_change_password, role_id, department_id, roles(code)")
    .eq("id", verifiedUser.id)
    .maybeSingle<CallerProfile>();

  if (callerError) {
    console.error("staff-create-user: caller profile lookup failed:", callerError.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  if (!callerProfile || !callerProfile.is_active) {
    return errorResponse(403, MSG.accountInactive, origin);
  }
  if (callerProfile.must_change_password) {
    return errorResponse(403, MSG.mustChangePassword, origin);
  }

  const callerRoleCode = Array.isArray(callerProfile.roles)
    ? callerProfile.roles[0]?.code
    : callerProfile.roles?.code;
  if (!callerRoleCode) {
    console.error("staff-create-user: caller has no resolvable role code");
    return errorResponse(500, MSG.serverError, origin);
  }

  // ---- Parse + validate the request body ----
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

  const normalizedCode = normalizeEmployeeCode(payload.employee_code);
  const fullName = isNonEmptyString(payload.full_name, 200) ? (payload.full_name as string).trim() : null;
  const phone = isOptionalString(payload.phone, 30) ? ((payload.phone as string | undefined)?.trim() || null) : undefined;
  const roleCode = isNonEmptyString(payload.role_code, 40) ? (payload.role_code as string).trim() : null;
  const departmentId = isUuid(payload.department_id) ? (payload.department_id as string) : null;
  const homeLocationId = isUuid(payload.home_location_id) ? (payload.home_location_id as string) : null;
  const extraLocationIds = payload.location_ids === undefined ? [] : payload.location_ids;
  const temporaryPassword = payload.temporary_password;

  if (
    !normalizedCode ||
    !fullName ||
    !roleCode ||
    !departmentId ||
    !homeLocationId ||
    phone === undefined ||
    !isUuidArray(extraLocationIds)
  ) {
    return errorResponse(400, MSG.missingFields, origin);
  }
  // v2.1b: strict employee_code shape, checked BEFORE normalizedCode is used
  // in the ilike duplicate check or interpolated into the internal email.
  if (!isValidEmployeeCode(normalizedCode)) {
    return errorResponse(400, MSG.invalidEmployeeCodeFormat, origin);
  }
  if (!isValidPassword(temporaryPassword)) {
    return errorResponse(400, MSG.weakPassword, origin);
  }

  // ---- Pilot rule: System Admin creation/approval workflow is disabled,
  // and only one Management account is permitted (created via
  // staff_bootstrap_management, not this endpoint) ----
  if (roleCode === "sysadmin") {
    return errorResponse(403, MSG.sysadminDisabled, origin);
  }
  if (SINGLETON_ROLE_CODES.includes(roleCode)) {
    return errorResponse(403, MSG.managementDisabled, origin);
  }

  // ---- Target role must exist and be active ----
  const { data: targetRole, error: targetRoleError } = await admin
    .from("roles")
    .select("id, code, name_en, name_gu, is_active")
    .eq("code", roleCode)
    .maybeSingle();

  if (targetRoleError) {
    console.error("staff-create-user: role lookup failed:", targetRoleError.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  if (!targetRole || !targetRole.is_active) {
    return errorResponse(400, MSG.invalidRole, origin);
  }

  // ---- role_creation_rules: is this creator role allowed to create this target role at all? ----
  const { data: rule, error: ruleError } = await admin
    .from("role_creation_rules")
    .select("id, scope, requires_management_approval, is_active")
    .eq("creator_role_id", callerProfile.role_id)
    .eq("creatable_role_id", targetRole.id)
    .eq("is_active", true)
    .maybeSingle();

  if (ruleError) {
    console.error("staff-create-user: role_creation_rules lookup failed:", ruleError.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  if (!rule) {
    return errorResponse(403, MSG.roleNotPermitted, origin);
  }
  // Any rule requiring Management approval maps to a workflow this pilot
  // does not implement yet (in this dataset: sysadmin as creator, in every
  // case) — reject rather than silently skip the approval step.
  if (rule.requires_management_approval) {
    return errorResponse(403, MSG.approvalNotAvailable, origin);
  }

  // ---- Target department must exist and be active ----
  const { data: targetDept, error: targetDeptError } = await admin
    .from("departments")
    .select("id, name_en, name_gu, department_group_id, parent_department_id, is_confidential_domain, is_active")
    .eq("id", departmentId)
    .maybeSingle();

  if (targetDeptError) {
    console.error("staff-create-user: department lookup failed:", targetDeptError.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  if (!targetDept || !targetDept.is_active) {
    return errorResponse(400, MSG.invalidDepartment, origin);
  }

  // ---- Confidential-department guard (defense in depth, mirrors staff_create_task) ----
  if (targetDept.is_confidential_domain && !ACCOUNTS_ROLE_CODES.includes(callerRoleCode)) {
    return errorResponse(403, MSG.confidentialRestricted, origin);
  }

  // ---- v2.1b: target ROLE vs target DEPARTMENT consistency ----
  // Accounts-specific roles only make sense inside the confidential Accounts
  // department; reject them everywhere else, regardless of who's asking.
  if (ACCOUNTS_ONLY_ROLE_CODES.includes(targetRole.code) && !targetDept.is_confidential_domain) {
    return errorResponse(403, MSG.accountsRoleRequiresAccountsDept, origin);
  }
  // Until the Accounts RPC/RLS layer is patched to handle generic roles
  // consistently inside a confidential domain, block them from being
  // created THERE — Accounts staff must be accounts_employee/accounts_head/cfo.
  if (GENERIC_ROLES_BLOCKED_IN_ACCOUNTS.includes(targetRole.code) && targetDept.is_confidential_domain) {
    return errorResponse(403, MSG.genericRoleBlockedInAccounts, origin);
  }

  // ---- Scope check per role_creation_rules.scope ----
  if (rule.scope === "own_department") {
    if (targetDept.id !== callerProfile.department_id) {
      return errorResponse(403, MSG.outsideScope, origin);
    }
  } else if (rule.scope === "own_department_group") {
    // v2.1b: explicitly three allowed cases — (a) caller's own department,
    // (b) same non-null department group, (c) a department whose
    // parent_department_id is the caller's own department (the
    // Customer-Service-under-Retail-Head pattern). The previous version only
    // checked (b) and (c) — a caller whose OWN department has no
    // department_group_id set would incorrectly fail scope for THEIR OWN
    // department, since a department is never its own "child" either.
    const isExactOwnDepartment = targetDept.id === callerProfile.department_id;

    let sameNonNullGroup = false;
    if (!isExactOwnDepartment) {
      const { data: callerDept, error: callerDeptError } = await admin
        .from("departments")
        .select("department_group_id")
        .eq("id", callerProfile.department_id ?? "")
        .maybeSingle();
      if (callerDeptError) {
        console.error("staff-create-user: caller department lookup failed:", callerDeptError.message);
        return errorResponse(500, MSG.serverError, origin);
      }
      sameNonNullGroup =
        !!callerDept?.department_group_id && targetDept.department_group_id === callerDept.department_group_id;
    }

    const isDirectChildOfCaller = targetDept.parent_department_id === callerProfile.department_id;

    if (!isExactOwnDepartment && !sameNonNullGroup && !isDirectChildOfCaller) {
      return errorResponse(403, MSG.outsideScope, origin);
    }
  } else if (rule.scope === "any_department") {
    // No further scope restriction beyond the confidentiality guard above.
  } else {
    console.error("staff-create-user: unrecognized role_creation_rules.scope:", rule.scope);
    return errorResponse(403, MSG.notAuthorized, origin);
  }

  // ---- Validate home_location_id + any extra location_ids ----
  const allLocationIds = Array.from(new Set([homeLocationId, ...extraLocationIds]));
  const { data: activeLocations, error: locationsError } = await admin
    .from("locations")
    .select("id")
    .in("id", allLocationIds)
    .eq("is_active", true);

  if (locationsError) {
    console.error("staff-create-user: location validation failed:", locationsError.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  if (!activeLocations || activeLocations.length !== allLocationIds.length) {
    return errorResponse(400, MSG.invalidLocation, origin);
  }

  // ---- employee_code must not already be assigned (case-insensitive) ----
  const { data: existing, error: existingError } = await admin
    .from("user_profiles")
    .select("id")
    .ilike("employee_code", normalizedCode)
    .maybeSingle();

  if (existingError) {
    console.error("staff-create-user: duplicate employee_code check failed:", existingError.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  if (existing) {
    return errorResponse(409, MSG.duplicateEmployeeCode, origin);
  }

  // ---- Create the Auth user with a synthetic internal email, never shown in the UI ----
  const internalEmail = `${normalizedCode.toLowerCase()}@${INTERNAL_EMAIL_DOMAIN}`;

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: internalEmail,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: { employee_code: normalizedCode },
  });

  if (createError || !created?.user) {
    const msg = createError?.message ?? "";
    console.error("staff-create-user: Auth user creation failed:", msg);
    if (/already.*registered|already exists/i.test(msg)) {
      return errorResponse(409, MSG.duplicateEmployeeCode, origin);
    }
    return errorResponse(500, MSG.serverError, origin);
  }

  const newUserId = created.user.id;

  const cleanupOrphanAuthUser = async (reason: string) => {
    console.error(`staff-create-user: rolling back Auth user ${newUserId} — ${reason}`);
    const { error: deleteError } = await admin.auth.admin.deleteUser(newUserId);
    if (deleteError) {
      console.error(`staff-create-user: CRITICAL — failed to roll back orphan Auth user ${newUserId}:`, deleteError.message);
    }
  };

  // ---- Insert user_profiles ----
  const { error: profileInsertError } = await admin.from("user_profiles").insert({
    id: newUserId,
    employee_code: normalizedCode,
    full_name: fullName,
    phone: phone,
    role_id: targetRole.id,
    department_id: targetDept.id,
    home_location_id: homeLocationId,
    must_change_password: true,
    is_active: true,
    created_by: verifiedUser.id,
  });

  if (profileInsertError) {
    await cleanupOrphanAuthUser(`user_profiles insert failed: ${profileInsertError.message}`);
    if (profileInsertError.code === "23505") {
      return errorResponse(409, MSG.duplicateEmployeeCode, origin);
    }
    return errorResponse(500, MSG.serverError, origin);
  }

  // ---- Insert user_location_access rows ----
  const locationRows = allLocationIds.map((locId) => ({
    user_id: newUserId,
    location_id: locId,
    access_type: locId === homeLocationId ? "primary" : "secondary",
    granted_by: verifiedUser.id,
  }));

  const { error: locationInsertError } = await admin.from("user_location_access").insert(locationRows);

  if (locationInsertError) {
    // ON DELETE CASCADE from auth.users -> user_profiles -> user_location_access
    // means deleting the Auth user is sufficient to unwind everything above too.
    await cleanupOrphanAuthUser(`user_location_access insert failed: ${locationInsertError.message}`);
    return errorResponse(500, MSG.serverError, origin);
  }

  // ---- Trusted audit entry. staff_write_audit() itself is EXECUTE-granted
  // only to `postgres` (internal-only helper called by other definer
  // functions) — it cannot be invoked directly from here, by design. This
  // Edge Function instead inserts directly with the service-role client,
  // which bypasses RLS the same way the user_profiles/user_location_access
  // inserts above do; "trusted" here means performed_by is always the
  // server-verified caller id, never anything from the request body. ----
  const { error: auditError } = await admin.from("staff_audit_log").insert({
    entity_type: "user_profiles",
    entity_id: newUserId,
    action: "CREATE_USER",
    old_value: null,
    new_value: {
      employee_code: normalizedCode,
      full_name: fullName,
      role_code: targetRole.code,
      department_id: targetDept.id,
    },
    department_id: targetDept.id,
    performed_by: verifiedUser.id,
  });

  if (auditError) {
    // v2.1b: a successful user creation must always have exactly one audit
    // entry — this is no longer treated as a non-fatal, log-and-continue
    // condition. Roll back the whole creation (cascade removes the profile
    // and location-access rows) and report a server error instead of a
    // silently under-audited account.
    await cleanupOrphanAuthUser(`staff_audit_log insert failed: ${auditError.message}`);
    return errorResponse(500, MSG.serverError, origin);
  }

  return okResponse(
    {
      id: newUserId,
      employee_code: normalizedCode,
      full_name: fullName,
      role: { code: targetRole.code, label_en: targetRole.name_en, label_gu: targetRole.name_gu },
      department: { id: targetDept.id, label_en: targetDept.name_en, label_gu: targetDept.name_gu },
    },
    origin,
    201,
  );
});
