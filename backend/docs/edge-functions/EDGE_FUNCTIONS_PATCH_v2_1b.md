# Mood of Wood — MVP Pilot Edge Functions v2.1b Patch Notes + Test Checklist

Status: **BUILT, NOT DEPLOYED, NOT EXECUTED.** Nothing was run against the database beyond read-only inspection (confirmed current bucket state, current storage policies, current department/group/parent data) used to write this patch correctly.

---

## 1. What changed, by item number from your request

**1. staff-create-user — own_department_group scope fix.** The previous scope check only allowed (b) same non-null department_group_id or (c) a department whose `parent_department_id` is the caller's department. A caller whose own department has no `department_group_id` set (several departments in your live data have `department_group_id = null` — FACTORY, HR_ADMIN, INTERIOR, CONTROL_TOWER, PROCUREMENT, RND, B2B_B2G, CUST_SERVICE) would have incorrectly failed scope for creating a user in **their own department**, since a department is never its own group-mate or its own child. Fixed: `isExactOwnDepartment` is now checked first and independently.

**1. staff-create-user — Accounts role/department consistency (new).** Two new checks, both keyed off `is_confidential_domain` (confirmed only the `ACCOUNTS` department has this flag set in your live data):
- `cfo` / `accounts_head` / `accounts_employee` → rejected in any department where `is_confidential_domain = false`.
- `supervisor` / `employee` / `dept_head` → rejected in any department where `is_confidential_domain = true` (Phase-1 restriction, until the Accounts RPC/RLS layer is patched consistently for generic roles inside a confidential domain).

**1. staff-create-user — singleton roles.** `sysadmin` was already rejected (v2.1). Added: `management` is now rejected too — this pilot's one Management account exists only via `staff_bootstrap_management`, never through this endpoint.

**1. staff-create-user — strict employee_code pattern.** `^MOW-[A-Z0-9-]{1,32}$`, checked in `_shared/validation.ts` (`isValidEmployeeCode`) immediately after normalization and before the value is used in the `ilike` duplicate check or interpolated into the internal Auth email.

**1. staff-create-user — audit failure now rolls back.** Previously a `staff_audit_log` insert failure was logged and the response still returned 201 (a created-but-unaudited user). Now it calls the same `cleanupOrphanAuthUser()` used for every other post-creation failure and returns a server error — a successful response is only ever returned once exactly one `CREATE_USER` audit row exists.

**2. staff-file-url — bucket name hardcoded.** `STAFF_ATTACHMENTS_BUCKET` environment override removed; `BUCKET = "staff-attachments"` is now a literal constant, so it can never silently diverge from the bucket id hardcoded inside `staff_record_attachment()`.

**2. Storage SQL patch (`mvp_pilot_storage_patch_v2_1b.sql`), three parts:**
- Part 1: `storage.buckets` UPDATE — `file_size_limit = 20971520` (20 MB), `allowed_mime_types` set to an exact 17-entry list. Confirmed by read-only check that both were previously `NULL` (unrestricted at the Storage-service level, even though the Edge Function and `staff_record_attachment()` already checked size/MIME in application code — this adds a second, independent backstop).
- Part 2: `DROP POLICY IF EXISTS` on the two `storage.objects` policies from `mvp_pilot_storage_policies_v2_1a.sql` (`staff_attachments_insert_own_prefix`, `staff_attachments_select_own_prefix`). This is the one deliberate exception to this project's "no DROP POLICY" convention — explicitly requested, reversible (exact `CREATE POLICY` statements to restore them are preserved in a comment in the patch file).
- Part 3: `CREATE OR REPLACE FUNCTION staff_record_attachment(...)` — the only functional change is tightening the `image` MIME check from `mime_type LIKE 'image/%'` (which matched `image/svg+xml`) to the same exact 5-entry image list used everywhere else. Every other line of the function is byte-identical to v2.1.

**2. MIME whitelist mirrored in three places, kept in sync deliberately** (each file/statement says so in a comment): `storage.buckets.allowed_mime_types`, `staff_record_attachment()`'s check, and `validation.ts`'s `MIME_WHITELIST` / `ALL_APPROVED_MIME_TYPES`. SVG and any executable/script-capable MIME type (`text/html`, `application/javascript`, etc.) are absent from all three by construction — they were never added, not added-then-removed.

**2. "Signed uploads still work after the policies are removed" — why, not just "trust me."** `createSignedUploadUrl()` is called from `staff-file-url` using the **admin (service-role) client**, which bypasses `storage.objects` RLS entirely — same as it already did before this patch. The actual `PUT` to the returned signed URL is authorized by the signed token embedded in that URL (minted server-side), not by evaluating an `authenticated`-role RLS policy against the uploader's own session. Removing the direct `authenticated` INSERT/SELECT policies only removes the path a client could use to talk to `storage.objects` **directly** — it does not touch the signed-URL mechanism at all. This is stated here as the reasoning; **verifying it live is test T-Storage-1 below**, since nothing has been deployed yet for me to run it against.

**2. Download TTL clamped.** `clampDownloadTtlSeconds()` in `validation.ts` clamps `STAFF_SIGNED_URL_TTL_SECONDS` (or the 120s default) into `[30, 900]` seconds. Explicitly documented in both `validation.ts` and `staff-file-url/index.ts`: **upload** signed tokens (`createSignedUploadUrl`) are valid for a fixed ~2 hours set by the Storage service itself, not configurable here — only the **download** TTL is affected by this env var and this clamp.

**3. Deployment configuration.** `get_publishable_keys` shows this project's legacy `anon` JWT key is still present and enabled (`type: "legacy"`, `disabled: false`) alongside two newer `sb_publishable_...` keys — read as: this project has **not** fully migrated to asymmetric (ES256/RS256) JWT signing keys yet; it's still on the legacy shared-secret (HS256) signing key. This does not require any code change: all three authenticated functions verify tokens via `supabase.auth.getUser(token)`, a call to the Auth service itself, which validates the signature internally regardless of key type. `config.toml` sets `verify_jwt = false` for `staff-login` only, `true` (explicit, matching the platform default) for the other three.

**4. Tests** — full checklist below; the 9 you named are included plus a few directly-dependent ones.

---

## 2. Files in this patch

```
supabase/functions/_shared/validation.ts          (revised)
supabase/functions/_shared/messages.ts             (revised)
supabase/functions/staff-create-user/index.ts       (revised)
supabase/functions/staff-file-url/index.ts           (revised)
mvp_pilot_storage_patch_v2_1b.sql                     (new — not executed)
config.toml                                            (new — [functions.*] block to merge)
EDGE_FUNCTIONS_PATCH_v2_1b.md                           (this file)
```

`staff-login`, `staff-password-change`, and all other `_shared/*.ts` files are unchanged from the prior delivery.

---

## 3. Test checklist (your 9 required cases, plus directly-dependent ones)

### Your required cases

- [ ] **Standalone Department Head creates Employee in own department: success.** HOD whose department has `department_group_id = NULL` (e.g. FACTORY, HR_ADMIN, INTERIOR) creates an Employee with `department_id` = their own department → 201. (This is the exact case the v2.1a code would have wrongly rejected — confirms the fix.)
- [ ] **Same HOD outside authorized scope: rejected.** Same HOD attempts `department_id` = an unrelated department (not their own, not in their group, not their child) → 403 `outsideScope`.
- [ ] **Accounts-specific role in Retail: rejected.** Any caller authorized to create `accounts_employee`/`accounts_head`/`cfo` by `role_creation_rules` attempts `department_id` = RETAIL (or any non-confidential department) → 403 `accountsRoleRequiresAccountsDept`.
- [ ] **Generic employee/supervisor in Accounts during Phase 1: rejected.** Management (or Accounts Head, if `role_creation_rules` would otherwise permit it) attempts `role_code: "employee"` or `"supervisor"` with `department_id` = ACCOUNTS → 403 `genericRoleBlockedInAccounts`.
- [ ] **Forced audit failure: Auth user/profile/location all rolled back.** In a disposable/staging project, temporarily revoke the service role's INSERT on `staff_audit_log` (or drop a required column) to force the final insert to fail → confirm the response is 500, and confirm in `auth.users` / `user_profiles` / `user_location_access` that NO row for that attempted user exists in any of the three tables afterward.
- [ ] **Direct Storage upload/download without Edge Function: rejected.** After the SQL patch is applied: an authenticated client calling `supabase.storage.from('staff-attachments').upload(...)` or `.download(...)` directly (not through `staff-file-url`) → rejected by RLS in both directions (no policy exists at all anymore).
- [ ] **Deactivated user cannot directly read an old file.** A user who previously uploaded a file, then has `user_profiles.is_active` set to `false`: (a) via `staff-file-url` download → 403 `accountInactive` (existing profile-active check); (b) via direct `storage.objects` SELECT bypassing the Edge Function entirely → also rejected, and for a *different* reason than (a) — there is no direct SELECT policy for anyone anymore, active or not, closing the v2.1a gap where the old prefix-only policy let a deactivated uploader keep pulling their own historical files forever.
- [ ] **File over 20 MB: rejected by Storage itself.** `PUT` a body larger than 20 MB to a validly-minted signed upload URL → Storage rejects it independent of the Edge Function's own `MAX_FILE_BYTES` check (confirms the bucket-level `file_size_limit` backstop works, not just the application-level one).
- [ ] **SVG or disallowed MIME: rejected by Storage itself.** `PUT` an `image/svg+xml` (or `text/html`, `application/javascript`, etc.) file to a validly-minted signed upload URL → Storage rejects it independent of the Edge Function's `MIME_WHITELIST` check (the Edge Function already refuses to mint a signed URL for a disallowed MIME/file_type combination before this point — this test is for the case that first gate were ever bypassed).

### Directly-dependent cases worth adding alongside them

- [ ] `own_department_group` scope: HOD whose department HAS a `department_group_id` (e.g. RETAIL/FRANCHISE group, DISPATCH/GODOWN_INV group, ECOMMERCE/MARKETING group) creates a user in the *other* department of the same group → still 201 (confirms the (b) same-group path wasn't broken by the (a) fix).
- [ ] `own_department_group` scope, child-department case: a Retail-scoped HOD creates a user with `department_id` = CUST_SERVICE (whose `parent_department_id` is RETAIL) → still 201 (confirms the (c) child-department path wasn't broken either).
- [ ] `sysadmin` role_code → still 403 `sysadminDisabled` (unchanged from v2.1, confirm the new `management` check didn't accidentally shadow it).
- [ ] Accounts Head creates `accounts_employee` inside ACCOUNTS → still 201 (confirms the new role/department consistency checks don't conflict with the legitimate Accounts-internal case).
- [ ] `employee_code` that doesn't match `^MOW-[A-Z0-9-]{1,32}$` (e.g. `"DROP TABLE"`, `"mow_123"` with an underscore, `"MOW-" + "A".repeat(40)`) → 400 `invalidEmployeeCodeFormat`, and confirm no `ilike` query or Auth `createUser` call was even attempted (check logs show the rejection happens before any Supabase call for that request).
- [ ] Storage: signed upload flow end-to-end AFTER the SQL patch — call `staff-file-url` with `action: "upload"`, confirm 200 with a `signed_url`/`token`, then actually `PUT` a small valid file to it → succeeds (this is the live verification for "signed uploads still work" claimed above; do this test explicitly, don't assume it from the reasoning alone).
- [ ] Storage: signed download flow end-to-end after the patch — `staff-file-url` `action: "download"` for a file the caller has legitimate but non-uploader access to (e.g. their Department Head) → 200 with a working signed URL, confirming the removed direct-SELECT policy didn't break the sanctioned indirect path.
- [ ] `DOWNLOAD_TTL_SECONDS` clamp: set `STAFF_SIGNED_URL_TTL_SECONDS=5` (below the 30s floor) → function still returns a working URL with `expires_in_seconds: 30`, not `5`. Set it to `99999` → clamped to `900`, not `99999`.

---

## 4. Nothing else changed

`staff-login/index.ts` and `staff-password-change/index.ts` are unmodified from the prior delivery — not re-sent here, per your instruction to return only revised files. `_shared/cors.ts`, `_shared/response.ts`, and `_shared/clients.ts` are also unmodified.
