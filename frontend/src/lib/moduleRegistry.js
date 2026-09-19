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
    "Complaints & Service": "/retail/complaints",
    "Sales Targets": "/retail/targets",
    "Sales Performance": "/retail/performance",
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
  },
  FACTORY: {
    "Production Planning": "/factory/production-planning",
    "Job Orders": "/factory/job-orders",
    "BOM": "/factory/bom",
    "Cutting Lists": "/factory/cutting-lists",
    "Drawings": "/factory/drawings",
    "Raw Material Availability": "/factory/raw-material-availability",
    "Material Issue": "/factory/material-issue",
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

export function getModuleRoute(departmentCode, cardEn) {
  return MODULE_ROUTES[departmentCode]?.[cardEn] || null;
}
