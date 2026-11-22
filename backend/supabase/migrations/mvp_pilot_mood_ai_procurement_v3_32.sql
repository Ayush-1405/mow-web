-- Mood AI Phase H, third department: Procurement AI (v3_32).
--
-- The chat gets purchase-request tools (mood-ai/tools_procurement.ts): open purchase requests (stage, material, quantity, needed-by
-- date, priority / emergency, department, vendor; overdue flagged), one request in depth (items, vendors it was placed with,
-- purchase order, latest history), what is waiting on this person (department approval for a head, accept / print / place for
-- Procurement, correct / answer on their own request), overdue / delayed / emergency requests, and approved vendors.
-- They read AS THE SIGNED-IN PERSON: proc_can_view_request() row-level security decides which requests anyone sees, and amounts
-- appear only for people the app lets see costing (purchase_costing_can_view). Vendor phone, GSTIN and PAN are never read.
-- The Owner can switch Procurement AI off in the Control Center (Agents); it also needs Application tools on.
-- Data change: one row of mai_agents. No table or permission changes.

update public.mai_agents set is_built = true, enabled = true, updated_at = now(),
  description = 'Answers about purchase requests from live data: stage, what is waiting on you, overdue and emergency requests, vendors and purchase orders -- only for the requests the person can open in the app, with amounts only for people allowed to see costing.'
 where code = 'PROCUREMENT';
