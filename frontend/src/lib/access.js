import { useMemo } from "react";

// Mood of Wood — Staff Pilot — department/Control-Tower access.
//
// IMPORTANT: this module decides what renders in the browser. It is NOT the
// security boundary — it exists so the UI never even offers a link a user
// can't use, and never flashes a page before redirecting. The real boundary
// is Postgres RLS (staff_is_management(), staff_dept_in_hod_scope(), the
// confidential-domain checks on staff_tasks/bridges, etc.), which already
// enforces the same rules server-side against every table read, regardless
// of what this file decides. See supabase/migrations for those policies.
//
// The logic below is a client-side mirror of the existing DB function
// staff_user_dept_in_hod_scope(): a user's own department, PLUS — for a
// dept_head only — every sibling department sharing their department's
// non-null department_group_id (e.g. Retail + Franchise/Dealer under one
// Retail Head), PLUS every department whose parent_department_id points at
// their own department (the Customer-Service-under-Retail-Head dual-access
// pattern). Management sees everything. The Management Control Tower
// (departments.is_control_tower) and any confidential domain
// (departments.is_confidential_domain, i.e. Accounts/Finance) are never
// reachable through the group/parent expansion — only through an exact
// department match or Management.

function findDepartment(departments, id) {
  return (departments || []).find((d) => d.id === id) || null;
}

export function canAccessManagement(profile) {
  return !!profile?.isManagement || !!profile?.isSuperAdmin;
}

// Super Admin (roleCode 'sysadmin') gets the same broad visibility as
// Management, with one deliberate exception this project's architecture
// doc calls out explicitly: confidential Finance data stays restricted to
// Management/CFO/Accounts Head unless separately, explicitly granted —
// System Admin never gets it as a side-effect of being an admin. Mirrors
// the RLS in mvp_pilot_super_admin_access_v2_2g.sql exactly: staff_is_
// super_admin() was added to every general-visibility branch there, never
// to a confidential-domain allow-list.
export function canAccessDepartment(profile, departments, dept) {
  if (!profile || !dept) return false;
  if (profile.isManagement) return true;
  if (profile.isSuperAdmin) return !dept.is_confidential_domain;
  if (dept.is_control_tower) return false; // Management/Super Admin-only, always

  if (dept.id === profile.department_id) return true;

  if (profile.roleCode === "dept_head" && !dept.is_confidential_domain) {
    const ownDept = findDepartment(departments, profile.department_id);
    if (!ownDept) return false;
    if (ownDept.department_group_id && dept.department_group_id === ownDept.department_group_id) {
      return true;
    }
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

// Reusable permission hook. `profile` is the already-loaded user_profiles
// row (with roleCode/isManagement, as set by App.jsx's loadProfile) and
// `departments` is the already-loaded departments lookup list — both come
// from the SAME boot-time reads every other screen already uses, so this
// hook adds no additional network round-trip of its own.
export function useCurrentUserAccess(profile, departments) {
  return useMemo(() => {
    const list = departments || [];
    const accessibleDepartments = getAccessibleDepartments(profile, list);
    return {
      isManagement: canAccessManagement(profile),
      canAccessManagement: () => canAccessManagement(profile),
      canAccessFinance: () => canAccessFinance(profile, list),
      canAccessDepartment: (dept) => canAccessDepartment(profile, list, dept),
      canAccessDepartmentCode: (code) => {
        const dept = list.find((d) => d.code === code);
        return canAccessDepartment(profile, list, dept);
      },
      getAccessibleDepartments: () => accessibleDepartments,
      accessibleDepartments,
    };
  }, [profile, departments]);
}
