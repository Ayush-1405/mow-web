# Mood of Wood — MVP Pilot: Consolidated Technical Plan v2

Status: **PROPOSED — nothing in v2 has been executed or deployed.** No storage bucket has been created.
This supersedes `mvp_pilot_plan.md`/`_migration.sql`/`_rls_policies.sql` (v1), which were never executed.

---

## 0. Decisions you made on the five v1 assumptions (applied throughout v2)

1. **Verifier is explicit.** `staff_tasks.verifier_id` (NOT NULL) added, defaults to `assigned_by` at creation, changeable only by Management/HOD via `staff_reassign_task`. On Complete, `current_owner_id := verifier_id`.
2. `bridges.quantity` stays `text`.
3. **Return ownership is explicit, never a nullable fallback.** Bridge return → `bridges.from_person_id`. Same-department task return → `staff_tasks.assigned_by`. The trigger looks these up directly; it never reads `previous_owner_id` as the return target.
4. `staff_audit_log` gets a new `department_id` column. Department Heads can `SELECT` their own department/group's rows; Management sees all.
5. Any active employee can call `staff_create_task` for a same-department task or a cross-department Bridge; every input is server-validated inside the function.

---

## 1. Conflict inspection — unchanged from v1, still holds

`public.tasks`, `public.attachments`, `public.audit_log` are still live Interior-dashboard tables (confirmed again would show the same result — no schema changes have been executed since the v1 inspection). v2 continues using `staff_tasks` / `staff_attachments` / `staff_audit_log`, per your approval of the `staff_*` naming.

---

## 2. What changed structurally in v2 (the 18 compulsory corrections, at a glance)

| # | Correction | v2 mechanism |
|---|---|---|
| 1 | Atomic task+bridge creation | `staff_create_task()` — one function call, one transaction, creates both rows |
| 2 | No broad UPDATE | All 9 action RPCs replace `staff_tasks_update_scoped`/`bridges_update_scoped` |
| 3 | Actor validation | Every RPC checks `auth.uid()` against the specific role required for that action |
| 4 | Return ownership fix | Explicit sender lookup in the trigger (bridge → `from_person_id`, task → `assigned_by`) |
| 5 | Task/Bridge sync | Each RPC updates both tables in the same function call (implicit single transaction) |
| 6 | Trusted audit log | `staff_write_audit()` is the only INSERT path; no client INSERT policy exists |
| 7 | Safe notification update | `staff_mark_notification_read()` is the only write path to `notifications` |
| 8 | Safe employee directory | `staff_directory` view (6 safe columns); full-profile SELECT narrowed to self/HOD-scope/Management |
| 9 | Customer Service oversight | `staff_dept_in_hod_scope()` adds `parent_department_id` to the group/self check |
| 10 | Active-user enforcement | `staff_current_user_ok()` (policies) / `staff_assert_operational()` (RPCs) gate everything except own-profile |
| 11 | Force-password-change enforcement | Same two gate functions include `must_change_password = false` |
| 12 | Proof-type validation | Trigger checks `file_type` per `proof_types.code`, not just "any attachment exists" |
| 13 | Attachment security | `staff_record_attachment()` validates MIME/size/prefix/parent-access/confidentiality before insert |
| 14 | Management bootstrap | `staff_bootstrap_management()` — manual, one-time, requires you to supply the exact `auth.users` id |
| 15 | Create-user failure cleanup | Specified in the `create_user` Edge Function pseudocode (section 4 below) |
| 16 | Rate-limit index | `idx_login_attempts_rate_limit` on `(lower(btrim(employee_code)), attempted_at DESC)` |
| 17 | Server-side timestamps | No RPC parameter ever accepts a timestamp/ownership column; the trigger derives all of them |
| 18 | Finance operational Bridge | `staff_create_task` rejects any cross-department Bridge touching a confidential department, for this pilot |

---

## 3. RPC / action-function list (all in `mvp_pilot_migration_v2.sql`, section numbers below match the file)

| Function | Purpose | Who may call it (enforced inside the function) |
|---|---|---|
| `staff_create_task(...)` | Atomic task (+ Bridge if cross-department) creation | Any active, password-set user; verifier override requires Management/HOD |
| `staff_accept_task(task_id)` | ASSIGNED → ACCEPTED | `assigned_to` only |
| `staff_return_task(task_id, reason)` | → RETURNED (reason compulsory) | Current owner (pre-Complete stages); verifier/HOD/Management (post-Complete) |
| `staff_start_task(task_id)` | ACCEPTED → IN_PROGRESS | Current owner only |
| `staff_complete_task(task_id)` | IN_PROGRESS → COMPLETED (proof validated by trigger) | Current owner only |
| `staff_verify_task(task_id)` | COMPLETED → VERIFIED | `verifier_id`, authorized HOD, or Management |
| `staff_close_task(task_id)` | VERIFIED → CLOSED | `verifier_id`, authorized HOD, or Management |
| `staff_reassign_task(task_id, new_assignee?, new_verifier?)` | Change assignee/verifier | Authorized HOD or Management only |
| `staff_request_help(task_id, note?)` | Sets `help_requested = true` | Assignee or current owner |
| `staff_mark_notification_read(notification_id)` | Sets `is_read`/`read_at` only | Recipient only |
| `staff_record_attachment(...)` | Validated attachment metadata insert (post-signed-upload) | Anyone with access to the parent task/Bridge |
| `staff_write_audit(...)` | Internal audit insert helper | Called only by the above functions (not directly callable — `REVOKE`d from all client roles) |
| `staff_complete_password_change(user_id)` | Clears `must_change_password` | `service_role` only — called by the Edge Function after a real Auth password change |
| `staff_bootstrap_management(...)` | One-time Management profile creation | `service_role` only — manual, see section 5 |

Plus the read-only helper functions used throughout RLS and the RPCs: `staff_current_role_code()`, `staff_current_department_id()`, `staff_current_department_group_id()`, `staff_is_management()`, `staff_is_dept_head()`, `staff_is_accounts_head()`, `staff_dept_in_hod_scope()`, `staff_current_user_ok()`, `staff_assert_operational()`.

System Admin is not granted any special-case authorization anywhere in this list, per Correction 3 — no RPC checks for `role_code = 'sysadmin'`, so a System Admin account has exactly the same (typically zero) operational rights as any other non-participant.

---

## 4. Edge Function list (spec only — not written or deployed)

**`login`** — unchanged in shape from v1, now additionally must call `resolve_employee_login` → check `login_attempts` rate limit (using the new index) → `signInWithPassword` → return session + `must_change_password`. See v1 plan for the full step list; still accurate.

**`create_user`** — unchanged core flow, plus **Correction 15 (failure cleanup)**:
1. Validate caller against `role_creation_rules`, department/group scope, and (System Admin privileged roles remain hidden for this pilot, per your original section 2 instruction).
2. **Idempotency check first**: query `user_profiles` for the normalized `employee_code`; if it already exists, reject immediately with a clear "employee code already in use" error — before calling any Auth API.
3. Call `supabase.auth.admin.createUser()`.
4. Insert `user_profiles` + `user_location_access` rows.
5. **On failure at step 4**: call `supabase.auth.admin.deleteUser(newAuthId)` to remove the orphaned Auth user, then return a clear error — never leave an Auth user with no matching profile.
6. On success: write an audit row (via a thin wrapper that calls `staff_write_audit` with the service-role connection, since the Edge Function itself is the trusted actor here, not an RPC-calling client).

**`password_change`** (new in v2, not present in v1's list) — receives the authenticated user's new password, calls Supabase Auth's own password-update flow (or requires the client to have already re-authenticated with the new password), confirms success, then calls `staff_complete_password_change(user_id)` with the service-role key. This is the only path that can clear `must_change_password`.

**`upload_url`** (new in v2, needed by Correction 13) — authenticated Edge Function that mints a short-lived signed upload URL scoped to `staff-attachments/<auth.uid()>/<uuid>-<filename>`, so the client's storage write is confined to its own prefix (matching the prefix check inside `staff_record_attachment`). After the client uploads directly to that signed URL, it calls `staff_record_attachment(...)` to register the metadata. Also exposes a **signed download URL** endpoint that re-checks the same access rules as `staff_attachments_select_matches_parent` before minting a read URL — this is the enforcement point for "private bucket, access via signed URLs" now that storage itself has no broad read policy.

None of these four functions are written or deployed yet.

---

## 5. Bootstrap procedure (Correction 14)

This is a manual, human-in-the-loop step — nothing here runs automatically:

1. **You tell me** which of the 17 existing `auth.users` accounts is the intended Management user — by email or by `auth.users.id`. I will not guess, sample, or infer this from `raw_user_meta_data` or any heuristic.
2. I run a read-only check confirming that id exists in `auth.users` and that no `user_profiles` row for a *different* id already has the `management` role (the function itself also enforces this, but I'll verify first).
3. You give me the Employee Code, full name, and (optional) phone to use for this Management profile.
4. I call `staff_bootstrap_management(auth_user_id, employee_code, full_name, phone)` once, using the service-role connection.
5. I verify: exactly one `user_profiles` row exists with role `management`, it's linked to Head Office via `user_location_access`, and a `BOOTSTRAP_MANAGEMENT` row exists in `staff_audit_log`.
6. The function is safe to re-run with the *same* `auth_user_id` (upserts), but raises an exception if you ever try to bootstrap a second, different id while a Management profile already exists — preventing accidental double-bootstrap.

This happens only after you approve v2 and separately confirm the Management account identity — it is not bundled into the general migration run.

---

## 6. Revised test plan (supersedes v1 section 7)

**Schema/RLS/RPC:**
1. Confirm all tables/views exist, RLS on, and — critically — confirm `staff_tasks`, `bridges`, `staff_attachments`, `staff_audit_log`, `notifications` each have **zero** INSERT policy and **zero** UPDATE policy for `authenticated` (query `pg_policies` and assert empty for those `cmd` values on those tables).
2. Attempt a raw `INSERT`/`UPDATE` against each of those five tables directly via the client (bypassing all RPCs) — must fail with a permission/RLS error every time.
3. Call `staff_create_task` as a same-department task — confirm exactly one `staff_tasks` row, zero `bridges` rows, `current_owner_id = creator`.
4. Call `staff_create_task` cross-department — confirm exactly one `staff_tasks` row AND exactly one `bridges` row are created together (query both tables in the same check, same test transaction).
5. Attempt `staff_create_task` with `from`/`to` department where either is confidential and they differ — must be rejected (Correction 18).
6. Run the full Accept → Start → Complete → Verify → Close chain via the RPCs as the correct actors at each step — confirm success, confirm `bridges` fields stay in sync at each step when `is_bridge = true`.
7. At each step, attempt the same call as a *wrong* actor (e.g., call `staff_accept_task` as someone other than `assigned_to`) — must be rejected with a clear error.
8. `staff_return_task` mid-chain: confirm `current_owner_id` lands exactly on the expected sender (bridge → `from_person_id`, non-bridge → `assigned_by`) — never NULL, never a stale `previous_owner_id`.
9. `staff_complete_task` with `proof_type = photo` and zero attachments — rejected. With a `document`-typed attachment instead of `image` — rejected. With a correctly-typed attachment — succeeds.
10. Deactivate a user (`is_active = false`) mid-session (their JWT is still technically valid) — confirm their next call to any RPC or any SELECT on a gated table fails immediately (Correction 10), not just that a future login is blocked.
11. Set `must_change_password = true` for a user — confirm they can still `SELECT` their own `user_profiles` row, but every other RPC/table access is rejected until `staff_complete_password_change` clears the flag.
12. Confirm `staff_directory` returns only the 6 approved columns and nothing else, for a colleague in the caller's scope.
13. Confirm a plain Retail employee (not Head) cannot see Customer Service tasks/users, but the Retail Head can (Correction 9).
14. Confirm a Department Head can `SELECT` `staff_audit_log` rows for their own department/group only; Management sees all; a plain employee sees none.
15. Confirm `public.profiles`, `public.tasks`, `public.attachments`, `public.audit_log` (Interior's originals) and `auth.users`'s row count are unchanged before vs. after migration.

**Concurrency/number generation (wording corrected per your note):**
16. Fire 20 concurrent `staff_create_task` calls — assert every resulting `task_number` is **unique**; do **not** assert they are gap-free or sequential-without-holes. Task/Bridge numbers are unique and concurrency-safe by construction (Postgres sequences), and gaps are expected and acceptable after any rolled-back attempt — this is normal, not a defect.

**Functional (post pilot-user creation, same as v1):**
17–21. Login via Employee Code (no email ever visible to the browser), rate-limit lockout after repeated failures, full task lifecycle end-to-end, full Bridge lifecycle across two Heads' sessions, attachment upload via signed URL + `staff_record_attachment`.

---

## 7. Exact changes from v1

**Schema:**
- `staff_tasks`: added `verifier_id uuid NOT NULL REFERENCES user_profiles(id)`; added `customer_confirmation_text text`.
- `staff_audit_log`: added `department_id uuid REFERENCES departments(id)`.
- New: `staff_directory` (view), `idx_login_attempts_rate_limit` (index).
- New functions: `staff_assert_operational`, `staff_current_user_ok`, `staff_dept_in_hod_scope`, `staff_write_audit`, `staff_touch_updated_at` (+ trigger on `staff_tasks`/`bridges`), `staff_create_task`, `staff_accept_task`, `staff_return_task`, `staff_start_task`, `staff_complete_task`, `staff_verify_task`, `staff_close_task`, `staff_reassign_task`, `staff_request_help`, `staff_mark_notification_read`, `staff_record_attachment`, `staff_complete_password_change`, `staff_bootstrap_management`.
- `staff_validate_task_transition()` trigger: rewritten — proof validation is now per-proof-type (Correction 12), Return-ownership uses explicit sender lookup instead of `previous_owner_id` fallback (Correction 4), Complete-ownership goes to `verifier_id` instead of `COALESCE(verified_by, assigned_by)` (Decision 1).

**RLS — removed from v1:**
- `staff_tasks_insert_self`, `staff_tasks_update_scoped` (→ replaced by RPCs)
- `bridges_insert_sender`, `bridges_update_scoped` (→ replaced by RPCs)
- `staff_attachments_insert_self` (→ replaced by `staff_record_attachment`)
- `staff_audit_log_insert_self` (→ replaced by `staff_write_audit`, internal-only)
- `notifications_update_own_read_state` (→ replaced by `staff_mark_notification_read`)
- `user_profiles_select_colleagues` (→ replaced by `user_profiles_select_hod_scope` + `staff_directory` view)

**RLS — added/changed in v2:**
- `user_profiles_select_hod_scope` (full-profile access narrowed to self/HOD-scope/Management, dropping the old blanket "any colleague in my department" full-row read)
- `staff_audit_log_select_scoped` (Management + HOD's own department/group, replacing v1's Management-only read)
- Every remaining SELECT policy gains `AND public.staff_current_user_ok()` except `user_profiles_select_own`
- All `staff_dept_in_hod_scope` uses now include `parent_department_id` oversight (Correction 9), not just `department_group_id`

**Test plan:** rewritten per section 6 above; the "gap-free" wording is corrected to "unique and concurrency-safe, gaps allowed."

**Still deferred to a later step (unchanged from v1):** pilot user creation (section 14 of your original spec) and the storage bucket `INSERT` — both wait for your explicit approval after this v2 review, and the bootstrap procedure additionally waits for you to name the exact Management `auth.users` account.
