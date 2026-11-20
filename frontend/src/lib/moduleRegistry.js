// Maps a department code + function-card English label to a real route,
// for the small set of departments/cards that have moved past
// "Setup Pending". Any card NOT listed here keeps opening ModuleInfoModal
// exactly as before — see DepartmentDashboard.jsx. Keyed off the same
// `en` label used in departmentConfig.js's DEPARTMENT_FUNCTION_CARDS, so
// there is one source of truth for a card's identity.
export const MODULE_ROUTES = {
  RETAIL: {
    "Walk-in Leads & CRM": "/retail/leads",
    "Sales & Quotations": "/retail/quotations",
    "Order Booking": "/retail/orders",
    "Payment Follow-up": "/retail/orders",
    "Display & Visual Merchandising": "/retail/display",
    "Store Operations": "/retail/store-ops",
    "Stock Availability": "/retail/stock",
    "Stock Transfer Requests": "/retail/stock-transfer",
    "Delivery Coordination": "/retail/delivery",
    "Packing & Godown Handover": "/retail/packing",
    "Complaints & Service": "/retail/complaints",
    "Sales Targets": "/retail/targets",
    "Sales Performance": "/retail/performance",
    "Send to Factory": "/factory-job-cards/new",
    "Factory Job Cards": "/factory-job-cards",
    "Scan Product QR": "/retail/scan",
    "Add New Product": "/retail/add-product",
    "Product Approvals": "/retail/product-approvals",
  },
  // Merged department (v2_93n): both real screens stay reachable as two cards under the one department.
  GODOWN_INV: {
    "Goods Receipt": "/godown/handovers",
    "Delivery Planning": "/dispatch/queue",
  },
  INTERIOR: {
    "Quotation": "/interior-projects/quotation",
    "Project Timeline & Deal Closure": "/interior-projects/project-timeline",
    "Working Drawings": "/interior-projects/working-drawings",
    "Site Execution": "/interior-projects/site-execution",
    "Daily Updates": "/interior-projects/daily-updates",
    "Material Requirements": "/interior-projects/materials",
    "Purchase Management": "/interior-projects/purchase",
    "Client Communication": "/interior-projects/communication",
    "Payment Follow-up": "/interior-projects/payments",
    "Project Completion": "/interior-projects/completion",
    "Project Master Report": "/interior-projects/master-report",
    "Send to Factory": "/factory-job-cards/new",
    "Factory Job Cards": "/factory-job-cards",
  },
  FACTORY: {
    "AI Factory Inbox": "/factory-inbox",
    "Send to Factory": "/factory-job-cards/new",
    "Sofa": "/factory/sofa",
    "Modular": "/factory/modular",
    "Metal Fabrication": "/factory/metal-fabrication",
    "Production Planning": "/factory/production-planning",
    "Job Orders": "/factory/job-orders",
    "BOM": "/factory/bom",
    "Cutting Lists": "/factory/cutting-lists",
    "Drawings": "/factory/drawings",
    "Raw Material Availability": "/factory/raw-material-availability",
    "Material Issue": "/factory/material-issue",
    "Material to Order": "/factory/material-to-order",
    "Machine Tracking": "/factory/machine-tracking",
    "WIP Stages": "/factory/wip-stages",
    "Worker Productivity": "/factory/worker-productivity",
    "Shift Productivity": "/factory/shift-productivity",
    "In-process QC": "/factory/in-process-qc",
    "Final QC": "/factory/final-qc",
    "Rework": "/factory/rework",
    "Rejection": "/factory/rejection",
    "Wastage": "/factory/wastage",
    "Finished Goods": "/factory/finished-goods",
    "Packing": "/factory/packing",
    "Transfer": "/factory/transfer",
    "Product Time Tracking": "/factory/product-time-tracking",
    "Mandatory Product Costing": "/factory/product-costing",
    "Factory Inventory Costing": "/factory/inventory-costing",
  },
};

// Procurement's 19 cards, each with its honest build status. ACTIVE: everything the card promises exists and has passed the
// database tests (backend/supabase/tests/procurement_*.sql) and the end-to-end run through the real screens. IN_PROGRESS:
// it works and is tested, but part of what the card promises is not built yet (noted per card). SETUP_PENDING: nothing yet.
// Factory Job Cards for the other selling / design departments (v3_15).
for (const code of ["ECOMMERCE", "FRANCHISE", "B2B_B2G", "RND", "MARKETING"]) {
  MODULE_ROUTES[code] = { ...(MODULE_ROUTES[code] || {}), "Create Factory Job Card": "/factory-job-cards/new", "Factory Job Cards": "/factory-job-cards" };
}

export const PROCUREMENT_MODULES = {
  "Purchase Requirements": { status: "ACTIVE", route: "/procurement/requests" },
  "Vendor Comparison": { status: "ACTIVE", route: "/procurement/requests?tab=working" },
  "GRN Coordination": { status: "ACTIVE", route: "/procurement/requests?tab=ordered" },
  "Rejections": { status: "ACTIVE", route: "/procurement/rejections" },
  "Payment Coordination": { status: "ACTIVE", route: "/procurement/requests?tab=done" },
  // Missing: amending or cancelling a placed order.
  "Purchase Orders": { status: "IN_PROGRESS", route: "/procurement/requests?tab=ordered" },
  // Missing: uploading the quotation document itself.
  "Vendor Quotations": { status: "IN_PROGRESS", route: "/procurement/requests?tab=working" },
  // Missing: automatic escalation of approvals left waiting.
  "Approvals": { status: "IN_PROGRESS", route: "/procurement/requests?tab=waiting" },
  // Missing: reminders on the next follow-up date; not yet driven through the screens end to end.
  "Vendor Follow-up": { status: "IN_PROGRESS", route: "/procurement/requests?tab=ordered" },
  // Missing: attaching dispatch documents (LR copy, invoice copy).
  "Vendor Dispatch": { status: "IN_PROGRESS", route: "/procurement/requests?tab=ordered" },
  // Database-tested; not yet driven through the screens end to end.
  "Emergency Procurement": { status: "IN_PROGRESS", route: "/procurement/requests?tab=new&emergency=1" },
  // Missing: milestones and completion tracking.
  "Work Orders": { status: "IN_PROGRESS", route: "/procurement/requests?tab=ordered&category=LABOUR,TURNKEY,JOB_WORK,SERVICE" },
  // These run on the common request -> order -> receipt flow, filtered by purchase type. Missing per card: a supplier
  // catalogue (raw material, material), stock requirement planning (finished goods), material issue/return and quality
  // (job work), attendance and bills (labour), scope milestones (turnkey).
  "Raw Material Procurement": { status: "IN_PROGRESS", route: "/procurement/requests?tab=working&category=RAW_MATERIAL" },
  "Finished Goods Procurement": { status: "IN_PROGRESS", route: "/procurement/requests?tab=working&category=FINISHED_GOODS" },
  "Material Procurement": { status: "IN_PROGRESS", route: "/procurement/requests?tab=working&category=MATERIAL,CONSUMABLES,MACHINERY" },
  "Vendor Job Work": { status: "IN_PROGRESS", route: "/procurement/requests?tab=working&category=JOB_WORK" },
  "Labour Procurement": { status: "IN_PROGRESS", route: "/procurement/requests?tab=working&category=LABOUR" },
  "Turnkey Agency": { status: "IN_PROGRESS", route: "/procurement/requests?tab=working&category=TURNKEY" },
  "BOQ Verification": { status: "SETUP_PENDING" },
};

export function getModuleRoute(departmentCode, cardEn) {
  if (departmentCode === "PROCUREMENT") return PROCUREMENT_MODULES[cardEn]?.route || null;
  return MODULE_ROUTES[departmentCode]?.[cardEn] || null;
}
