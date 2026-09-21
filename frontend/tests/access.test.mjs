// Unit tests for the centralized permission layer (src/lib/access.js). Run: npm test   (Node's built-in test runner, no extra deps)
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRoleCode, getRoleFamily, getUserPermissions, withPermissions, canAccessDepartment, getAccessibleDepartments, GLOBAL_OVERSIGHT_ROLES,
} from "../src/lib/access.js";

// capabilities exactly as seeded by migration v2_90a
const CAPS = {
  management: { can_view_restricted_finance: true, can_view_payroll: false, can_view_sensitive_hr: false, can_manage_users: true, can_view_all_operational_chats: true,
    can_delete_records: true, can_restore_records: false, can_export_data: true, can_assign: true, can_approve: true, can_change_status: true, can_edit_records: true, can_comment: true },
  sysadmin: { can_view_restricted_finance: true, can_view_payroll: false, can_view_sensitive_hr: false, can_manage_users: true, can_view_all_operational_chats: true,
    can_delete_records: true, can_restore_records: true, can_export_data: true, can_assign: true, can_approve: true, can_change_status: true, can_edit_records: true, can_comment: true },
  dept_head: { can_view_restricted_finance: false, can_view_payroll: false, can_view_sensitive_hr: false, can_manage_users: false, can_view_all_operational_chats: false,
    can_delete_records: false, can_export_data: true, can_assign: true, can_approve: true, can_change_status: true, can_edit_records: true, can_comment: true },
  employee: { can_view_restricted_finance: false, can_comment: true },
  accounts_head: { can_view_restricted_finance: true, can_comment: true },
};
const user = (roleCode, extra = {}) => withPermissions({ id: "u1", roleCode, is_active: true, department_id: "d-mkt", ...extra }, CAPS[roleCode] ?? {});

const DEPTS = [
  { id: "d-fac", code: "FACTORY", department_group_id: null, parent_department_id: null },
  { id: "d-int", code: "INTERIOR", department_group_id: null, parent_department_id: null },
  { id: "d-ret", code: "RETAIL", department_group_id: "g1", parent_department_id: null },
  { id: "d-fr", code: "FRANCHISE", department_group_id: "g1", parent_department_id: null },
  { id: "d-cs", code: "CUSTOMER_SERVICE", department_group_id: null, parent_department_id: "d-ret" },
  { id: "d-acc", code: "ACCOUNTS", is_confidential_domain: true },
  { id: "d-ct", code: "CONTROL_TOWER", is_control_tower: true },
];

test("role normalisation handles case, spaces, slashes, hyphens", () => {
  assert.equal(normalizeRoleCode("Management / Director"), "management_director");
  assert.equal(normalizeRoleCode("  Managing-Director "), "managing_director");
  assert.equal(normalizeRoleCode(null), "");
});

test("every Director / Management alias is recognised as global oversight", () => {
  for (const v of ["Director", "Management", "Management / Director", "Managing Director", "CEO", "Super Admin", "sysadmin", "Central Tower", "central-tower", "Management Control Tower"]) {
    assert.notEqual(getRoleFamily(v), null, v);
  }
  assert.ok(GLOBAL_OVERSIGHT_ROLES.includes("director") && GLOBAL_OVERSIGHT_ROLES.includes("super_admin"));
});

test("scope roles are NOT global (dept head, supervisor, employee, accounts, unknown)", () => {
  for (const v of ["dept_head", "Department Head", "supervisor", "employee", "accounts_head", "cfo", "", null, undefined, "directorate"]) {
    assert.equal(getRoleFamily(v), null, String(v));
  }
});

test("Director sees all departments, tasks, bridges, projects, job cards, reports", () => {
  const p = user("management").permissions;
  for (const k of ["canViewAllDepartments", "canViewAllTasks", "canViewAllBridges", "canViewAllProjects", "canViewAllJobCards", "canViewAllReports", "canViewAllOperationalData", "canViewAllOperationalChats"]) {
    assert.equal(p[k], true, k);
  }
  assert.equal(p.taskScope, "all");
  assert.equal(p.showManagementBadge, true);
});

test("Director can open every department (Control Tower included); Finance follows the restricted-finance capability", () => {
  const m = user("management");
  assert.equal(getAccessibleDepartments(m, DEPTS).length, DEPTS.length);
  const noFinance = withPermissions({ id: "u2", roleCode: "management", is_active: true }, { ...CAPS.management, can_view_restricted_finance: false });
  assert.equal(canAccessDepartment(noFinance, DEPTS, DEPTS.find((d) => d.code === "ACCOUNTS")), false);
  assert.equal(canAccessDepartment(noFinance, DEPTS, DEPTS.find((d) => d.code === "FACTORY")), true);
  assert.equal(canAccessDepartment(noFinance, DEPTS, DEPTS.find((d) => d.code === "CONTROL_TOWER")), true);
});

test("Department Head keeps department / group / child scope, never other departments, Control Tower or Finance", () => {
  const head = user("dept_head", { department_id: "d-ret" });
  const ok = getAccessibleDepartments(head, DEPTS).map((d) => d.code).sort();
  assert.deepEqual(ok, ["CUSTOMER_SERVICE", "FRANCHISE", "RETAIL"]);
  assert.equal(head.permissions.canViewAllTasks, false);
  assert.equal(head.permissions.taskScope, "department");
  assert.equal(head.permissions.canViewAllBridges, false);
});

test("Factory Head cannot open Interior; Interior employee cannot open Factory", () => {
  const fh = user("dept_head", { department_id: "d-fac" });
  assert.equal(canAccessDepartment(fh, DEPTS, DEPTS.find((d) => d.code === "INTERIOR")), false);
  const emp = user("employee", { department_id: "d-int" });
  assert.equal(canAccessDepartment(emp, DEPTS, DEPTS.find((d) => d.code === "FACTORY")), false);
  assert.equal(canAccessDepartment(emp, DEPTS, DEPTS.find((d) => d.code === "INTERIOR")), true);
  assert.equal(emp.permissions.taskScope, "own");
});

test("normal employee has no global visibility, no leadership screens, no sensitive capabilities", () => {
  const p = user("employee").permissions;
  assert.equal(p.hasGlobalOversight, false);
  assert.equal(p.canViewLeadershipScreens, false);
  assert.equal(p.canViewRestrictedFinance, false);
  assert.equal(p.canDelete, false);
  assert.equal(p.canManageUsers, false);
});

test("global visibility never implies payroll / sensitive HR; sensitive capabilities are separate", () => {
  const p = user("management").permissions;
  assert.equal(p.canViewPayroll, false);
  assert.equal(p.canViewSensitiveHR, false);
  assert.equal(p.canViewRestrictedFinance, true);   // seeded, but a separate revocable capability
  const revoked = withPermissions({ id: "u", roleCode: "management", is_active: true }, { can_view_restricted_finance: false }).permissions;
  assert.equal(revoked.canViewRestrictedFinance, false);
  assert.equal(revoked.canViewAllTasks, true);
});

test("capabilities fail CLOSED when the server list is missing, visibility still works", () => {
  const p = withPermissions({ id: "u", roleCode: "management", is_active: true }, null).permissions;
  assert.equal(p.canViewAllTasks, true);
  assert.equal(p.canViewRestrictedFinance, false);
  assert.equal(p.canDelete, false);
  assert.equal(p.canManageUsers, false);
  assert.equal(p.canViewAllOperationalChats, false);
});

test("inactive management user has no permissions at all", () => {
  const p = withPermissions({ id: "u", roleCode: "management", is_active: false }, CAPS.management).permissions;
  assert.equal(p.hasGlobalOversight, false);
  assert.equal(p.canViewAllTasks, false);
  assert.equal(p.canDelete, false);
  assert.equal(p.taskScope, "own");
});

test("action permissions are separate: management may delete, department head may not; only Super Admin restores", () => {
  assert.equal(user("management").permissions.canDelete, true);
  assert.equal(user("management").permissions.canRestore, false);
  assert.equal(user("sysadmin").permissions.canRestore, true);
  assert.equal(user("dept_head").permissions.canDelete, false);
  assert.equal(user("dept_head").permissions.canAssign, true);
});

test("legacy flags stay in step with the family map", () => {
  assert.equal(user("management").isManagement, true);
  assert.equal(user("management").isSuperAdmin, false);
  assert.equal(user("sysadmin").isSuperAdmin, true);
  assert.equal(user("sysadmin").isManagement, false);
  assert.equal(user("sysadmin").isDeptHead, true);   // unchanged: sysadmin has always counted as "leadership"
  assert.equal(user("accounts_head").isDeptHead, true);
  assert.equal(user("employee").isDeptHead, false);
});

test("legacy role strings map to the same permissions as the canonical code", () => {
  for (const alias of ["Director", "Management / Director", "Managing Director", "CEO"]) {
    const p = withPermissions({ id: "u", roleCode: alias, is_active: true }, CAPS.management).permissions;
    assert.equal(p.isManagementUser, true, alias);
    assert.equal(p.canViewAllBridges, true, alias);
  }
});
