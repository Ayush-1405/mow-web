// entity_type -> where opening a notification lands. Shared by the Notifications list, the in-app popup and (mirrored in SQL by
// public.notification_deep_link) the push that wakes the service worker, so a tap always opens the thing the notification is about.
export function routeFor(n) {
  switch (n.entity_type) {
    case "task": return `/tasks?focus=${n.entity_id}`;
    // A legacy Reply notification: Replies now live in Chat, so it resolves to the migrated message (server-checked access)
    case "task_message": return n.task_id ? `/chat?legacy_message=${n.entity_id}&legacy_task=${n.task_id}` : `/chat?legacy_message=${n.entity_id}`;
    case "project": return `/interior-projects/detail/${n.entity_id}`;
    case "snag": return "/interior-projects/site-execution";
    case "interior_task": return "/interior-projects/tasks";
    case "site_report": return "/interior-projects/daily-updates";
    case "retail_lead": return "/retail/leads";
    case "retail_complaint": return "/retail/complaints";
    case "retail_vm_task": return "/retail/display";
    case "FACTORY_AI_REQUEST": return "/factory-requests";
    case "FACTORY_JOB": return `/factory-job/${n.entity_id}`;
    // a Chat notification opens the conversation; for a project chat it also carries the task the message was about (task context / filter)
    case "CHAT": return n.task_id ? `/chat?c=${n.entity_id}&task=${n.task_id}` : `/chat?c=${n.entity_id}`;
    default: return null;
  }
}
