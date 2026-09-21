import { useMemo } from "react";

// Mood of Wood — Staff Pilot — the ONE place the browser decides what a user may see or do.
//
// IMPORTANT: this module decides what renders. It is NOT the security boundary. The real boundary is Postgres RLS and the SECURITY DEFINER
// RPCs, which identify the caller with auth.uid() and never trust anything sent from here. The database mirrors this file through
// staff_role_family() / staff_has_global_oversight() / staff_has_capability() (migrations v2_90a/b); if the two ever disagree the database
// wins, the UI just shows a link that then returns nothing. Do NOT scatter `profile.roleCode === "management"` style checks in screens:
// read `profile.permissions` (built once in App.loadProfile with getUserPermissions) instead.
//
// Three layers, kept separate on purpose:
//   1. ROLE FAMILY   – Director / Management / Super Admin ("global oversight") => organization-wide OPERATIONAL visibility.
//   2. SCOPE ROLES   – Department Head / Supervisor / Accounts => their own department / team (unchanged from before).
//   3. CAPABILITIES  – explicit grants from the server (role_permissions): restricted finance, payroll, sensitive HR, manage users,
//                      delete / restore / export / assign / approve ... Global visibility never implies these.

// --- role normalisation (mirror of staff_norm_role / staff_role_family in the database) ----------------------------------------------
export function normalizeRoleCode(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

const MANAGEMENT_FAMILY = new Set([
  "management", "director", "management_director", "managing_director", "ceo", "central_tower", "management_control_tower", "control_tower",
]);
const SUPER_ADMIN_FAMILY = new Set(["sysadmin", "super_admin", "system_administrator"]);

// Every normalized code that grants organization-wide operational visibility (exported for tests / documentation).
export const GLOBAL_OVERSIGHT_ROLES = Object.freeze([...MANAGEMENT_FAMILY, ...SUPER_ADMIN_FAMILY]);

// "management" | "super_admin" | null. Accepts any casing / spacing / slash / hyphen variant ("Management / Director", "Managing-Director").
export function getRoleFamily(roleCode) {
  const code = normalizeRoleCode(roleCode);
  if (MANAGEMENT_FAMILY.has(code)) return "management";
  if (SUPER_ADMIN_FAMILY.has(code)) return "super_admin";
  return null;
}

export const isManagementRole = (roleCode) => getRoleFamily(roleCode) !== null;

// Roles that the app has always treated as "leadership" for screen entry (Users / Dashboard / Audit log tabs).
const LEADERSHIP_ROLES = new Set(["dept_head", "accounts_head", "cfo", "sysadmin", "super_admin"]);
export const isLeadershipRole = (roleCode) => LEADERSHIP_ROLES.has(normalizeRoleCode(roleCode));

// Capability keys (server-side role_permissions.permission_key).
export const CAP = Object.freeze({
  restrictedFinance: "can_view_restricted_finance",
  payroll: "can_view_payroll",
  sensitiveHR: "can_view_sensitive_hr",
  manageUsers: "can_manage_users",
  operationalChats: "can_view_all_operational_chats",
  delete: "can_delete_records",
  restore: "can_restore_records",
  export: "can_export_data",
  assign: "can_assign",
  approve: "can_approve",
  changeStatus: "can_change_status",
  edit: "can_edit_records",
  comment: "can_comment",
});

const NONE = Object.freeze({});

// Build the permission set for a loaded profile. `profile.capabilities` is the server's answer (staff_my_capabilities()); when it is
// missing (RPC failed) every capability is FALSE -- sensitive things fail closed -- while plain role-based visibility still works.
export function getUserPermissions(profile) {
  const active = !!profile && profile.is_active !== false;
  const roleCode = normalizeRoleCode(profile?.roleCode);
  const family = active ? getRoleFamily(roleCode) : null;
  const global = family !== null;
  const caps = (active && profile?.capabilities) || NONE;
  const cap = (key) => active && caps[key] === true;
  const isDepartmentHead = active && roleCode === "dept_head";
  const isSupervisor = active && roleCode === "supervisor";
  const isLeadership = active && isLeadershipRole(roleCode);

  return Object.freeze({
    family,
    isManagementUser: family === "management",
    isSuperAdmin: family === "super_admin",
    hasGlobalOversight: global,
    isDepartmentHead,
    isSupervisor,
    isLeadership,
    // Which slice of the organization this user's task/bridge lists cover.
    taskScope: global ? "all" : (isDepartmentHead || isSupervisor || isLeadership) ? "department" : "own",

    // ---- operational visibility (organization-wide for Director / Management / Super Admin) -------------------------------------------
    canViewAllOperationalData: global,
    canViewAllDepartments: global,
    canViewAllTasks: global,
    canViewAllBridges: global,
    canViewAllProjects: global,
    canViewAllJobCards: global,
    canViewAllReports: global,
    canViewAuditLog: global || isLeadership,
    canLead: global || isLeadership,                    // Director/Management/Super Admin + Dept Head/Accounts leadership
    canViewLeadershipScreens: global || isLeadership,   // Users / Dashboard / Audit log tabs
    // Chat oversight is a separate, capability-checked, audited, view-only grant (never implies membership / notifications).
    canViewAllOperationalChats: global && cap(CAP.operationalChats),

    // ---- sensitive data: separate explicit capabilities, never implied by visibility ------------------------------------------------
    canViewRestrictedFinance: cap(CAP.restrictedFinance),
    canViewPayroll: cap(CAP.payroll),
    canViewSensitiveHR: cap(CAP.sensitiveHR),
    canManageUsers: cap(CAP.manageUsers),
    canResetPasswords: cap(CAP.manageUsers) || isDepartmentHead || isLeadership,

    // ---- actions ---------------------------------------------------------------------------------------------------------------------
    canComment: cap(CAP.comment),
    canAssign: cap(CAP.assign),
    canApprove: cap(CAP.approve),
    canChangeStatus: cap(CAP.changeStatus),
    canEdit: cap(CAP.edit),
    canDelete: cap(CAP.delete),
    canRestore: cap(CAP.restore),
    canExport: cap(CAP.export),

    // UI hint only.
    showManagementBadge: global,
    managementBadgeLabel: "Management View — All Departments",
  });
}

// Keep the legacy flags in step with the family map so older call sites (profile.isManagement / isSuperAdmin) stay correct.
export function withPermissions(profile, capabilities) {
  const base = { ...profile, capabilities: capabilities || null };
  const permissions = getUserPermissions(base);
  return {
    ...base,
    permissions,
    isManagement: permissions.isManagementUser,
    isSuperAdmin: permissions.isSuperAdmin,
    isDeptHead: permissions.isLeadership,
  };
}

// --- department access -----------------------------------------------------------------------------------------------------------------
function findDepartment(departments, id) {
  return (departments || []).find((d) => d.id === id) || null;
}

export function canAccessManagement(profile) {
  return (profile?.permissions ?? getUserPermissions(profile)).hasGlobalOversight;
}

// Mirror of public.can_view_department(): global oversight sees every department (the Control Tower included) EXCEPT confidential
// domains (Accounts/Finance), which need the restricted-finance capability. Everyone else: their own department, plus -- for a
// dept_head only -- sibling departments in the same group and child departments; never the Control Tower.
export function canAccessDepartment(profile, departments, dept) {
  if (!profile || !dept) return false;
  const perms = profile.permissions ?? getUserPermissions(profile);
  if (dept.is_confidential_domain && !perms.canViewRestrictedFinance) return false;
  if (perms.hasGlobalOversight) return true;
  if (dept.is_control_tower) return false;

  if (dept.id === profile.department_id) return true;

  if (perms.isDepartmentHead && !dept.is_confidential_domain) {
    const ownDept = findDepartment(departments, profile.department_id);
    if (!ownDept) return false;
    if (ownDept.department_group_id && dept.department_group_id === ownDept.department_group_id) return true;
    if (dept.parent_department_id === ownDept.id) return true;
  }
  return false;
}

export function canAccessFinance(profile, departments) {
  const accounts = (departments || []).find((d) => d.code === "ACCOUNTS");
  if (!accounts) return false;
  return canAccessDepartment(profile, departments, accounts);
}

export function getAccessibleDepartments(profile, departments) {
  return (departments || []).filter((d) => canAccessDepartment(profile, departments, d));
}

// Reusable permission hook. `profile` is the already-loaded profile (App.loadProfile attaches `permissions`); `departments` the
// already-loaded lookup list -- no extra network round-trip.
export function useCurrentUserAccess(profile, departments) {
  return useMemo(() => {
    const list = departments || [];
    const permissions = profile?.permissions ?? getUserPermissions(profile);
    const accessibleDepartments = getAccessibleDepartments(profile, list);
    return {
      permissions,
      isManagement: permissions.hasGlobalOversight,
      canAccessManagement: () => permissions.hasGlobalOversight,
      canAccessFinance: () => canAccessFinance(profile, list),
      canAccessDepartment: (dept) => canAccessDepartment(profile, list, dept),
      canAccessDepartmentCode: (code) => canAccessDepartment(profile, list, list.find((d) => d.code === code)),
      getAccessibleDepartments: () => accessibleDepartments,
      accessibleDepartments,
    };
  }, [profile, departments]);
}
