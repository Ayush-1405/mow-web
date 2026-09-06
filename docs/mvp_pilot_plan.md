# Mood of Wood — MVP Pilot: Consolidated Technical Plan

Status: **PROPOSED — nothing in this plan or the accompanying SQL files has been executed or deployed.**
Scope: exactly the 15 sections you specified (Login, Users, Tasks, Bridge, Attachments, Audit, Notifications, Employee UI, Head Dashboard, Control Tower, RLS, pilot users). Nothing beyond that scope is included.

---

## 1. Existing-schema conflict inspection (read-only, just run)

| requested name | status | detail |
|---|---|---|
| `public.task_types` | absent | safe to create as specified |
| `public.proof_types` | absent | safe to create as specified |
| `public.priority_master` | absent | safe to create as specified |
| `public.status_master` | absent | safe to create as specified |
| `public.notifications` | absent | safe to create as specified |
| **`public.tasks`** | **EXISTS — Interior dashboard** | live table: `id, project_id (NOT NULL, FK→projects), title, assigned_to (FK→profiles), due_date, status (OPEN/IN PROGRESS/COMPLETED/BLOCKED/CANCELLED), note, created_by, created_at, updated_at`. FK'd from nothing else, but `project_id` is mandatory and ties every row to an Interior project — structurally incompatible with a cross-department task/bridge workflow. |
| **`public.attachments`** | **EXISTS — Interior dashboard** | live table: `id, project_id (NOT NULL, FK→projects), stage, file_name, title, file_type, file_size, storage_path, uploaded_by (FK→profiles), note, version, frozen, created_at`. 4 existing RLS policies. Project-scoped, not entity-polymorphic. |
| **`public.audit_log`** | **EXISTS — Interior dashboard** | live table: `id, action, target, detail, changed_by (text), changed_by_role, changed_by_auth_id, created_at`. 1 existing RLS policy. No `entity_type`/`entity_id`/JSONB old-new value shape. |

Both existing `tasks` and `attachments` rows currently number 0, and `audit_log` is also 0 rows, but that doesn't matter — they're wired into the live Interior schema (FKs, policies, and presumably the Interior frontend already queries them) and must not be touched, per your own instruction to preserve the Interior system completely.

**Resolution applied throughout this plan:** the three colliding new tables are created under different names, entirely additive, zero interaction with the existing ones:

- `tasks` → **`public.staff_tasks`**
- `attachments` → **`public.staff_attachments`**
- `audit_log` → **`public.staff_audit_log`**

`bridges`, `login_attempts`, and the four master tables keep the names you specified — no collision found for those.

One more thing the inspection caught: `public.is_management()` already exists as an Interior-dashboard helper function. The new RLS layer needed its own equivalent, so it's named `public.staff_is_management()` (and siblings `staff_is_dept_head()`, `staff_is_accounts_head()`, `staff_current_department_id()`, etc.) — never touches or redefines the existing one.

Also checked and clear: no existing storage buckets (a new private `staff-attachments` bucket is safe to create), and `auth.users` currently has 17 rows (unaffected by anything in this plan — no auth users are created here).

**If you'd rather I use different names than `staff_*` (e.g. a separate Postgres schema, or `pilot_*`, or `ops_*`), tell me before I finalize — everything below uses `staff_*` as the working proposal.**

---

## 2. New objects required

**Tables (9):** `task_types`, `proof_types`, `priority_master`, `status_master`, `staff_tasks`, `bridges`, `staff_attachments`, `staff_audit_log`, `notifications`, plus the separately-flagged server-only `login_attempts` (10 total).

**Sequences (2):** `staff_task_number_seq`, `bridge_number_seq` — back `TSK-000001` / `HO-000001` generation without `MAX()+1` races.

**Functions (11):**
- `staff_generate_task_number()` + trigger — assigns `task_number` and derives `is_bridge` on insert.
- `staff_generate_bridge_number()` + trigger — assigns `bridge_number` on insert.
- `staff_validate_task_transition()` + trigger — the database-level status-transition guard (section 6 below), blocks illegal Accept/Return/Start/Complete/Verify/Close jumps regardless of what the UI sends.
- `staff_current_role_code()`, `staff_current_department_id()`, `staff_current_department_group_id()`, `staff_is_management()`, `staff_is_dept_head()`, `staff_is_accounts_head()` — RLS helper functions (`SECURITY DEFINER`, `STABLE`) so policies stay readable and avoid RLS-recursion pitfalls.
- `resolve_employee_login(text)` — the only place Employee Code is resolved to an `auth.users` email. **Locked down**: `REVOKE ALL FROM PUBLIC/anon/authenticated`, `GRANT EXECUTE TO service_role` only. No client, and no `authenticated` session, can ever call it.

**Storage:** one new private bucket, `staff-attachments` (`public = false`). No public policy is created on it — see section 7.

Everything above is in `mvp_pilot_migration.sql`. Everything in section 13 (RLS) is in `mvp_pilot_rls_policies.sql`. Both are additive-only: every `CREATE TABLE` uses `IF NOT EXISTS`, every trigger uses `CREATE OR REPLACE TRIGGER` (Postgres 14+ syntax — this project runs Postgres 17.6, confirmed), every policy uses the same non-destructive `DO $$ IF NOT EXISTS ... THEN EXECUTE 'CREATE POLICY ...' $$` pattern already used in Stage A, and nothing issues `DROP TABLE`, `DROP POLICY`, `ALTER`, or touches any existing Interior object.

---

## 3 / 4. Migration file and RLS policy file

Delivered as separate files: `mvp_pilot_migration.sql` and `mvp_pilot_rls_policies.sql`. Read together with this plan.

### Flagged assumptions inside the migration (please confirm or correct each):

1. **Owner-on-Complete.** Section 6 says "after Complete, responsibility moves to the verifier" but the schema has no fixed "verifier" field until someone verifies. The trigger defaults `current_owner_id` to `COALESCE(NEW.verified_by, NEW.assigned_by)` on Complete — i.e., whoever the app names as verifier, or the original assigner if none is named yet. Confirm this matches your intended flow (e.g., should it always go to the Department Head of `to_department_id` instead?).
2. **`bridges.quantity`** — typed as `text` (not `numeric`) since your spec left the type unstated and quantities in practice may be non-numeric ("10 boxes", "2 rolls"). Tell me if you want `numeric` instead.
3. **Return semantics.** On Return, ownership swaps to `previous_owner_id` (a straight swap). If instead you always want returns to land on `assigned_by` specifically, say so and I'll change the CASE branch.
4. **`staff_audit_log` read access** — proposed as Management-only SELECT (append-only INSERT for everyone else, zero UPDATE/DELETE for anyone including Management, matching "normal users cannot edit audit history"). If Department Heads should also read their own department's audit trail, tell me and I'll widen the SELECT policy.
5. **Task/bridge creation rights** — the migration doesn't yet restrict *who* can create a `staff_tasks` row beyond "you must insert yourself as `assigned_by`." Your spec doesn't define task-creation permissions the way `role_creation_rules` defines user-creation permissions, so for the pilot any active user can create a task. Flag if that's wrong — e.g., if only Dept Heads/Management/Accounts Head should be able to open new tasks, I can add that check into the INSERT policy.

None of these block review — they're implemented as reasonable defaults and clearly isolated in the SQL so you can redirect any one of them without touching the rest.

---

## 5. Server-side functions required (not SQL — Edge Functions, not deployed)

Two Edge Functions are needed. Neither is written or deployed yet (per your instruction not to deploy until approved) — this is the spec for what they must do:

**`login` Edge Function** (public, called by the unauthenticated login screen):
1. Accept `{ employee_code, password }`.
2. Check `login_attempts` (via a `SECURITY DEFINER` helper, since the table has zero client policies) for recent failures on this `employee_code`; if the failure count in the last N minutes exceeds a threshold, reject immediately with a lockout message — do not attempt authentication.
3. Call `resolve_employee_login(employee_code)` using the service-role client (server-side only — this function is unreachable any other way).
4. If no row is found, or `is_active = false`, record a failed attempt in `login_attempts` and return a generic "invalid credentials" error (never reveal whether the code exists).
5. Otherwise, call Supabase Auth's `signInWithPassword({ email: resolved_email, password })` server-side using the resolved (never client-visible) email.
6. On success: record a successful `login_attempts` row, return the resulting session (`access_token`/`refresh_token`) plus `must_change_password` to the client. The client never sees the email at any point.
7. On failure: record a failed attempt, return generic "invalid credentials."

**`create_user` Edge Function** (authenticated, called only from the Users admin UI):
1. Authenticate the caller, look up their `user_profiles.role_id` → role code.
2. Check `role_creation_rules` for a matching `(creator_role_id, creatable_role_id)` row; reject if none exists or `requires_management_approval = true` and the creator isn't Management (System Admin privileged-role creation is out of scope for tomorrow, per your instruction — the function should simply reject any System Admin caller attempting to create a privileged role, with a "not available in this pilot" message, rather than queuing an approval it can't yet process).
3. Validate scope: Department Head's target department/group must match the creator's own; Accounts Head's target department must be Accounts.
4. Call `supabase.auth.admin.createUser()` with the service-role key (server-side only) to create the `auth.users` row and a temporary password.
5. Insert the corresponding `public.user_profiles` row (`must_change_password = true`, `created_by = caller`).
6. Insert `public.user_location_access` rows for the assigned locations.
7. Insert a `staff_audit_log` row for the creation.

Both functions run entirely server-side with the service-role key; it is never sent to, or embedded in, any browser bundle.

---

## 6. Frontend pages/components required

- **Login screen** — Employee Code field, Password field, EN/GU toggle. No email field anywhere.
- **Force-password-change screen** — shown when `must_change_password = true`, blocks all other navigation until a new password is set.
- **Employee Home** — exactly 5 buttons (Today's Tasks, Assign Task, Pending, Update, Need Help), each opening a task-card list filtered accordingly. Task card shows only the 8 fields specified (task, assigned by, due date/time, priority colour, reference, status, required proof, one action button) — no free-text entry beyond what's needed, bilingual dropdowns throughout.
- **Department Head Dashboard** — the 9 widgets listed in section 11, plus inline user-creation for permitted roles (drives the `create_user` function) and task create/assign/reassign.
- **Management Control Tower** — the 8 widgets listed in section 12, with drill-down into any Head's dashboard and department-agnostic user creation. Finance/Accounts department data is excluded from this view for the MVP per your instruction (gated by `departments.is_confidential_domain`, already present from Stage A).
- **User admin form** — the 11 fields listed in section 2, with role/department/location dropdowns sourced from the already-seeded `roles`/`departments`/`locations` tables (their Stage A read policies already support this).
- **Bridge inbox/outbox views** — for Heads and Management, listing bridges by acceptance/verification state.
- **Attachment upload widget** — restricted to image/PDF/Word/Excel/drawing per section 7; a visibly disabled "Voice — Coming next" affordance, never a working button.

---

## 7. Test plan

**Schema/RLS:**
1. Confirm all 9 new tables exist, RLS on, correct policy counts (none of them get a broad `authenticated USING (true)` policy).
2. As a seeded Employee: confirm they can read only tasks where they're `assigned_by`/`assigned_to`/`current_owner_id`, and nothing else's.
3. As a seeded Department Head: confirm they see only their department/group's tasks and bridges, not other departments' (except where they're personally involved).
4. As Management: confirm full read access to tasks/bridges, but confirm Accounts/Finance department rows are excluded from their Control Tower query per the confidentiality carve-out.
5. Attempt to call `resolve_employee_login` directly as `anon` and as `authenticated` — must fail with permission denied.
6. Attempt an illegal status jump (e.g., `ASSIGNED → COMPLETED` directly) — must be rejected by the trigger with a clear error, not silently accepted.
7. Attempt to Return a task without `return_reason` — must be rejected.
8. Attempt to Complete a task whose `proof_type` isn't `none` with zero attachments uploaded — must be rejected.
9. Confirm `staff_audit_log` has no UPDATE/DELETE policy for any role — attempt an update as Management and confirm it's denied.
10. Confirm `public.profiles`, `public.tasks`, `public.attachments`, `public.audit_log` (Interior's originals) are byte-for-byte unchanged in row count, columns, and policy count before vs. after migration.
11. Confirm `auth.users` row count is unchanged (17) after migration — no auth users created by schema changes alone.

**Functional (post pilot-user creation):**
12. Log in as an Employee using Employee Code + password; confirm no email is ever visible in any request/response payload reaching the browser.
13. Trigger 5+ failed logins for one Employee Code; confirm the 6th legitimate attempt is rate-limited/locked rather than processed.
14. Full task lifecycle: Management creates a same-department task → Employee Accepts → Starts → Completes with photo proof → Dept Head Verifies → Closes. Confirm every transition writes a `staff_audit_log` row with correct old/new status.
15. Full bridge lifecycle: create a task with `from_department_id <> to_department_id`, confirm `is_bridge` auto-sets true and a `bridges` row is created; run Accept/Return/Complete/Verify across two different department Heads' sessions, confirming visibility rules hold at each step.
16. Confirm task numbers and bridge numbers are gap-free-but-unique under concurrent creation (no duplicate-number collisions when two tasks are inserted in the same transaction window).

---

## 8. Rollback plan

Every object created by this milestone is additive and uniquely named, so rollback never touches an existing Interior object. If needed, run in this order (reverse of creation, respecting FK dependencies):

```sql
DROP TRIGGER IF EXISTS trg_staff_tasks_validate_transition ON public.staff_tasks;
DROP TRIGGER IF EXISTS trg_staff_tasks_generate_number ON public.staff_tasks;
DROP TRIGGER IF EXISTS trg_bridges_generate_number ON public.bridges;

DROP FUNCTION IF EXISTS public.staff_validate_task_transition();
DROP FUNCTION IF EXISTS public.staff_generate_task_number();
DROP FUNCTION IF EXISTS public.staff_generate_bridge_number();
DROP FUNCTION IF EXISTS public.resolve_employee_login(text);
DROP FUNCTION IF EXISTS public.staff_is_accounts_head();
DROP FUNCTION IF EXISTS public.staff_is_dept_head();
DROP FUNCTION IF EXISTS public.staff_is_management();
DROP FUNCTION IF EXISTS public.staff_current_department_group_id();
DROP FUNCTION IF EXISTS public.staff_current_department_id();
DROP FUNCTION IF EXISTS public.staff_current_role_code();

DROP TABLE IF EXISTS public.notifications;
DROP TABLE IF EXISTS public.staff_audit_log;
DROP TABLE IF EXISTS public.staff_attachments;
DROP TABLE IF EXISTS public.bridges;
DROP TABLE IF EXISTS public.staff_tasks;
DROP TABLE IF EXISTS public.login_attempts;
DROP TABLE IF EXISTS public.status_master;
DROP TABLE IF EXISTS public.priority_master;
DROP TABLE IF EXISTS public.proof_types;
DROP TABLE IF EXISTS public.task_types;

DROP SEQUENCE IF EXISTS public.bridge_number_seq;
DROP SEQUENCE IF EXISTS public.staff_task_number_seq;

DELETE FROM storage.buckets WHERE id = 'staff-attachments';
-- (only safe if the bucket has never received an upload; otherwise empty it first)
```

This rollback is not included as an executable step in the migration — it is provided for reference only, to run manually if the pilot needs to be undone. Nothing here has been executed.

---

## 14. Pilot users (deferred)

Not created in this milestone. After you approve this plan, the migration, and the RLS file, the next step is a separate, small, approved batch: 1 Management, 1 Retail Head, 1 Factory Head, 1 Godown/Dispatch Head, 5–7 Employees — via the `create_user` Edge Function once it's built and deployed. Not all ~100 users, per your instruction.
