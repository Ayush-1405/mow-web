// Shared helpers for the Retail Stores module screens. Kept tiny and
// dependency-free — currency formatting and a status->badge-class lookup
// that reuses the SAME .badge.* colors already defined in styles.css
// (IN_PROGRESS/COMPLETED/CLOSED/etc.) rather than inventing a new palette.
import { supabase } from "./supabase";

// Team members of a department, for the "Assign To" picker several Retail
// screens need at creation time (previously missing — a lead/complaint/VM
// task could be created but never assigned to anyone). Reads user_profiles
// directly, scoped by department_id, same RLS this app already relies on
// everywhere (user_profiles_select_hod_scope / _select_own) — a plain
// member's own row is the only one they'd get back if they aren't
// dept_head/supervisor/management, which is a harmless, expected empty
// picker rather than a broken one.
// Notifies a newly-assigned Retail team member (staff_notify_assignment —
// SECURITY DEFINER, since notifications has no direct INSERT grant). Fire-
// and-forget: a failed notification must never block the assignment save
// that already succeeded by the time this runs.
export async function notifyAssignment(recipientId, entityType, entityId, titleEn, titleGu) {
  if (!recipientId) return;
  try {
    await supabase.rpc("staff_notify_assignment", {
      p_recipient_id: recipientId, p_entity_type: entityType, p_entity_id: entityId, p_title_en: titleEn, p_title_gu: titleGu,
    });
  } catch {
    // intentional no-op — see comment above
  }
}

export async function fetchDepartmentMembers(departmentId) {
  if (!departmentId) return [];
  const { data, error } = await supabase
    .from("user_profiles")
    .select("id, full_name")
    .eq("department_id", departmentId)
    .eq("is_active", true)
    .order("full_name");
  return error ? [] : data || [];
}

export function formatCurrency(amount) {
  const n = Number(amount) || 0;
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

// Maps a Retail table's own status vocabulary onto the closest existing
// badge color class, so a screen never needs new CSS. Falls back to the
// literal code as both label and class if unmapped (renders as a plain
// grey-ish badge — see .badge base style — rather than crashing).
const STATUS_BADGE_MAP = {
  NEW: "ASSIGNED", FOLLOW_UP: "ASSIGNED", QUOTED: "ACCEPTED", CONVERTED: "VERIFIED", LOST: "RETURNED",
  DRAFT: "ASSIGNED", SENT: "ACCEPTED", ACCEPTED: "VERIFIED", REJECTED: "RETURNED", EXPIRED: "CLOSED",
  BOOKED: "ASSIGNED", CONFIRMED: "ACCEPTED", IN_PRODUCTION: "IN_PROGRESS", READY: "COMPLETED",
  DELIVERED: "VERIFIED", CANCELLED: "RETURNED",
  PENDING: "ASSIGNED", PARTIAL: "IN_PROGRESS", PAID: "VERIFIED",
  DONE: "VERIFIED",
  OPEN: "ASSIGNED", IN_PROGRESS: "IN_PROGRESS", RESOLVED: "VERIFIED", CLOSED: "CLOSED",
};

export function statusBadgeClass(status) {
  return STATUS_BADGE_MAP[status] || status;
}
