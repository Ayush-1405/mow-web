# Mood of Wood — Cloud-Based Company Operating System
### Architecture Blueprint v0.2.1 — Approved for Phase-1 coding, subject to this addendum

**Company:** Mood of Wood India Pvt. Ltd.
**Date:** 26 August 2026
**Previous version:** v0.2 — approved with 3 final corrections
**Status:** Approved for Phase-1 coding, subject to the v0.2.1 addendum (see bottom of this document)

This revises v0.1 with 16 compulsory corrections: an explicit 15-department hierarchy, every department present from day one, an auditable inventory ledger, a real stock-transfer handover, a two-stage factory costing gate enforced by the database, order-line-accurate dispatch matching, a generic approval workflow, and explicit Row Level Security policies. **No dispatch override exists in Phase 1.**

---

## 1. Corrected Architecture

The three-layer shape from v0.1 is unchanged and confirmed working: a simple bilingual Next.js app, Vercel hosting, and Supabase holding every record with Row Level Security. Two parts are corrected here — how security policies are written, and exactly how Employee-Code login works under Supabase Auth.

**Layers (unchanged from v0.1):** Next.js 14 (TypeScript) client → Vercel Edge (frontend only, no secrets) → Supabase South Asia region (Auth, Postgres+RLS, Storage, Edge Functions, Realtime, pg_cron scheduled jobs).

### Correction 11 — Row Level Security, stated explicitly

v0.1 said "enable RLS globally as a project default." That was imprecise. Corrected: **RLS is turned on for every business table individually, and a named policy is written and tested for each access pattern** — enabling RLS with no policy simply blocks all access.

| Policy | Applies to | Rule |
|---|---|---|
| Own assigned records | tasks, notifications, alerts | Visible/editable if `assigned_to = auth.uid()` or `current_owner_id = auth.uid()` |
| Own department records | tasks, factory_jobs, approval_requests, dc_dispatch_checks | Visible if viewer's `department_id` matches, or matches via `department_group_id` |
| Cross-department Bridge access | bridges | Visible to `from_department_id` and `to_department_id` members plus assigned persons |
| Department Head access | all department-scoped tables | Full read + approve within own department/group only |
| Management access | all non-confidential tables | Read + approve across every department; blocked from confidential Finance columns unless also CFO/Accounts |
| Company-wide confidential Finance access *(v0.2.1)* | cash/bank, salary, EMI, P&L, cross-department costing, approval amounts, accounts-domain tables | `management`, `cfo`, `accounts_head` each pass **independently** — Management's access is never contingent on also holding CFO/Accounts Head; `accounts_employee` passes only for assigned records |
| Own-department factory costing *(v0.2.1)* | factory_costing_estimate/actual, scoped to the Factory Head's own department | `dept_head` role in Factory (or a separately granted `factory_cost_view_own`/`factory_cost_entry` user) — never grants company-wide Finance visibility |
| Attachment/storage access | attachments + Storage bucket objects | Same visibility as the parent record; confidential attachments additionally require the Finance policy |
| System Admin — technical only | all tables | Full technical/structure/user access; **no automatic Finance data access** |

**System Admin does not see Finance by default.** Confidential financial columns stay blocked for System Admin unless Management explicitly adds a separate `view_confidential_finance` grant to that specific admin account — a deliberate, logged, one-off decision, never a side-effect of being an admin.

### Correction 12 — how Employee-Code login actually works

Supabase Auth is built around email or phone internally — employees never see or use that. Safe implementation:

1. Employee types their **Employee Code** (e.g. `MOW-0042`) and password — no email field in the UI.
2. A secure server-side Edge Function looks up `employee_code` in `user_profiles` and resolves it to the matching internal Supabase Auth identity. This lookup is one-directional — the internal identity is never sent to or exposed in the browser.
3. The server calls Supabase Auth's sign-in with that internal identity and the submitted password; Supabase verifies the password against its own salted hash — the app never reads, stores, or reconstructs a password.
4. Rate limiting and failed-login lockout are applied at the Edge Function (e.g. short lockout after 5 failed attempts, logged to `audit_log`), in addition to Supabase Auth's own protections.
5. On success, a normal Supabase session token is issued — the employee code is only ever the entry door, never a stored credential itself.

No password, and no reversible mapping from employee code to password, is ever stored.

---

## 2. Corrected Department Hierarchy

v0.1 said "12 frozen departments" without listing them. Corrected: **15 explicit departments**, one Management layer above all of them, grouped by real reporting lines using two relationship types:

- `department_group_id` — used where **one Head literally runs both departments** (shared head, shared dashboard, separate task/workflow data).
- `parent_department_id` — used where a department keeps its **own Head** but a senior department's Head also has secondary oversight visibility.

### Department groups (shared Head)

| Group | Departments | Code |
|---|---|---|
| Retail Group | Retail Stores, Franchise/Dealer | RETAIL, FRANCHISE |
| Marketing Group | Marketing, E-commerce | MARKETING, ECOMMERCE |
| Logistics Group | Godown/Inventory, Dispatch/Logistics | GODOWN_INV, DISPATCH |

### Own Head + secondary oversight

- **Customer Service** (CUST_SERVICE) — own Head runs it day-to-day; `parent_department_id` → Retail Stores gives the Retail Head oversight visibility.

### Standalone departments — each with its own approved Head

Interior Projects (INTERIOR) · B2B/B2G (B2B_B2G) · Procurement (PROCUREMENT) · Factory/Manufacturing (FACTORY) · Product Design/R&D (RND) · HR/Admin (HR_ADMIN) · **Accounts/Finance (ACCOUNTS) — confidential**, under CFO/Accounts Head.

### Management Control Tower

Not an operational department — a visibility layer above all 15, flagged `is_control_tower = true` on its own row, so it can hold Management-only routing without needing its own head or staff.

```
Management Control Tower
├── Retail Group — Retail Head (Retail Stores · Franchise/Dealer)
├── Customer Service — own Head (oversight: Retail Head)
├── Marketing Group — Marketing Head (Marketing · E-commerce)
├── Interior Projects — Interior Head
├── B2B/B2G — B2B/B2G Head
├── Procurement — Procurement Head
├── Logistics Group — Godown & Dispatch Head (Godown/Inventory · Dispatch/Logistics)
├── Factory/Manufacturing — Factory Head
├── Product Design/R&D — R&D Head
├── HR/Admin — HR Head
└── Accounts/Finance — CFO / Accounts Head (confidential)
```

---

## 3. Revised Database Schema

38 Phase-1 tables (up from 20 in v0.1). The growth is entirely the corrections requested: an auditable inventory ledger, stock-transfer handover, split factory costing, order-line dispatch matching, a generic approval workflow, dropdown-driven masters, multi-location access, and notifications with read receipts. Every table also carries `created_at, created_by, updated_at, updated_by, is_active` (omitted below). No SQL has been run yet.

### Organisation & access

**department_groups** *(new)* — `id, name_en, name_gu, group_head_role_code`. Holds the 3 shared-Head groupings.

**departments** *(revised)* — `id, name_en, name_gu, code, department_group_id (→department_groups, nullable), parent_department_id (→departments, self-ref, nullable), head_role_code, is_confidential_domain, is_control_tower`. All 15 departments seeded explicitly.

**role_creation_rules** *(new)* — `id, creator_role_code, creatable_role_code, scope (own_department/any_department)`. Enforces exactly which roles a creator may create — a Department Head can never create Management, CFO, Accounts Head or System Admin.

**user_profiles** *(revised)* — `id, employee_code, full_name, phone, role_id, department_id, home_location_id, reports_to, joining_date, language_pref, must_change_password, created_by`.

**user_location_access** *(new)* — `id, user_id, location_id, access_type (primary/supervises/secondary), granted_by`. A person can work at or supervise more than one location; access is checked from here, not a single field.

**locations, roles, role_permissions** — unchanged from v0.1.

### Master data — no more free-text duplication

**customers** *(new)* — `id, name, phone, email, city, customer_type (retail/dealer/b2b), created_by`
**vendors** *(new)* — `id, name, phone, email, category (raw_material/finished_goods/job_work/service), gst_number, created_by`
**products** — unchanged from v0.1 (id, sku, name_en, name_gu, category, unit_of_measure)
**task_types** *(new)* — `id, code, name_en, name_gu, department_id (nullable=generic), is_active`
**proof_types** *(new)* — `id, code, name_en, name_gu` (photo/document/barcode/voice/customer_confirmation)
**status_master** *(new)* — `id, entity_type, code, name_en, name_gu, sort_order`
**priority_master** *(new)* — `id, code, name_en, name_gu, sort_order, color_code`
**reference_numbers** *(revised)* — `id, ref_number, ref_type, customer_id (→customers), department_id`
**order_lines** *(new)* — `id, reference_number_id, product_id, parent_order_line_id (→order_lines, nullable — for components/accessories), ordered_qty, reserved_qty, picked_qty, dispatched_qty`

### Task engine, Bridge & accountability

**tasks** *(revised)* — `id, title, task_type_id (→task_types), status_id/priority_id/proof_type_id (→masters), from_department_id, to_department_id, assigned_by, assigned_to, current_owner_id, previous_owner_id, reference_number_id, order_line_id, due_date, due_time, is_bridge, bridge_id, accepted_at, started_at, completed_at, verified_at, closed_at, closed_by, delay_responsible_party, recurrence_template_id`

**bridges** — unchanged shape from v0.1 (bridge_number, from/to department+person, requirement, quantity, acceptance_status, return_reason, verified_by/at, closed_at); now reads status/priority via its linked task's master-table references.

**attachments, recurring_task_templates, alerts, escalations, audit_log** — unchanged from v0.1.

**notifications** *(new)* — `id, recipient_id, entity_type, entity_id, delivery_status (queued/sent/delivered/failed), is_read, read_at, escalated_at`. Proves whether the responsible employee actually saw the task.

### Approval workflow (new — reused everywhere an approval is needed)

**approval_requests** — `id, entity_type, entity_id, approval_type (discount/purchase_order/emergency_procurement/payment/factory_release/refund/partial_delivery/dispatch_exception…), requested_by, requested_from, amount_value, approval_level (supervisor/dept_head/management/management_level_2), status (pending/approved/rejected), due_time, reason, decided_by, decided_at, remarks`

**approval_history** — `id, approval_request_id, previous_status, new_status, action_by, action_at, comment`

### Factory — estimated/actual costing, DB-enforced release

**factory_jobs** *(revised)* — same shape as v0.1 (bridge_id not null, drawing/BOM, quantities, machine/worker/shift, wastage/rejection); its `status` now advances only when the release-gate function allows it.

**factory_costing_estimate** *(replaces factory_costing)* — `id, factory_job_id (unique), est_raw_material, est_hardware, est_labour, est_machine, est_outsourcing, est_packing, est_transport, est_overhead, est_wastage, est_total_cost, entered_by, entered_at`. Compulsory before production release.

**factory_costing_actual** *(replaces factory_costing)* — `id, factory_job_id (unique), actual_raw_material, actual_hardware, actual_labour, actual_machine_cost, actual_outsourcing, actual_packing, actual_transport, actual_overhead, actual_wastage, actual_total_cost, variance_amount, variance_percent, entered_by, entered_at`. Variance is computed automatically, never typed by hand.

> **Production release is a database function, not a checkbox.** v0.1 used a single manually-editable `is_locked` flag. Corrected: a Postgres function `fn_can_release_production(factory_job_id)`, checked by a trigger on every `factory_jobs.status` change, evaluates ALL of: linked Bridge accepted · approved drawing attachment present · BOM/cutting list present · required specs filled · `factory_costing_estimate` complete · raw-material availability checked against `inventory_balances` · a `factory_release` approval_request approved by the Factory Head. If any condition fails, the database itself rejects the status transition.

### Inventory ledger & stock transfer

**stock_lots** *(new)* — `id, lot_number, product_id, unit_cost, origin_type, origin_ref_id`. A batch/lot identity so costing and receipt provenance survive as stock moves.

**inventory_transactions** *(new — the ledger of record)* — `id, transaction_number, product_id, stock_lot_id, transaction_type, from_location_id, from_location_type, to_location_id, to_location_type, quantity, unit_cost, total_cost, reference_type, reference_id, barcode, performed_by, accepted_by, transaction_datetime`.
Transaction types: opening · grn_receipt · production_issue · production_return · wip_movement · finished_production_receipt · reservation · reservation_release · transfer_out · transfer_in · dispatch · customer_return · repair · damage · rejection · scrap · physical_adjustment.

**inventory_balances** *(renamed & locked down — was inventory_items)* — `product_id, location_id, location_type, stock_lot_id, quantity, status (receiving_pending·qc_hold·available·reserved·sold·in_production), incoming_qc_result (pending/accepted/rejected), barcode, rack_bin, photo_attachment_id`. A system-maintained summary recalculated by a database trigger every time `inventory_transactions` gets a new row. Direct `UPDATE` of quantity is blocked at the RLS/function level — the only way stock changes is through a transaction. *(`receiving_pending` status and the explicit gate added in v0.2.1 — see the addendum.)*

**transfer_requests** *(new)* — `id, transfer_number, product_id, quantity, from_location_id, to_location_id, requested_by, approval_required, approval_request_id, status (requested→approved→transfer_out→in_transit→receiver_review→transfer_in, or returned), sender_id, receiver_id, dispatched_at, received_at, variance_qty, variance_reason, variance_photo_attachment_id`. Mirrors the Bridge responsibility model: sender stays responsible until the receiver accepts.

### Dispatch — order-line matching & partial delivery

**dc_dispatch_checks** — unchanged header shape from v0.1 (dc_number, invoice/e-way/payment, transporter, vehicle).

**dc_check_items** *(revised)* — `id, dc_dispatch_check_id, order_line_id (→order_lines), ordered_qty, dispatched_qty, item_name_en/gu, result (checked/missing/damaged/hold — તપાસ્યું/બાકી છે/નુકસાન છે/રોકો), remarks, photo_attachment_id`. Now linked to the exact order line, not just a description.

**partial_deliveries** *(new)* — `id, dc_dispatch_check_id, order_line_id, approval_request_id (must be approved), remaining_qty, new_commitment_date, customer_acknowledgement`. The only path around a quantity mismatch — never a direct override.

**delivery_confirmations** — unchanged from v0.1.

> **Correction 3 — the dispatch lock has no override in Phase 1.** Vehicle Loading stays locked whenever any DC line is Missing, Damaged, Hold, Pending, or has a quantity mismatch against its order line. There is **no unlock button for HOD or Management** in Phase 1 — the only ways forward are (a) correct the checklist line itself by re-inspecting/re-counting, or (b) raise a `partial_deliveries` record backed by an approved `approval_requests` row. A future rare-emergency override, if ever introduced, would require two-level Management approval, a mandatory reason and audit proof through the same approval workflow — explicitly **out of scope for Phase 1**.

---

## 4. Revised Permission Matrix

The dispatch-override permission is **removed entirely** — it does not exist for any role, including Management, in Phase 1. Legend: ✓ = full access · ★ = conditional/limited scope · — = no access

| Permission | Mgmt/Director | Dept Head | Supervisor | Employee | CFO | Accounts Head | Accounts Employee | System Admin |
|---|---|---|---|---|---|---|---|---|
| View & work own daily tasks | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ★ |
| Assign task within own department | ✓ | ✓ | ✓ | ★ | ✓ | ✓ | ★ | — |
| Assign task to another department (Bridge) | ✓ | ✓ | ★ | ★ | ✓ | ✓ | ★ | — |
| Accept/Return/Start/Complete assigned work | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Verify & close completed work | ✓ | ✓ | ★ | — | ✓ | ✓ | — | — |
| View any Department Head dashboard | ✓ | — | — | — | ★ | — | — | — |
| Create user — own dept, allowed roles only | ✓ | ★ per role_creation_rules | — | — | — | ✓ | — | ✓ |
| Create user — any department, any role | ✓ | — | — | — | — | — | — | ✓ |
| Enter factory costing — estimated & actual (`factory_cost_entry`) *(v0.2.1)* | — | ★ Factory Head/authorised, own dept | — | — | — | — | — | — |
| View factory costing & variance, own dept only (`factory_cost_view_own`) *(v0.2.1)* | — | ★ Factory Head/authorised | — | — | — | — | — | — |
| Approve factory production release (`factory_cost_approve`) | ✓ | ★ Factory Head, via approval_requests | — | — | — | — | — | — |
| Approve a stock transfer request | ✓ | ★ own dept/group | — | — | — | — | — | — |
| Accept/return an incoming stock transfer | — | ★ receiving dept | ★ | ★ assigned | — | — | — | — |
| Approve a partial delivery/DC exception | ✓ | ★ own dept, via approval_requests only | — | — | — | — | — | — |
| View company-wide confidential finance — cash/bank, salary, EMI, cross-dept costing, P&L (`finance_confidential_view` + `company_pnl_view`) *(v0.2.1)* | ✓ | — | — | — | ✓ | ✓ | ★ assigned records | ★ only with separate Management grant |
| View operational payment status only | ✓ | ✓ | ★ | ★ own orders | ✓ | ✓ | ✓ | — |
| Deactivate/archive sensitive records | ✓ | ★ own dept | — | — | ✓ | ✓ | — | ★ technical only |
| System configuration | ★ with Sys Admin | — | — | — | — | — | — | ✓ |

**What changed:** Removed "Override a locked dispatch" — no longer exists for any role. Added estimated/actual costing entry, production-release approval (now tied to the approval workflow), stock-transfer approval/acceptance, and partial-delivery approval. System Admin's Finance-visibility is now explicitly conditional on a separate Management grant.

---

## 5. Phase-1 Coverage — Every Department

**No department is absent from Phase 1.** Every one of the 15 departments gets, identically: secure login, user permissions, daily tasks, dropdown task assignment, Department Bridge, the full Accept→Return→Start→Complete→Verify→Close flow, attachments, alerts, a Head dashboard, and Management visibility. What differs per department in Phase 1 is only the starting task types and the KPI its Head sees first — deeper automation is scheduled for later phases.

| Department | Head dashboard | Example Phase-1 task types | Basic Phase-1 KPI | Deeper automation |
|---|---|---|---|---|
| Management Control Tower | Company-wide | Review escalation, close exception | Open critical alerts, pending approvals | Full scorecards — Phase 2 |
| Retail Stores | Retail Head (shared) | Customer follow-up, stock-check request, display update | Tasks closed on time %, open bridges out | CRM, quotations, targets — Phase 2 |
| Franchise/Dealer | Retail Head (shared) | Dealer visit, order follow-up, training request | Active dealer requests, overdue tasks | Royalty, territory — Phase 2/3 |
| Customer Service | CS Head (+ Retail oversight) | Complaint ticket, service visit, spare-part request | Open complaints, SLA breaches | Vendor SLA automation — Phase 2 |
| Marketing | Marketing Head (shared) | Content request, campaign task, asset request | Pending content requests | Campaign/ROI — Phase 3 |
| E-commerce | Marketing Head (shared) | Listing update, order-issue escalation, courier follow-up | Pending order issues | Order/inventory sync — Phase 3 |
| Interior Projects | Interior Head | Site measurement, design review, material bridge | Open project tasks, overdue visits | Full stage workflow — Phase 2 |
| B2B/B2G | B2B/B2G Head | Tender document task, site survey, sample follow-up | Pending tender tasks | BOQ/EMD tracking — Phase 3 |
| Procurement | Procurement Head | RFQ follow-up, GRN pending, vendor reminder | Vendor deliveries due in 3 days | Full RFQ/PO cycle — Phase 2 |
| Godown/Inventory | Godown & Dispatch Head (shared) | Stock count, transfer request, GRN entry | Pending transfers, missing barcode/location | Stock ageing, audit — Phase 2 |
| Dispatch/Logistics | Godown & Dispatch Head (shared) | DC check, delivery scheduling, vehicle loading | Dispatch pending today, failed deliveries | Route planning — Phase 3 |
| Factory/Manufacturing | Factory Head | Bridge accept, costing entry, QC check | Jobs awaiting costing, jobs in WIP | Full WIP scheduling — Phase 2 |
| Product Design/R&D | R&D Head | Design brief task, prototype review, sample feedback | Open design requests | Full BOM/launch cycle — Phase 3 |
| HR/Admin | HR Head | Manpower request, document collection, asset issue | Open recruitment tasks | Payroll, attendance — Phase 2 |
| Accounts/Finance | CFO/Accounts Head — confidential | Payment approval task, bill entry, collection follow-up | Approvals pending (internal), payment status (external) | Cash forecast, P&L — Phase 2/3 |

---

## 6. Revised Implementation Order

Still one action at a time, waiting for "Success" after each step. The sequence now front-loads master data and the approval engine, since inventory, factory and dispatch all depend on them.

**A. Supabase foundation & master data**
1. Confirm/create Supabase project, South Asia region; enable RLS per table (not a blanket setting)
2. Create `department_groups`, `departments` (seed all 15 + Control Tower), `locations`, `roles`, `role_permissions`, `role_creation_rules`
3. Create `task_types`, `proof_types`, `status_master`, `priority_master` and seed initial values

**B. Auth, users & multi-location access**
4. Create `user_profiles`, `user_location_access`
5. Build Employee-Code Edge Function (resolver + rate limiting), forced password-change flow
6. Create the 7 labelled test users, each with real location assignments

**C. Core task engine with masters wired in**
7. Create `reference_numbers`, `customers`, `vendors`, `products`, `order_lines`
8. Create `tasks` (with accountability columns), `attachments`, `audit_log`, `notifications`
9. Build Employee 5-button home, dropdown task-assignment form, status flow, read-receipt tracking

**D. Bridge/handover**
10. Create `bridges` + RLS, auto-create on cross-department assignment
11. Accept/Return with mandatory reason, responsibility hand-off, `escalations`, `alerts`

**E. Approval workflow engine**
12. Create `approval_requests`, `approval_history` — generic, reused by every stage below

**F. Inventory ledger**
13. Create `stock_lots`, `inventory_transactions`, `inventory_balances`
14. Build the balance-recalculation trigger; block direct quantity edits at the RLS level

**G. Stock transfer handover**
15. Create `transfer_requests`; build Request → Approve → Transfer Out → In Transit → Accept/Return → Transfer In
16. Wire variance capture (short/excess/damaged, photo, reason) on receipt

**H. Factory bridge, estimated costing & release gate**
17. Create `factory_jobs`, `factory_costing_estimate`
18. Build `fn_can_release_production()` and the status-change trigger enforcing all release conditions

**I. Factory actual costing & variance**
19. Create `factory_costing_actual`; compute variance automatically on save

**J. Dispatch — order-line matching & partial delivery**
20. Create `dc_dispatch_checks`, revised `dc_check_items` (order-line linked), `partial_deliveries`
21. Implement the no-override Vehicle Loading lock and its alert to responsible person + Head
22. Create `delivery_confirmations`

**K. Department rollout — all 15**
23. Plug every department into the common engine with its Phase-1 task types and starter KPI
24. Build each Head dashboard and the Management Control Tower cross-department view

**L. Bilingual UI & mobile QA**
25. Complete Gujarati translations for every screen and every master-table label
26. Responsive pass: phone, tablet, desktop, for all 15 departments' screens

**M. Acceptance testing**
27. Run all 30 Final Acceptance Tests with real test users
28. Publish the v0.2 CHANGELOG entry marking Phase 1 complete; freeze before Phase 2

**Test users (unchanged from v0.1):** Management, Retail Head, Factory Head, Godown & Dispatch Head, one Department employee, CFO, one Accounts employee — each with a clearly labelled demo password, marked as test credentials, now also carrying real `user_location_access` rows so location-restriction testing is possible from day one.

---

## 7. Revised Acceptance Tests

30 tests — the original 20 plus the 12 new ones, consolidated and renumbered so nothing repeats.

1. Management creates a Department Head.
2. HOD creates an employee in their own department only, using an allowed role — never Management, CFO, Accounts Head or System Admin.
3. Employee logs in with Employee Code and changes the temporary password on first login.
4. Employee receives today's tasks on their 5-button home screen.
5. Employee assigns a same-department task using dropdowns for task type, priority and proof required.
6. Cross-department task assignment automatically creates a Bridge.
7. Receiver accepts or returns the Bridge with a mandatory reason.
8. Accepted work appears in the receiver's daily task list; `current_owner_id` moves correctly.
9. Task notification read time is recorded for the assigned employee.
10. Management can view any Department Head's dashboard with read + approve rights.
11. All 15 departments have a working Phase-1 dashboard, task board and Bridge inbox — none is absent.
12. Unauthorized users cannot see confidential Finance data.
13. System Admin cannot automatically view confidential Finance data without a separate Management grant.
14. A user cannot access a branch/location they are not granted in `user_location_access`.
15. A factory job cannot be created without an accepted Department Bridge.
16. Factory production release is blocked by the database function when drawing, BOM, estimated costing, material availability or Factory Head approval is missing.
17. Actual factory cost is entered post-production and the estimated-vs-actual variance is calculated automatically.
18. Finished production enters factory inventory only through an `inventory_transactions` entry, never a direct quantity edit.
19. Stock transfer responsibility changes only after the receiving location accepts; short/excess/damaged quantity is recorded with photo and reason.
20. Dispatch cannot load the vehicle until every DC line is Checked; Missing, Damaged, Hold, Pending, or a quantity mismatch keeps it locked.
21. Department Head cannot bypass or override the dispatch lock — the only correction path is fixing the checklist line itself.
22. Partial delivery is only possible with an approved `approval_requests` record, a recorded remaining quantity, a new commitment date and customer acknowledgement.
23. DC checklist correctly matches ordered, reserved, picked and dispatched quantity per product line and per component/accessory.
24. A missing/damaged item creates an alert to the responsible person and their Department Head.
25. Delivery success, POD and customer happiness are captured at the customer's door.
26. Photo, document and voice-note upload works and is visible only per attachment permission rules.
27. Gujarati/English switch works across the full application, including every master-table dropdown label.
28. Mobile and desktop layouts both work for every department's screens.
29. Full audit history — created by, assigned by, current/previous owner, accepted/started/completed/verified/closed timestamps, return reason, proof — is visible on every task and Bridge.
30. Explicit RLS policies are verified table-by-table: own records, own department, Bridge cross-department, Department Head, Management, confidential Finance, and attachment/storage access all behave correctly.

---

## 8. Changes from v0.1

| # | v0.1 issue | v0.2 correction |
|---|---|---|
| 1 | "12 departments" mentioned without a list | 15 departments named explicitly, with `department_group_id` (shared Head) and `parent_department_id` (oversight-only) relationships |
| 2 | Only Retail, Factory, Godown, and the common engine were clearly Phase 1 | Every department gets login, tasks, Bridge, full status flow, attachments, alerts, Head dashboard and Management visibility in Phase 1 |
| 3 | "Override a locked dispatch" existed as a Management/HOD permission | Removed entirely from Phase 1; only corrections are fixing the DC line itself or an approved `partial_deliveries` exception |
| 4 | Single `inventory_items` table, directly editable | `inventory_transactions` ledger + `stock_lots` + system-maintained `inventory_balances`; direct quantity edits blocked |
| 5 | No formal transfer workflow between locations | `transfer_requests` with full Request → Approve → Out → Transit → Accept/Return → In flow and variance capture |
| 6 | Single `factory_costing` table with a manual `is_locked` flag | Split into `factory_costing_estimate`/`factory_costing_actual` with automatic variance; release gated by a database function checking 7 conditions |
| 7 | DC checklist had no line-level order quantities | `order_lines` + revised `dc_check_items` carry ordered/reserved/picked/dispatched quantity per product and component; `partial_deliveries` for approved exceptions |
| 8 | No generic approval mechanism | `approval_requests` + `approval_history`, reused for discounts, POs, emergency procurement, payments, factory release, refunds, partial delivery |
| 9 | Some free-text fields where a dropdown belonged | `customers`, `vendors`, `task_types`, `proof_types`, `status_master`, `priority_master` added as masters |
| 10 | Single `location_id` on user_profiles | `user_location_access` supports multiple showrooms/godowns/sites per user |
| 11 | "Enable RLS globally as project default" (imprecise) | RLS enabled per table with 8 named, tested policies |
| 12 | Employee-Code login mechanism was only summarised | Full 5-step safe implementation documented, including rate limiting and failed-login lockout |
| 13 | No read-receipt tracking | `notifications` table with delivery_status, is_read, read_at, escalated_at |
| 14 | User creation fields and HOD role restriction were implicit | Explicit field list on user_profiles + `role_creation_rules` enforcing which roles a HOD may create |
| 15 | Accountability fields lived only in audit_log | previous_owner_id, accepted_at, started_at, completed_at, verified_at, closed_at, closed_by, delay_responsible_party added directly to `tasks` |
| 16 | 20 acceptance tests | 30 acceptance tests, covering every correction above |

---

## 9. Page & Navigation Structure

Carried forward from v0.1 with routes added for the new approval, transfer and master-data screens. The Employee 5-button home screen is unchanged:

1. Today's Tasks / આજનાં કામ
2. Assign Task / કામ સોંપો
3. Pending / બાકી કામ
4. Update / અપડેટ
5. Need Help / મદદ જોઈએ

**New routes added in v0.2:** `/dept/transfers` (stock transfer requests), `/control-tower/approvals` (approval inbox, all types), `/factory/costing` (now covers both estimated and actual costing plus release).

All other routes (login, per-role dashboards, admin, finance) are unchanged from v0.1 — see the full route table there.

---

## 10. Requirements Checklist (by phase)

**Common engine — Phase 1, now spans all 15 departments:** Secure Employee-Code login with rate limiting, role-based permissions + role_creation_rules, 15-department hierarchy, daily tasks with master-table driven types/status/priority/proof, Bridge/Handover, full Accept→Close flow with accountability timeline, photo/document/60s-voice proof, alerts/escalation/notifications with read receipts, generic approval workflow, multi-location access, every Head dashboard + Control Tower, explicit tested RLS policies, Gujarati/English switch, mobile-responsive.

**Factory/Manufacturing — Phase 1 core:** Factory order only via accepted Bridge, drawing/BOM verification, estimated costing gate with DB-enforced release function, actual costing + automatic variance. *(Phase 2: full WIP stage tracking, machine/shift scheduling.)*

**Godown, Inventory & Dispatch — Phase 1 core:** Transaction-based inventory ledger (no direct quantity edits), stock transfer handover with receiver acceptance, order-line DC matching with no dispatch override, delivery success/POD/customer-happy capture. *(Phase 2: stock-ageing filter, physical audit & variance reporting.)*

**Retail + Franchise/Dealer, Customer Service — Phase 2:** CRM, quotations, order booking, footfall/conversion, franchise proposal/agreement/royalty tracking, complaint SLA automation.

**Marketing & E-commerce — Phase 3:** Campaign/ROI, website/e-commerce sync, reviews, cart recovery.

**Interior Projects — Phase 2:** Full stage workflow with compulsory Design Freeze gate.

**B2B/B2G — Phase 3:** Tender/GEM, BOQ, EMD, retention tracking.

**Procurement — Phase 2:** Full RFQ (min. 3 quotes) → PO → GRN cycle, 3-day vendor alert.

**HR & Admin — Phase 2:** Recruitment, onboarding, attendance/leave, payroll inputs.

**Accounts & Finance:** Confidentiality boundary + explicit RLS enforced from day one (**Phase 1**). Billing, receipts, payables, cash/bank position, forecast (**Phase 2**). Cost centres, GP, P&L, Tally sync (**Phase 3**).

**Product Design/R&D — Phase 3:** Design brief, prototype, freeze, BOM/product master, launch.

---

## 11. Changelog

| Version | Date | Change | Status |
|---|---|---|---|
| v0.1 | 26 Aug 2026 | Initial architecture, Phase-1 schema, permission matrix, navigation structure and build order drafted for review. | Superseded |
| v0.2 | 26 Aug 2026 | 16 compulsory corrections applied: explicit 15-department hierarchy, full Phase-1 departmental coverage, dispatch override removed, inventory ledger & stock-transfer handover added, estimated/actual factory costing with DB-enforced release gate, order-line DC matching & partial-delivery approval, generic approval workflow, dropdown masters, multi-location access, explicit RLS policies, documented Employee-Code login, notifications with read receipts, user-creation controls, full task/Bridge accountability fields, expanded acceptance tests. | Superseded |
| v0.2.1 | 26 Aug 2026 | Final approval addendum: Management's confidential-Finance access corrected to be independent of the CFO role; factory costing split into 5 named permissions (factory_cost_entry, factory_cost_view_own, factory_cost_approve, finance_confidential_view, company_pnl_view); goods-receipt availability gate made database-enforced (`fn_can_mark_available`) with a new `receiving_pending` status and 5 new acceptance tests. | **Approved for Phase-1 coding** |

---

## v0.2.1 — Final Approval Addendum

*A short addendum correcting the three remaining points from v0.2 — it does not replace or restate the rest of the blueprint above, which stands as written.*

### 1. Management Finance access — no longer CFO-gated

Management/Director has full, **independent** access to confidential Finance information — never contingent on also holding a CFO role.

| Viewer | Access |
|---|---|
| Management/Director | Full — independently, not bundled with or gated by CFO |
| CFO | Full — independently |
| Accounts Head | Full — independently |
| Specifically-authorized Accounts employees | Own assigned records only, by explicit grant |
| System Administrator | None automatically — only with a separate, logged Management grant (unchanged from v0.2) |
| Department Heads & Employees | Operational status only — Payment Pending, Cleared, Collection Due, Approval Pending (unchanged) |

RLS corrected to `role IN ('management','cfo','accounts_head')` as three independent OR-branches, plus `accounts_employee AND explicitly granted`, plus `system_admin AND explicitly granted`.

### 2. Factory costing access — separated from company Finance

A Factory Head (or specifically authorized factory-costing user) may create/view estimated costing, enter actual costing, and view variance **for their own factory jobs only** — without exposing company cash/bank, salaries, EMI, other departments' costing, or branch/company P&L.

| Permission | Mgmt | Factory Head/authorised | CFO | Accounts Head | Accounts Employee |
|---|---|---|---|---|---|
| `factory_cost_entry` — enter estimated + actual costing | — | ✓ own dept jobs | — | — | — |
| `factory_cost_view_own` — view estimate/actual/variance, own dept | — | ✓ own dept jobs | — | — | — |
| `factory_cost_approve` — approve production release | ✓ | ★ own dept jobs, via approval_requests | — | — | — |
| `finance_confidential_view` — cash/bank, salary, EMI, all-dept costing | ✓ | — | ✓ | ✓ | ★ assigned records |
| `company_pnl_view` — branch/company P&L, consolidated reports | ✓ | — | ✓ | ✓ | — |

Management, CFO and Accounts Head see everything — including a Factory Head's own-job costing — through `finance_confidential_view`/`company_pnl_view`; a Factory Head never sees the reverse.

### 3. Goods receipt availability gate — database-enforced and explicit

Every GRN Receipt or Finished Production Receipt captures: product/material, quantity, supplier or factory-job reference, stock lot/batch, unit cost (where authorized), incoming QC result, product/material photo, barcode/QR code, exact location, rack/bin, received by, date/time.

**Stock cannot become Available unless the database confirms every condition.** A new function `fn_can_mark_available(balance_id)` — the same enforcement pattern as the factory release gate — is checked by a trigger before any balance row's status can move to `available`. It requires ALL of: incoming QC result = accepted · photo attachment present · barcode/QR created or verified · exact location selected · rack/bin entered where applicable. Until complete, the balance stays in `receiving_pending` or `qc_hold` — never `available`, for any role, including Management.

**New acceptance tests (31–35):**
31. Goods received without a photo cannot become Available.
32. Goods received without a barcode/QR cannot become Available.
33. Goods received without an exact location/rack cannot become Available.
34. QC-rejected stock moves to Rejected/QC Hold, not Available.
35. Finished production enters factory inventory with its job reference, cost and receipt proof all present.

> **Architecture approved for Phase-1 coding subject to this addendum.** Blueprint v0.2 plus this v0.2.1 addendum together are the approved specification.

---

*Prepared for Mood of Wood India Pvt. Ltd. — for external review only (e.g. a second AI opinion). No code has been written and no database has been touched yet.*
