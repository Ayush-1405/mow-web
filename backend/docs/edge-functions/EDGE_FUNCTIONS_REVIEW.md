# Mood of Wood — MVP Pilot Edge Functions — Review Package

Status: **BUILT, NOT DEPLOYED.** No `supabase functions deploy` has been run. No secret has been set. No existing object touched.

Project: `bykmyttaesuyjwvtnxks` ("mood- of- wood- interior")

---

## 0. Confirmed: no existing Edge Function is overwritten

`list_edge_functions` was called against this project immediately before writing any code. Result: **zero Edge Functions currently deployed.** There is nothing to collide with — these four are the first Edge Functions this project will ever have. The `staff-` prefix is kept anyway, consistent with the `staff_*` / `staff-*` naming convention used everywhere else in this pilot, so any future Interior-dashboard function is guaranteed not to collide either.

---

## 1. File manifest

```
supabase/functions/
  _shared/
    cors.ts          — ALLOWED_ORIGINS-based CORS header builder + OPTIONS handler
    messages.ts       — bilingual (EN/GU) user-safe message catalogue
    response.ts        — errorResponse()/okResponse() JSON helpers
    clients.ts          — adminClient() / anonClient() / userScopedClient() / verifyCaller()
    validation.ts        — input validators shared by all four functions
  staff-login/
    index.ts              — public login endpoint
  staff-create-user/
    index.ts                — authenticated user-creation endpoint
  staff-password-change/
    index.ts                  — authenticated password-change endpoint
  staff-file-url/
    index.ts                    — authenticated signed upload/download URL endpoint
```

Nothing outside `supabase/functions/` was touched. No SQL file was modified in this task.

---

## 2. Environment variables

**Auto-injected by the Supabase Edge Runtime — do not set these manually, do not put them in `supabase secrets set`:**

| Variable | Used by |
|---|---|
| `SUPABASE_URL` | all four |
| `SUPABASE_ANON_KEY` | all four (anon/user-scoped clients) |
| `SUPABASE_SERVICE_ROLE_KEY` | all four (`adminClient()` only, in `_shared/clients.ts`) |

**Must be set explicitly before deploying** (`supabase secrets set ...`):

| Variable | Purpose | Example |
|---|---|---|
| `ALLOWED_ORIGINS` | Comma-separated exact origins allowed to call these functions from a browser | `https://staff.moodofwood.app,http://localhost:5173` |
| `STAFF_INTERNAL_EMAIL_DOMAIN` | Domain used to build the synthetic internal Auth email (`staff-create-user` only) | `staff.moodofwood.internal` |

**Optional, has a safe default if omitted:**

| Variable | Default | Purpose |
|---|---|---|
| `STAFF_ATTACHMENTS_BUCKET` | `staff-attachments` | Storage bucket name (`staff-file-url` only) — default already matches the bucket created in `mvp_pilot_storage_policies_v2_1a.sql` |
| `STAFF_SIGNED_URL_TTL_SECONDS` | `120` | Download signed-URL lifetime in seconds (`staff-file-url` only). Note: Supabase's `createSignedUploadUrl` does not accept a custom TTL — its expiry is fixed by the Storage service itself, not configurable per call. |

---

## 3. Deployment commands (DO NOT RUN — pending your explicit approval)

```bash
# One-time, before the first deploy:
supabase link --project-ref bykmyttaesuyjwvtnxks

supabase secrets set ALLOWED_ORIGINS="https://staff.moodofwood.app,http://localhost:5173" \
  --project-ref bykmyttaesuyjwvtnxks
supabase secrets set STAFF_INTERNAL_EMAIL_DOMAIN="staff.moodofwood.internal" \
  --project-ref bykmyttaesuyjwvtnxks

# staff-login is public — no caller token exists yet, so JWT verification
# must be disabled for THIS function only:
supabase functions deploy staff-login \
  --project-ref bykmyttaesuyjwvtnxks --no-verify-jwt

# The other three are authenticated — keep the platform's default JWT
# verification ON as defense-in-depth, in addition to this code's own
# explicit auth.getUser() check:
supabase functions deploy staff-create-user   --project-ref bykmyttaesuyjwvtnxks
supabase functions deploy staff-password-change --project-ref bykmyttaesuyjwvtnxks
supabase functions deploy staff-file-url        --project-ref bykmyttaesuyjwvtnxks
```

---

## 4. Local test commands (dummy placeholders — replace before running)

```bash
# Serve locally first:
supabase functions serve --env-file ./supabase/.env.local --no-verify-jwt

# --- staff-login ---
curl -i -X POST http://localhost:54321/functions/v1/staff-login \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:5173" \
  -d '{"employee_code":"MOW-MGMT-001","password":"<dummy-password>"}'

# --- staff-create-user (needs a real access_token from a prior staff-login) ---
curl -i -X POST http://localhost:54321/functions/v1/staff-create-user \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <dummy-access-token>" \
  -H "Origin: http://localhost:5173" \
  -d '{
    "employee_code": "MOW-RET-010",
    "full_name": "Test Employee",
    "phone": "9998765432",
    "role_code": "employee",
    "department_id": "<dummy-department-uuid>",
    "home_location_id": "<dummy-location-uuid>",
    "temporary_password": "TempPass123"
  }'

# --- staff-password-change ---
curl -i -X POST http://localhost:54321/functions/v1/staff-password-change \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <dummy-access-token>" \
  -H "Origin: http://localhost:5173" \
  -d '{"new_password":"NewPass123"}'

# --- staff-file-url (upload) ---
curl -i -X POST http://localhost:54321/functions/v1/staff-file-url \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <dummy-access-token>" \
  -H "Origin: http://localhost:5173" \
  -d '{
    "action": "upload",
    "entity_type": "task",
    "entity_id": "<dummy-task-uuid>",
    "filename": "site-photo.jpg",
    "mime_type": "image/jpeg",
    "file_type": "image",
    "file_size": 204800
  }'

# --- staff-file-url (download) ---
curl -i -X POST http://localhost:54321/functions/v1/staff-file-url \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <dummy-access-token>" \
  -H "Origin: http://localhost:5173" \
  -d '{"action":"download","attachment_id":"<dummy-attachment-uuid>"}'
```

---

## 5. Positive / negative test checklist

### staff-login
- [ ] Correct employee_code + correct password → 200, exactly `access_token`/`refresh_token`/`expires_in`/`must_change_password`, no email field anywhere in the body.
- [ ] Correct employee_code, `must_change_password = true` in DB → 200, `must_change_password: true` returned (login still succeeds).
- [ ] Wrong password → 401, generic bilingual message.
- [ ] Unknown employee_code → 401, **same** generic bilingual message (not distinguishable from wrong password).
- [ ] Inactive user, correct password → 401, same generic message.
- [ ] Lowercase / padded employee_code (` mow-mgmt-001 `) → normalized and still succeeds.
- [ ] 5 failed attempts within 15 minutes for one employee_code → 6th attempt (even with the correct password) → 429 rate-limit message, not the invalid-login message.
- [ ] After the 15-minute window passes (or in a test DB, after backdating `attempted_at`) → attempts allowed again.
- [ ] `login_attempts` gets one row per attempt, `success` set correctly, no password ever written to that table.
- [ ] Missing `employee_code` or `password` in body → 400.
- [ ] OPTIONS request from an allowed origin → 204 with `Access-Control-Allow-Origin` echoed.
- [ ] OPTIONS / POST from a non-listed origin → response has no `Access-Control-Allow-Origin` header.

### staff-create-user
- [ ] Management creates an Employee in any active, non-confidential department → 201, response has only `id`/`employee_code`/`full_name`/`role`/`department` — no email, no password anywhere.
- [ ] Department Head creates a Supervisor/Employee inside their own department-group scope → 201.
- [ ] Department Head attempts to create a user in a department **outside** their scope → 403 `outsideScope`.
- [ ] Accounts Head creates an Accounts Employee inside Accounts → 201.
- [ ] Accounts Head attempts to create a user in a non-Accounts department → 403 (no matching `role_creation_rules` row for that scope, or outside-scope, depending on which check trips first).
- [ ] Any caller attempts `role_code: "sysadmin"` → 403 `sysadminDisabled`, before any Auth user is created.
- [ ] Any caller attempts a role combination whose `role_creation_rules` row has `requires_management_approval = true` → 403 `approvalNotAvailable`.
- [ ] Duplicate `employee_code` (any casing) → 409, no new Auth user left behind (verify in `auth.users` after the call).
- [ ] Weak `temporary_password` (e.g. `"short1"`, `"alllowercase1"`, `"NODIGITSHERE"`) → 400 `weakPassword`, no Auth user created.
- [ ] Invalid `department_id` / `home_location_id` (random UUID) → 400, no Auth user created.
- [ ] **Force a downstream failure** (e.g. temporarily point `department_id` at a department that gets deleted between the check and the insert, or simulate by revoking `user_location_access` insert grant in a disposable test project) → confirm the Auth user created moments earlier no longer exists in `auth.users` afterward (rollback verified).
- [ ] Caller whose own `must_change_password = true` attempts to create a user → 403 `mustChangePassword`, before any lookup of the target role.
- [ ] Inactive caller (valid token, but `is_active = false` in `user_profiles`) → 403 `accountInactive`.
- [ ] `staff_audit_log` gets exactly one `CREATE_USER` row per successful creation, `performed_by` = the verified caller's id (never anything from the request body).
- [ ] Response body never contains `email` or `temporary_password` in any successful or failed case — confirm by grepping the raw HTTP response.
- [ ] Server logs (`supabase functions logs staff-create-user`) never contain the plaintext `temporary_password` or `phone` value — confirm by grepping captured logs after a test run.

### staff-password-change
- [ ] Valid token + strong new password → 200 success.
- [ ] After success, a subsequent `staff-login` with the OLD password fails, and with the NEW password succeeds.
- [ ] After success, `must_change_password` is `false` for that user in `user_profiles` (and a follow-up `staff-login` for that user returns `must_change_password: false`).
- [ ] Weak new password (missing uppercase / lowercase / digit / <8 chars) → 400, Auth password unchanged (confirm old password still works).
- [ ] Missing/expired/malformed Bearer token → 401, no Auth admin call attempted.
- [ ] Inactive caller → 403 `accountInactive`, no Auth admin call attempted.
- [ ] Attempt to smuggle a `user_id` or `p_user_id` field in the body pointing at a DIFFERENT user → confirm it changes nothing (the code never reads that field) — the caller's OWN password is the only one ever touched.
- [ ] Calling the endpoint twice in a row with the same new password → both succeed (RPC is idempotent), no error on the second call.

### staff-file-url
- [ ] Upload: caller with genuine access to the task/bridge, valid image/pdf/word/excel MIME + matching `file_type`, size under 20 MB → 200, `storage_path` begins with `<caller-uid>/`.
- [ ] Upload: `file_type: "voice"` → 400 `voiceDisabled`, regardless of MIME type supplied.
- [ ] Upload: MIME type that doesn't match the declared `file_type` (e.g. `file_type: "pdf"`, `mime_type: "image/png"`) → 400 `fileTypeNotAllowed`.
- [ ] Upload: `file_size` over 20 MB → 400 `fileTooLarge`.
- [ ] Upload: caller has NO access to the given `entity_id` (not assigned, not HOD in scope, not management) → 403 `noAccessToParent`, no signed URL minted.
- [ ] Upload: `entity_id` for a task/bridge that doesn't exist at all → same 403 (indistinguishable from "no access").
- [ ] Upload: drawing `file_type` with an approved CAD MIME type (e.g. `application/dxf`) → 200.
- [ ] Upload → then actually PUT the file to the returned `signed_url`/`token` → then call `staff_record_attachment(...)` directly from a test client using the SAME storage_path and matching size/mime → succeeds and records the attachment (confirms the two-step contract works end-to-end).
- [ ] Download: caller is the uploader → 200, signed URL returned.
- [ ] Download: caller is NOT the uploader but has legitimate task/bridge access (HOD in scope, verifier, management) → 200, signed URL returned (this is the case a bare `storage.objects` policy could never grant).
- [ ] Download: caller has no relationship to the attachment at all → 404 `attachmentNotFound` (RLS-filtered, not a permission-denied leak).
- [ ] Download: `attachment_id` for a confidential-department attachment, caller is a non-Accounts, non-management role → 404 (RLS excludes it, same as above).
- [ ] Download: signed URL expires after `STAFF_SIGNED_URL_TTL_SECONDS` — confirm a request against it after expiry fails.
- [ ] Malformed/missing `action` field → 400 `invalidAction`.

---

## 6. Security checklist (self-review before you approve deployment)

- [x] `SUPABASE_SERVICE_ROLE_KEY` is read in exactly one file (`_shared/clients.ts`), used only to construct `adminClient()`, and is never included in any response body, header, or `console.log`.
- [x] Every authenticated function extracts the Bearer token and calls `supabase.auth.getUser(token)` to get a server-verified user id — no function ever reads a `user_id`/`p_user_id`/role/department field from the request body and trusts it as the caller's identity.
- [x] `staff-password-change` passes only `verifiedUser.id` to `updateUserById` and to `staff_complete_password_change` — a `user_id` field in the body, if present, is never read.
- [x] `staff-create-user` derives the caller's role and department exclusively from their own `user_profiles` row (looked up by the verified id), never from the request body.
- [x] `staff-login` returns the same generic bilingual message for unknown employee_code, inactive account, and wrong password — verified by code inspection (all three paths call `errorResponse(401, MSG.invalidLogin, origin)`).
- [x] `staff-login` never returns `email`, a full session object, or a full user object — only the four named fields.
- [x] Rate limiting is checked BEFORE any Auth call is attempted for that request, using a sliding 15-minute window keyed on the normalized `employee_code`.
- [x] `resolve_employee_login`, `staff_complete_password_change`, and `staff_bootstrap_management` are all confirmed (via `information_schema.routine_privileges`) to be `EXECUTE`-granted to `service_role` only, not `authenticated` — matching that they are called exclusively via `adminClient()` in this code, never via a user-scoped client.
- [x] `staff_write_audit()` is confirmed granted to `postgres` only (not even `service_role`) — this code does NOT attempt to call it directly; `staff-create-user` instead inserts into `staff_audit_log` directly via the admin client, with `performed_by` always set to the verified caller id.
- [x] `staff-file-url` never accepts a storage path from the client for download — it always resolves `attachment_id` → `storage_path` server-side, through the caller's own RLS-scoped client.
- [x] `staff-file-url` upload path is always `<verified-auth-uid>/<uuid>-<sanitized-filename>` — the caller cannot control the prefix, only the filename tail, and the filename is sanitized to `[a-zA-Z0-9._-]`.
- [x] `staff-file-url` parent-access and attachment-access checks both go through `userScopedClient(token)` (RLS-gated), never through the admin client — the admin client is used only for the signed-URL minting step itself, after access is already confirmed.
- [x] MIME/size whitelist in `_shared/validation.ts` is a deliberate mirror of the whitelist enforced inside `staff_record_attachment()` in the database — documented in a comment so the two are kept in sync if either changes.
- [x] No function logs a password, a token, a phone number, or a full request body. Every `console.error` call logs a fixed string plus, at most, `error.message` from a Supabase client error object — never the destructured request fields that hold secrets.
- [x] `staff-create-user` rejects `role_code: "sysadmin"` outright, and separately rejects any `role_creation_rules` row with `requires_management_approval = true` — confirmed against the live `role_creation_rules` data that every such row currently has `sysadmin` as the CREATOR role, so both checks jointly disable the entire unimplemented approval workflow.
- [x] `staff-create-user` rollback relies on a verified `ON DELETE CASCADE` chain (`auth.users` → `user_profiles` → `user_location_access`, confirmed via `pg_constraint` before writing the code) — a single `deleteUser()` call after any post-Auth-creation failure is sufficient; there is no code path that leaves an orphaned profile or location-access row.
- [x] CORS: an origin not present in `ALLOWED_ORIGINS` receives no `Access-Control-Allow-Origin` header at all (not a wildcard `*`, not an echo of the request's `Origin`).
- [x] None of these four files import, reference, or modify `public.profiles`, `public.tasks`, `public.attachments`, `public.audit_log`, or any other pre-existing Interior-dashboard object.
- [x] `list_edge_functions` returned zero existing functions before this work started — nothing here overwrites a prior deployment.

### Open items for your decision (not blockers, flagged for explicit sign-off)

1. **Temporary password source.** `staff-create-user` accepts `temporary_password` from the (already-authorized) admin caller's request body, validated for strength, and never returns or logs it. This means the creating admin sets the new employee's first password directly — a common pattern, but I did not see it specified explicitly in your requirements, so flagging the choice rather than assuming it silently. If you'd prefer the function to generate the temporary password server-side instead (and hand it back once, or push it out-of-band), tell me and I'll change this one function.
2. **`staff_complete_password_change` has no internal `auth.uid()` check** — it trusts whatever `p_user_id` it's given (confirmed by reading its source). This Edge Function never passes anything but the verified caller's own id, so it's safe as used here, but the underlying RPC itself is a standing privilege gap if it's ever called from anywhere else (e.g. directly from a browser, since it's granted to `service_role` only — actually not directly callable by a browser at all, only from server-side code with the service key, so real-world exposure is low). Flagging for awareness, not proposing a change to already-executed SQL without your instruction.
3. **`createSignedUploadUrl`'s expiry is not configurable per-call** in the Supabase Storage API as of this writing — only the download path (`createSignedUrl`) honors `STAFF_SIGNED_URL_TTL_SECONDS`. If a shorter upload-URL lifetime matters to you, that would need to be enforced by a Storage-level setting rather than this code.
