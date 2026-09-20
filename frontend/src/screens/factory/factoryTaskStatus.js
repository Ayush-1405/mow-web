// Task statuses come from the existing task engine (status_master); this is
// only how they are worded for Factory people.
//   pending_acceptance = ASSIGNED / RETURNED / REOPENED   ready_for_review = COMPLETED
//   blocked / waiting  = ON_HOLD                          completed = VERIFIED / CLOSED
export const TASK_STATUS = {
  ASSIGNED: { en: "Pending Acceptance", gu: "સ્વીકાર બાકી", badge: "ASSIGNED" },
  REOPENED: { en: "Reopened", gu: "ફરી ખોલ્યું", badge: "REVISION" },
  RETURNED: { en: "Rejected / Returned", gu: "પરત / અસ્વીકાર", badge: "RETURNED" },
  PARTIALLY_ACCEPTED: { en: "Partly Accepted", gu: "આંશિક સ્વીકાર", badge: "ACCEPTED" },
  ACCEPTED: { en: "Accepted", gu: "સ્વીકાર્યું", badge: "ACCEPTED" },
  IN_PROGRESS: { en: "In Progress", gu: "ચાલુ", badge: "IN_PROGRESS" },
  PARTIALLY_COMPLETED: { en: "Partly Done", gu: "આંશિક પૂર્ણ", badge: "IN_PROGRESS" },
  ON_HOLD: { en: "Blocked", gu: "અટકેલું", badge: "REVISION" },
  COMPLETED: { en: "Ready for Review", gu: "સમીક્ષા માટે તૈયાર", badge: "COMPLETED" },
  VERIFIED: { en: "Completed", gu: "પૂર્ણ", badge: "VERIFIED" },
  CLOSED: { en: "Completed", gu: "પૂર્ણ", badge: "VERIFIED" },
};
export const TASK_DONE = new Set(["VERIFIED", "CLOSED"]);
export const TASK_NEEDS_ACCEPT = new Set(["ASSIGNED", "RETURNED", "REOPENED"]);
export const PRIORITY_LABEL = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };

// Job Card progress: real counts only. There are no per-task weights, so a
// percentage would be invented -- show "done / total tasks" instead.
export function progressText(p) {
  if (!p || !p.total) return "No tasks yet";
  return `${p.done} / ${p.total} tasks done`;
}
