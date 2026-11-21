// What Mood AI knows about the app's screens (Phase C). It is used to explain where things are and to suggest links.
// A suggested link is only shown when it is in this list AND the person can open that department (the browser still
// guards every page itself). dept: null = everyone, "MGMT" = Management Control Tower only, otherwise a department code.

export interface AppPage { path: string; name: string; dept: string | null; about: string }

export const APP_PAGES: AppPage[] = [
  // everyone
  { path: "/", name: "Home (task menu)", dept: null, about: "The home screen. Its menu (left side on computer, bottom bar on phone) has: Today's Tasks (your tasks: assigned to you, created by you, due and overdue; open one to update it, add photos, voice notes or chat), 📝 Assign Task (THIS is where you create a new task: title, assignee, department, due date, priority), Bridge, Notifications, and for Management also Create User, Dashboard and Audit Log." },
  { path: "/tasks", name: "Today's tasks list", dept: null, about: "List of tasks with filters (my tasks, created by me, department, overdue, by date). To CREATE a task use 📝 Assign Task in the home menu, not this page." },
  { path: "/ai-tasks", name: "AI task draft", dept: null, about: "Type or speak a task in any language; AI drafts it (title, assignee, due date) and you check it before saving." },
  { path: "/bridges", name: "Department bridges", dept: null, about: "Hand work from one department to another and track it until the other side accepts and completes it." },
  { path: "/chat", name: "Team chat", dept: null, about: "Chat with colleagues and groups." },
  { path: "/notifications", name: "Notifications", dept: null, about: "All your alerts: new tasks, approvals, replies, reminders." },
  { path: "/performance", name: "My performance", dept: null, about: "Your monthly performance: tasks on time, delays, quality, and your monthly report and review." },
  { path: "/profile", name: "My profile", dept: null, about: "Your details, phone number, language and password." },
  { path: "/purchase-requests", name: "Purchase requests", dept: null, about: "Raise and follow purchase requests for materials; Procurement handles them after approval." },
  { path: "/purchase-requests/new", name: "New purchase request", dept: null, about: "Form to raise a new purchase request." },
  { path: "/factory-job-cards", name: "Factory job cards", dept: null, about: "Job cards sent to the factory and their stage (cutting, carcass, polish, QC, packing, dispatch)." },
  { path: "/factory-job-cards/new", name: "Send to factory", dept: null, about: "Create a factory job card for a product or project item." },
  // management
  { path: "/management", name: "Management Control Tower", dept: "MGMT", about: "Company-wide view: every department's tasks, delays, approvals and alerts." },
  { path: "/reports", name: "Reports", dept: "MGMT", about: "Company reports and exports." },
  { path: "/analytics", name: "Analytics", dept: "MGMT", about: "Charts and trends across departments." },
  { path: "/performance/team", name: "Team performance", dept: "MGMT", about: "Performance of every person and department for a month." },
  { path: "/performance/control", name: "Performance control", dept: "MGMT", about: "Generate monthly performance reports, AI reviews, frameworks and settings." },
  { path: "/mood-ai", name: "Mood AI Control Center", dept: "MGMT", about: "Mood AI status, emergency stop, models, budget, usage and the laptop server." },
  { path: "/company-settings", name: "Company settings", dept: "MGMT", about: "Company-level settings." },
  { path: "/users", name: "Users", dept: "MGMT", about: "Staff accounts, roles and departments." },
  // retail
  { path: "/retail", name: "Retail dashboard", dept: "RETAIL", about: "Showroom overview: leads, quotations, orders, targets." },
  { path: "/retail/leads", name: "Walk-in leads & CRM", dept: "RETAIL", about: "Record walk-in customers and follow up leads." },
  { path: "/retail/quotations", name: "Sales & quotations", dept: "RETAIL", about: "Make and send quotations." },
  { path: "/retail/orders", name: "Order booking & payments", dept: "RETAIL", about: "Book orders and follow up payments." },
  { path: "/retail/stock", name: "Stock availability", dept: "RETAIL", about: "Check product stock." },
  { path: "/retail/stock-transfer", name: "Stock transfer requests", dept: "RETAIL", about: "Ask for stock to be moved between godown and stores." },
  { path: "/retail/delivery", name: "Delivery coordination", dept: "RETAIL", about: "Plan and track customer deliveries." },
  { path: "/retail/complaints", name: "Complaints & service", dept: "RETAIL", about: "Log and resolve customer complaints." },
  { path: "/retail/targets", name: "Sales targets", dept: "RETAIL", about: "Monthly sales targets and progress." },
  { path: "/retail/performance", name: "Sales performance", dept: "RETAIL", about: "Sales results by person and store." },
  { path: "/retail/daily-update", name: "Retail daily update", dept: "RETAIL", about: "End-of-day store update." },
  { path: "/retail/reports", name: "Retail reports", dept: "RETAIL", about: "Retail reports." },
  { path: "/retail/scan", name: "Scan product QR", dept: "RETAIL", about: "Scan a product's QR code to see its details." },
  // interior
  { path: "/interior-projects", name: "Interior projects dashboard", dept: "INTERIOR", about: "All interior projects with their stage and delays." },
  { path: "/interior-projects/new", name: "New interior project", dept: "INTERIOR", about: "Start a new interior project for a client." },
  { path: "/interior-projects/quotation", name: "Interior quotation", dept: "INTERIOR", about: "Quotation files for interior projects." },
  { path: "/interior-projects/project-timeline", name: "Project timeline & deal closure", dept: "INTERIOR", about: "Project milestones and deal closure." },
  { path: "/interior-projects/working-drawings", name: "Working drawings", dept: "INTERIOR", about: "Design, material selection, drawings and design approval/lock." },
  { path: "/interior-projects/site-execution", name: "Site execution", dept: "INTERIOR", about: "Work on site: progress and issues." },
  { path: "/interior-projects/daily-updates", name: "Site daily updates", dept: "INTERIOR", about: "Daily site photos and notes." },
  { path: "/interior-projects/materials", name: "Material requirements", dept: "INTERIOR", about: "Materials needed per project." },
  { path: "/interior-projects/purchase", name: "Interior purchase management", dept: "INTERIOR", about: "Purchases for a project." },
  { path: "/interior-projects/communication", name: "Client communication", dept: "INTERIOR", about: "Client messages and meeting notes." },
  { path: "/interior-projects/payments", name: "Interior payment follow-up", dept: "INTERIOR", about: "Client payments due and received." },
  { path: "/interior-projects/completion", name: "Project completion", dept: "INTERIOR", about: "Handover and completion checklist." },
  { path: "/interior-projects/master-report", name: "Project master report", dept: "INTERIOR", about: "Everything about one project in one report." },
  // procurement
  { path: "/procurement", name: "Procurement dashboard", dept: "PROCUREMENT", about: "Purchase requests to handle, vendor orders and delays." },
  { path: "/procurement/requests", name: "Procurement requests", dept: "PROCUREMENT", about: "All purchase requests to process." },
  { path: "/procurement/vendors", name: "Vendors", dept: "PROCUREMENT", about: "Vendor list and details." },
  { path: "/procurement/reminders", name: "Procurement reminders", dept: "PROCUREMENT", about: "Follow-ups due with vendors." },
  { path: "/procurement/rejections", name: "Procurement rejections", dept: "PROCUREMENT", about: "Rejected requests and reasons." },
  // godown / inventory / dispatch
  { path: "/inventory", name: "Godown & inventory dashboard", dept: "GODOWN_INV", about: "Godown overview: stock, receipts, dispatch." },
  { path: "/godown/stock", name: "Godown stock", dept: "GODOWN_INV", about: "Stock in the godown." },
  { path: "/godown/stock-intake", name: "Stock intake", dept: "GODOWN_INV", about: "Record goods coming in." },
  { path: "/godown/handovers", name: "Goods receipt / handovers", dept: "GODOWN_INV", about: "Receive goods handed over by other departments." },
  { path: "/godown/my-work", name: "Godown – my work today", dept: "GODOWN_INV", about: "Your godown jobs for today." },
  { path: "/dispatch/queue", name: "Delivery planning / dispatch queue", dept: "GODOWN_INV", about: "Orders waiting to be packed and dispatched." },
  { path: "/godown/reports", name: "Godown reports", dept: "GODOWN_INV", about: "Godown reports." },
  // factory
  { path: "/factory", name: "Factory job cards board", dept: "FACTORY", about: "The factory's job cards by stage." },
  { path: "/factory/inbox", name: "Factory inbox", dept: "FACTORY", about: "New requests sent to the factory." },
  { path: "/factory/tasks", name: "Factory tasks", dept: "FACTORY", about: "Tasks inside the factory." },
  { path: "/factory/overview", name: "Factory work overview", dept: "FACTORY", about: "All factory work and its status." },
  { path: "/factory/production-planning", name: "Production planning", dept: "FACTORY", about: "Plan what to make and when." },
  { path: "/factory/final-qc", name: "Final QC", dept: "FACTORY", about: "Final quality check before packing." },
  { path: "/factory/rework", name: "Rework", dept: "FACTORY", about: "Items sent back for rework." },
  { path: "/factory/material-orders", name: "Factory material orders", dept: "FACTORY", about: "Materials the factory has ordered." },
  { path: "/factory/advanced", name: "Factory advanced tools", dept: "FACTORY", about: "BOM, cutting lists, wastage, productivity, costing and more." },
  // other departments (dashboard pages)
  { path: "/marketing", name: "Marketing", dept: "MARKETING", about: "Marketing department dashboard." },
  { path: "/ecommerce", name: "E-commerce", dept: "ECOMMERCE", about: "E-commerce department dashboard." },
  { path: "/franchise-dealer", name: "Franchise / dealer", dept: "FRANCHISE", about: "Franchise and dealer dashboard." },
  { path: "/b2b-b2g", name: "B2B / B2G", dept: "B2B_B2G", about: "Business and government sales dashboard." },
  { path: "/product-rnd", name: "Product design / R&D", dept: "RND", about: "New product design dashboard." },
  { path: "/hr-admin", name: "HR / Admin", dept: "HR_ADMIN", about: "HR and admin dashboard." },
  { path: "/accounts-finance", name: "Accounts / Finance", dept: "ACCOUNTS", about: "Accounts and finance dashboard (restricted)." },
  { path: "/customer-service", name: "Customer service", dept: "CUST_SERVICE", about: "Customer service dashboard." },
];

// Pages this person may be pointed to. depts = department codes they can open (from the same check the sidebar uses);
// management = they can open the Control Tower. Unknown departments are simply left out.
export function pagesFor(depts: string[], management: boolean): AppPage[] {
  const set = new Set(depts);
  return APP_PAGES.filter((p) => p.dept === null || (p.dept === "MGMT" ? management : set.has(p.dept)));
}

// The page someone is on: exact match first, then the longest known prefix (e.g. /retail/customer/123 -> /retail).
export function pageAt(path: string): AppPage | null {
  const clean = (path || "/").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const exact = APP_PAGES.find((p) => p.path === clean);
  if (exact) return exact;
  return APP_PAGES.filter((p) => p.path !== "/" && clean.startsWith(p.path + "/")).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}
