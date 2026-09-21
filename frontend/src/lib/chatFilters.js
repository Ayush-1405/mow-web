// One project conversation, several VIEWS of the same timeline (never separate conversations).
export const VIEWS = [
  ["all", "All"], ["general", "General"], ["tasks", "Tasks"], ["jobs", "Job Cards"], ["daily", "Daily Updates"], ["files", "Files"],
];

// Does a message belong to the current view? Used for the database query AND for Realtime rows arriving while a view is open.
export function matchesView(m, view, taskId) {
  switch (view) {
    case "general": return !m.task_id && !m.job_card_id && !m.daily_update_id;
    case "tasks": return taskId ? m.task_id === taskId : !!m.task_id;
    case "jobs": return !!m.job_card_id;
    case "daily": return !!m.daily_update_id;
    case "files": return !!m.has_attachments || (m.attachments || []).length > 0;
    default: return true;
  }
}

// Same rule as matchesView, expressed as PostgREST filters (RLS still decides which rows the caller may see at all).
export function applyViewToQuery(q, view, taskId) {
  switch (view) {
    case "general": return q.is("task_id", null).is("job_card_id", null).is("daily_update_id", null);
    case "tasks": return taskId ? q.eq("task_id", taskId) : q.not("task_id", "is", null);
    case "jobs": return q.not("job_card_id", "is", null);
    case "daily": return q.not("daily_update_id", "is", null);
    case "files": return q.eq("has_attachments", true);
    default: return q;
  }
}
