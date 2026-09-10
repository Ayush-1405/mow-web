// Mood of Wood — Node API — audit log writer.
//
// Ported from staff_write_audit(p_entity_type, p_entity_id, p_action,
// p_old_value, p_new_value, p_department_id, p_remarks). The Postgres
// version is revoked from every client role and callable only from inside
// other SECURITY DEFINER functions — this Node equivalent must follow the
// same rule: never exposed as its own endpoint, only ever called from
// inside another endpoint's handler after a successful write, always with
// performed_by set to the server-verified caller id, never anything from
// the request body.

export async function writeAudit(admin, { entityType, entityId, action, oldValue = null, newValue = null, departmentId = null, remarks = null, performedBy }) {
  const { error } = await admin.from("staff_audit_log").insert({
    entity_type: entityType,
    entity_id: entityId,
    action,
    old_value: oldValue,
    new_value: newValue,
    department_id: departmentId,
    remarks,
    performed_by: performedBy,
  });
  if (error) {
    console.error(`writeAudit: insert failed for action=${action} entity_type=${entityType}:`, error.message);
    throw error;
  }
}
