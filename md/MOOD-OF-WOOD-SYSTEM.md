# Mood Of Wood — Interior Project Management System

Context, workflow and design.
Last updated 4 November 2026.

> **Picking up the work? Start at [section 12](#12-where-work-stands--start-here).**
> Sections 1–8 still describe the Interior workflow as first designed in
> August 2026. Sections 9 and 10 were brought up to date in November 2026:
> the app is no longer one `index.html` file but a React app covering
> several departments.

---

## 1. Why this exists

Mood Of Wood is a furniture and interior company in Gujarat, established 1999,
now in its second generation. This system serves the **Interior Department**
only — a ten-person team.

The problems it was built to solve, in the order they were stated:

1. Projects finishing late
2. Weak customer communication
3. Unclear responsibility — nobody sure whose move it is
4. Poor coordination between designer, PM, purchase and execution
5. Too much dependence on WhatsApp and verbal instruction

The design rule behind every screen: **anyone opening the dashboard should
understand what they have to do next.** The team should need about fifteen
minutes of training, not a manual. It is deliberately not an ERP.

### The team

| Role | People | What the system asks of them |
|---|---|---|
| Director | 2 | Watch, decide, manage users |
| Interior Department Head | 1 | Operational control of the department |
| Project Manager | 1 | Keep every project moving; the control tower |
| 3D Designer | 4 | Design work through to freeze |
| Execution / Site | 2 | Daily site reports, installation |
| Purchase | 1 | Material from request to delivery |
| CRM | 1 | Customer follow-up and feedback |

---

## 2. The project workflow

Thirteen stages, unchanged since the first build:

```
Quotation → Deal Closed → Kick-off → Design → Client Approval →
Design Freeze → Execution Planning → Purchase/Production →
Execution → QC → Snagging → Handover → Completed
```

### Rules the system enforces

These are not suggestions — the app refuses the action.

- **No design approval → no design freeze.** All four checks (final 3D,
  drawing, specifications, customer approval) must be ticked.
- **No design freeze → no execution release.** A project cannot move to
  Execution or beyond until it is frozen.
- **Open major snag → no project closure.**
- **Pending change request → no stage advance.**
- **Every project has one PM, one designer, one deadline, one stage,
  one next step.** The new-project form refuses to save without them.

### Who owns which move

```
Execution / Designer:  "I need this material."
        ↓
Purchase:              "I will arrange it."
        ↓
PM:                    "I can see whether it is coming."
        ↓
Director / Head:       "I can see where material is holding a project up."
```

Execution never manages purchase status. Purchase never edits the site report.

---

## 3. Where the data lives

### Supabase (shared by everyone, every device)

| Table | Holds | Notes |
|---|---|---|
| `auth.users` | Logins | Managed by Supabase Auth |
| `public.profiles` | Name, role, department, email, phone, active | `auth_id` → `auth.users.id`. Some older rows keep the UID in `profiles.id` with `auth_id` empty; the app accepts both |
| `public.projects` | The project record | See mapping below |
| `public.site_reports` | Daily site updates | Added August 2026 |
| `public.project_materials` | The purchase workflow | Added August 2026 |
| `public.audit_log` | Admin actions | Who created a user, changed a role, set a password |

**`projects` column mapping** — the dashboard's field names on the left:

```
id           → project_code          value      → project_value
customer     → customer              due        → deadline
location     → location              pendingFrom→ pending_from
pm/designer/execution → pm, designer, execution        (names, kept for history)
pmId/designerId/executionId → project_manager_id, designer_id, execution_id
                                     ← these are the real link, to profiles.id
stage        → stage                 nextAction → next_action
archived     → archived              lastUpdate → last_update
                                     status     → status (computed on save)
```

**`site_reports`**: `project_id`, `report_date`, `work_today`, `work_done`,
`work_pending`, `material`, `issue`, `tomorrow_plan`, `remarks`, `status`,
`submitted_by` (→ `profiles.id`), `created_at`.

**`project_materials`**: `project_id`, `material`, `status`, `required_by`,
`remark`, `source` (`purchase` or `daily-update`), `site_report_id`,
`requested_by` (→ `profiles.id`), `created_at`, `updated_at`.
Unique index on `(site_report_id, material)` — this is what makes duplicate
material requests impossible.

### Still on the device only

These have no table yet. They are kept in the browser and re-attached to each
project by `project_code` after every reload, and they are never uploaded,
rewritten or deleted automatically:

> tasks (pending items) · snags · change requests · design freeze state and
> checklist · handover checklist · customer feedback · customer requests and
> complaints · attachments · activity log · project start date · remarks ·
> next customer update date

Anything device-only is labelled **"on this device"** wherever it appears, so
nobody mistakes it for shared data.

**To share those too**, the tables would be: `project_tasks`,
`project_snags`, `project_changes`, `project_files`, plus columns on
`projects` for `start_date`, `remarks`, `frozen`, `freeze_date`,
`freeze_checks`, `next_update`, `handover`, `feedback`.

---

## 4. What each role sees

Everyone lands on their own page. Nobody chooses a role — it comes from
`profiles.role`.

**Director / Interior Department Head** — the whole department. Overview with
eight KPI cards, Control Tower, all projects, design, execution, daily
reports, purchase, customers, reports, team workload, alerts, activity log,
Settings (user management), data backup.

**Project Manager** — Control Tower first. Everything is scoped to projects
where `project_manager_id` matches their `profiles.id`: the KPI cards, the
lists below them, Needs attention, and the menu badge. A PM cannot see another
PM's projects.

**3D Designer** — only projects where they are the designer. Design work,
their tasks, approvals pending, design freeze.

**Execution** — only their assigned sites. Today's sites, tasks, daily report,
snags.

**Purchase** — the material list across all running projects, which is their
job. Five status cards and the attention list.

**CRM** — customers, follow-ups, approvals, feedback.

### Permissions

| Action | Director | Head | PM | Designer | Execution | Purchase | CRM |
|---|---|---|---|---|---|---|---|
| See all projects | ✔ | ✔ | own | assigned | assigned | for material | ✔ |
| See project value | ✔ | ✔ | ✔ | — | — | — | ✔ |
| Create / edit project | ✔ | ✔ | ✔ | — | — | — | — |
| Delete project | ✔ | ✔ | — | — | — | — | — |
| Archive project | ✔ | ✔ | ✔ | — | — | — | — |
| File a site report | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Ask for material | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Change material status | ✔ | ✔ | — | — | — | ✔ | — |
| Create users / set passwords | ✔ | ✔ | — | — | — | — | — |
| Make someone a Director | ✔ | — | — | — | — | — | — |

Three layers enforce this, not one: the screen hides what you cannot do, the
serverless function re-checks your role on the server, and the database
policies check again. Hiding a button was never treated as security.

---

## 5. The daily site update

The most-used screen in the system. Designed so a site person finishes it in
under a minute on a phone.

```
1. Today's work        role-wise searchable multi-select, chips, Other…
2. Work completed      ONLY what was ticked in Today's work
3. Work pending        calculated: today − completed. Read-only.
4. Material required?  Yes / No.  Yes → 18-item picker + one remark
5. Any issue?          Yes / No.  Yes → one short box
6. Tomorrow's plan     multi-select from the role's Next Step list
7. Remarks             optional
   + the project's Next step, Status, Send update
```

Untick something in Today's work and it vanishes from Work completed and
returns to pending, immediately. If everything is completed, pending saves as
`None`.

Answering **Material required? = Yes** files the request to Purchase at the
same moment — see section 6.

Reports are shared through `site_reports`. If Supabase refuses the insert, the
update is not quietly kept on the device: an error appears and the form stays
open.

### Activity catalogues (site reports)

Fixed wording, one spelling per activity, so reports stay comparable.

- **Designer** — 15 activities, site measurement through design freeze
- **PM** — 17, project kickoff through payment follow-up
- **Execution** — 24, including Carpenter Coordination and Payment Follow-up
- **Purchase** — 15, including Factory Coordination
- **CRM** — 6: customer call, quotation / design / client approval follow-up,
  feedback collection, Google review follow-up
- **Director / Head** — 12 management activities

The **Next Step** catalogue is separate and larger (designer 18, PM 18,
execution 24, purchase 17, CRM 14, management 14). Changing one never changes
the other.

---

## 6. The purchase workflow

```
Daily update: Material required? = Yes, tick Plywood + Laminate
        ↓  (automatic, at the moment the report is sent)
project_materials:  NEW REQUEST · Plywood  · Pending to Order · asked by …
                    NEW REQUEST · Laminate · Pending to Order · asked by …
        ↓  Purchase moves each line
Pending to Order → Ordered → In Transit → Received
                 (also: Delayed, Not Required)
```

Purchase never retypes a request. Re-sending or reloading a report cannot
create a second row — the database refuses it.

The Purchase page: five clickable cards (Pending to Order, Ordered, In
Transit, Delayed, Received) filtering the list, and a **Needs attention**
block in priority order — New request, Pending to order, Required within two
days, Delayed.

Material entry is a dropdown of 18 materials with an Other box. Project,
Material, Status, Required by, optional Remark. Deliberately no thickness,
quantity, unit or brand.

---

## 7. Attention, health and My Today

**My Today** — an extra card at the top of each role's page: carry-over work
from their last site report, overdue tasks, tasks due today, and today's sites
for site staff. Also a page of its own on mobile.

**Needs attention** — sentences, not numbers:

```
Ashwin Suthar — 2 activities pending: Carcass Installation, Site Cleaning
No site update for 3 working days
Material pending: Hettich hinges
New material request: Plywood (asked by Ashwin Suthar)
Client approval pending
Overdue task: Reception counter polish (Mahesh Rathod)
```

Every row opens its project. For a PM the list is built only from their own
projects.

**No update warning** — working days since the last site report, **Sundays
excluded**, warning at two or more. (One constant to change if sites work
Sundays.)

**Project health** — three words, no score shown:

| | When |
|---|---|
| 🔴 Delayed | deadline passed, major snag open, or material overdue |
| 🟠 Attention needed | due within 7 days, overdue tasks, pending work, no update for 2+ working days, awaiting client approval |
| 🟢 On track | none of the above |

The reasons are written out underneath on the project page.

---

## 8. Design

**Deliberately plain.** Cool pale grey-green background, white cards, deep
green accent, brass for highlights. Serif nowhere — Archivo for headings,
system sans for text, IBM Plex Mono for IDs, dates and numbers so codes and
deadlines are scannable.

**The one flourish**: the project stage bar is drawn as a measuring tape —
tick marks, a filled section, a brass pin at the current stage. A furniture
maker's instrument, and it reads at a glance.

**Status colours** are consistent everywhere: green on track, amber at risk,
red delayed, blue completed.

### Mobile

Same application, same data, same permissions — only the layout changes below
760px.

- No sideways scrolling anywhere
- Tables stack into cards, one row per card, column heading in front of each
  value; secondary columns hidden, tap the card to open the project
- Touch targets 44px minimum, most 50px+
- Form text 16px so iOS does not zoom on tap
- Daily update fills the screen, Send update pinned to the bottom
- Bottom bar, the same five for every role:
  **Home · My Today · Projects · Updates · More**
  More holds the rest of that person's menu, and Log out

---

## 9. How it is built and deployed

*Rewritten November 2026. The single-file `index.html` app described here
before has been replaced.*

A React 18 single-page app built with Vite 5, installable as a phone app
(PWA), on top of one Supabase project (Postgres with Row Level Security,
Auth, Storage, Realtime and Edge Functions). It covers several departments,
not just Interior: Factory, Retail, Godown, Dispatch, Interior, Chat and the
management screens.

```
frontend/                         the app
  src/App.jsx                     sign-in, start-up loading and every route
  src/screens/                    shared screens (Today's Tasks, Assign Task, ...)
  src/screens/<department>/       factory, retail, godown, dispatch, interior, chat
  src/lib/                        Supabase client, access rules, translations, helpers
  src/sw.js                       service worker (offline shell, push notifications)
  tests/                          unit tests, run with `npm test`
  .env                            Supabase settings, committed, points at the LIVE project
  .env.production                 production overrides (only the app origin)
backend/supabase/
  migrations/                     162 SQL migrations
  functions/                      11 Edge Functions (staff-login, staff-create-user, send-push, AI helpers, ...)
  tests/                          SQL tests (access matrix, retail flows, ...)
  config.toml                     project ref bykmyttaesuyjwvtnxks
backend/api/                      Vercel functions (health check); see the warning below
backend/docs/                     architecture blueprint and pilot plans
package.json, vercel.json         Vercel build settings at the repository root
.github/workflows/frontend-ci.yml lint and build on every frontend change (Node 20)
```

**Security**: the browser holds only the publishable (anon) key, which is
meant to be public. The real boundary is Row Level Security and the database
functions, which check the caller's own role. Staff sign in through the
`staff-login` Edge Function. Hiding buttons in the app is for convenience,
never for security.

**Deployment**: Vercel builds from the repository root using `vercel.json`.
It runs `npm run vercel-build`, which builds `frontend/` and serves
`frontend/dist`. `index.html` and `sw.js` are sent uncached so a new release
reaches phones; everything in `/assets` is cached for a year. CI runs lint
and build on every push to `main` that touches `frontend/`.

**Warning, still open**: `backend/api` is not found by Vercel's function
builder, which only looks for `api/` at the repository root. The note in the
root `package.json` explains this. Fix it before relying on those functions
in production.

---

## 10. Known limits, honestly

*Status checked against the code in November 2026. Items 1, 2 and 4 are
resolved. Items 3, 5 and 6 have not been re-checked.*

1. ~~Tasks, snags, change requests, attachments and the freeze checklist are
   still device-only.~~ **Resolved:** tasks and snags now live in Supabase
   (`staff_tasks`, `tasks`, `snags`) and are shared by everyone.
2. ~~Attachments hold metadata only.~~ **Resolved:** files are stored in
   Supabase Storage (the `interior-attachments` bucket).
3. **No customer email automation.** Planned, then deliberately deferred;
   it needs Resend plus DNS records on moodofwood.in.
4. ~~No live updates.~~ **Resolved:** screens subscribe to Supabase Realtime
   and update by themselves.
5. **Roles are fixed in code.** Adding "Senior Designer" means a small code
   change, not a settings screen. This was a deliberate trade — making roles
   dynamic means rewriting every permission check.
6. **Historical site reports and materials typed before the shared tables
   existed** remain on the device that typed them.

---

## 11. Suggested order of work from here

*Written in August 2026 for the Interior module; items 2 and 3 are done. For
the current next steps, see section 12.*

1. **Use it.** Two weeks of real projects with the whole team before building
   anything else. Several features on the wish list will look different
   afterwards, and some will not matter.
2. **Move tasks and snags to Supabase** — the biggest remaining shared-data
   gap, and the same pattern as site reports and materials.
3. **Supabase Storage**, so drawings and site photos are real files.
4. **Customer emails**, once the DNS for moodofwood.in is available.
5. **Dynamic roles — only if a genuinely new role appears.**

The system is only worth what people put into it daily. The morning routine
matters more than the next feature: PM in the Control Tower before any calls,
site team filing before they leave site, and one rule for everyone —
*if it is not in the dashboard, it did not happen.*

---

## 12. Where work stands — start here

*Written 4 November 2026, at the end of a performance pass.*

### Running it on the Windows machine

The repository is at `D:\staff pilot\mow-web`.

```powershell
cd "D:\staff pilot\mow-web\frontend"
npm.cmd ci          # first time, or after package-lock.json changes
npm.cmd run dev     # http://localhost:5173
npm.cmd test        # unit tests
npm.cmd run lint
npm.cmd run build
```

- Use `npm.cmd`, not `npm`: PowerShell's execution policy blocks `npm.ps1`
  on this machine. Running
  `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`
  once fixes that permanently.
- Git was installed on 2 November 2026 (version 2.56). A terminal opened
  before then won't find `git` until it is restarted.
- This machine has Node 26, but CI uses Node 20. Both pass today.
- **Local development uses the live database.** `frontend/.env` points at
  the same Supabase project as production, so anything you do after signing
  in on `localhost` changes real data.

### The performance branch: `perf/smoothness`

One commit, `d3126ea`, on top of `main` (`5b85307`). It exists **only on
this machine**: it has not been pushed, merged or deployed.

What it changes:

1. **Today's Tasks**: each task card redraws only when its own data changes.
   Before, every keystroke in the search box or a reason field rebuilt all
   300 cards.
2. **Refetches keep unchanged data as-is** (`frontend/src/lib/stableData.js`,
   with tests), so a refresh that finds nothing new causes no redraw.
3. **Today's Tasks loading**: a card's details arrive together instead of
   popping in. An older, slower request can no longer overwrite a newer list.
4. **Returning to the app**: an unchanged profile no longer redraws the whole
   app or restarts its live connections. From reading the code, this should
   also stop a manual language switch resetting when you come back. That
   hasn't been tested.
5. **Background refresh on return** (`useForegroundRefresh`): at most once
   every 15 seconds. Coming back online always refreshes.
6. **Start-up**: profile and lookup data load in parallel, and the unread
   badge no longer holds up the first screen.
7. **Moving between screens**: the current screen stays up until the next one
   is ready, instead of flashing a skeleton.
8. **Five Interior screens** (Head Dashboard, Activity History, All Files,
   Master Report, Timeline) no longer flash a skeleton on background
   refreshes. Switching project still shows one.

Measured on a local copy of the app against a fake API, with 300 tasks and
Chrome slowed to about the speed of a mid-range phone:

| Action | Before | After |
|---|---|---|
| Each keystroke in search | 170–250 ms | 43–56 ms |
| Each keystroke in a reason box | 150–245 ms | 43–54 ms |
| Returning to the app within 15 seconds | 250–340 ms, 8 requests | about 10 ms, 0 requests |
| Returning after 15 seconds, nothing changed | 250–375 ms, 8 requests | 41–61 ms, 8 requests |
| Start-up until tasks appear | 2.1–2.3 s | 2.0–2.9 s, no real gain |

The benchmark also checked that changed server data still reaches the right
card, panels open and switch correctly, and navigation works with no page
errors. Its script is outside the repository, in a temporary folder that
Windows may clear:
`C:\Users\ayush\AppData\Local\Temp\claude\d--staff-pilot\2e96bfd6-1cd4-4820-af9e-af619fbd1106\scratchpad\bench\bench.mjs`

**Tradeoff**: live updates still arrive instantly, but a screen with no live
subscription can now be up to 15 seconds stale after you switch back to the
app.

### Next steps, in order

1. **Test the branch with real use**, signed in with a real account, ideally
   on a phone. None of this has been tried on a real account, with real live
   updates, on a phone, or on the five Interior screens. Check:
   - Typing in the Today's Tasks search box
   - Opening Return / Hold / Reopen on a card
   - Accept, Start, Complete and Reassign
   - Switching between task lists
   - Opening each of the five Interior screens and switching project
   - Leaving the app and coming back

   Remember this is the live database (see above).
2. **Merge it**: `git push -u origin perf/smoothness`, open a pull request,
   let CI pass, then merge to `main`.
3. **Set up a separate database for development and testing.** It is for
   safety, not speed. The options are a Supabase branch or a second project
   (either may cost money), or a local copy with `supabase start` (needs
   Docker and the Supabase CLI, neither installed yet). Then point
   `frontend/.env` at it, keep the live values in `.env.production` or
   Vercel's settings, and stop committing `frontend/.env`.
4. **Database speed.** No database changes have been made. Start with the
   Supabase dashboard's Performance Advisor, which only reads. The main
   suspect is the access rules: in the migrations, only 5 of the 97 `CREATE
   POLICY` statements that use `auth.uid()` use the faster
   `(select auth.uid())` form, though later migrations may have replaced
   some. Test any change on the development database first.
5. **Start-up time.** The main JavaScript file is about 264 KB, and probably
   includes all the English and Gujarati text (`src/lib/i18n.js`, 165 KB).
   This is the likely cause, but it hasn't been confirmed.
6. **Package security warnings** in code that ships to users (`npm audit
   --omit=dev`):
   - `xlsx`: high (prototype pollution, ReDoS), no fix available. It matters
     most if users upload spreadsheets.
   - `react-router-dom`: moderate. The fix means moving to v7, which is a
     breaking change.
7. **Move `backend/api` to a root `api/` folder** (see section 9) if those
   functions are needed in production.

### Ruled out, so you don't repeat it

- **`content-visibility: auto` on task cards** would speed up long lists, but
  it clips each card's "More" dropdown (`ActionMenu`), which is positioned
  inside the card.
- **Changing database (MySQL, MongoDB and so on)**: Supabase/PostgreSQL suits
  this app's linked data, transactions and access rules. A move would mean
  rewriting most of the backend, with no real gain for users.

### Baseline before you start

- Tests: 30 passing (`npm.cmd test` in `frontend/`).
- Lint: 0 errors, 8 warnings, all of which already existed.
- Build: passes.

### Central Procurement branch: `procurement/central`

Every department places orders through Procurement: Department Head approval →
Procurement accept / reject / return → print the order form → confirm Order
Placed → delivery → completed. Every change goes through a `proc_*` database
function that checks role and status; direct writes are blocked.

**On LIVE (all applied and recorded in `supabase_migrations.schema_migrations`):**
`v3_01` (foundation), `v3_02` (lifecycle), `v3_03` (phone login + the
`staff-login` / `staff-create-user` Edge Functions), `v3_04` (My Profile), and
on 16-11-2026 `v3_05` and `v3_06`. Backup taken just before:
`backups/live-before-order-forms-reminders-20261116-1526.dump`. All five
Procurement SQL tests (212 checks) pass on live, run inside `begin; … rollback;`.

Note: the screens on this branch need `v3_05` + `v3_06`. Against a database
without them, `purchase_requests` returns 400 (`42703 column … does not
exist`), which the screens show as "Procurement is not switched on".

What `v3_05` and `v3_06` add:

- `mvp_pilot_order_forms_v3_05.sql` + `tests/order_forms.sql`: multi-item
  order forms (Interior compact A5, Retail A4 with rate/amount), attachments,
  return for correction, delivered / completed, amendments. Priorities are
  Normal / High / Urgent / Emergency; Urgent and Emergency need a reason;
  Emergency goes to Management first.
- `mvp_pilot_order_reminders_v3_06.sql` + `tests/order_reminders.sql`: due
  dates and automatic reminders (below).

**How reminders work (v3_06).** `pg_cron` job `procurement-order-reminders`
runs `proc_run_reminders()` every 15 minutes inside the database, so it does
not depend on anyone's browser. Each reminder is a `notifications` row (in-app
bell), and the existing push trigger sends it to phones. Rules (IST):

- Waiting for acceptance: immediately, after 2 h, after 24 h (escalation to the
  Procurement Head), then daily.
- Accepted but Order Placed not confirmed: immediately, after 24 h, then daily.
- Due date (any open stage until delivered): 3 days before, 1 day before, on
  the day, then daily while overdue. 2 days overdue → Management. 5 days →
  critical to Management + the department's Head. An overdue order gets
  `overdue_since` and a history note; its status is never changed.
- Timed reminders respect working days, reminder hours and company holidays
  (`procurement_settings`, `procurement_holidays`; edited on
  `/procurement/reminders`). Arrival and acceptance messages are immediate.
- No duplicates: `procurement_reminders` is unique per order + kind + cycle +
  person. It also keeps delivery status, read time and retries (5 attempts for
  the notification, 3 for a failed phone push). Each run is logged in
  `procurement_reminder_runs`. The Reminders page and the dashboard say plainly
  when the schedule is missing or has not run for 30 minutes.

**Before relying on reminders:** set the primary Procurement Head
(`proc_set_primary_head`, Management only). Until then the longest-serving
Procurement Department Head gets escalations. Add phone numbers so the printed
form and messages show them.

**Orders as Procurement tasks (`v3_07`, written and tested, NOT yet on live).**
`mvp_pilot_order_tasks_v3_07.sql` + `tests/order_tasks.sql`. Every submitted
order gets one `staff_tasks` row (`purchase_request_id` FK, unique;
`system_key = PROC_ORDER:<order id>`) and, from another department, one
`bridges` row. The order stays the source of truth: a trigger on its status
history keeps the task's due date, priority, description and status in step,
and `proc_task_stage()` derives the work stage (Open, Waiting for vendor,
Waiting for GRN, Completion pending …). When the order reaches Procurement every
active Procurement member is put on the task; the first to accept owns it (row
lock). The assignee can mark it done only after delivery is verified (GRN or
direct delivery) and a PO exists; the Procurement Head then verifies and
completes the order, which closes the task. Generic task actions on order tasks
are refused with a pointer to the order page. Dry run on live (rolled back):
v3_07 applies cleanly, 259/259 checks pass across six Procurement test files.
