# Mood Of Wood — Interior Project Management System

Context, workflow and design.
Last updated 22 August 2026.

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

One file — `index.html` — containing the HTML, CSS and JavaScript. No build
step, no framework, no bundler. Settings live in `config.js`.

```
index.html                 the whole dashboard
config.js                  Supabase URL + publishable key (the only settings file)
api/                       serverless functions, Vercel
  _lib.js                  auth check, role rules, audit
  users-create.js          create employee (Auth user + profile)
  users-set-password.js    temporary password on an existing UID
  users-update.js          role, department, active
  whoami.js                diagnostic
*.sql                      the migrations already run
START-MOOD-OF-WOOD.bat     local viewer for Windows (PowerShell, no installs)
```

**Security**: the browser holds only the publishable key. The service role key
lives in Vercel environment variables and is used only inside `/api`. Every
admin call sends the caller's ordinary Supabase token; the server verifies it,
loads their profile, and re-checks their role before doing anything.
Passwords are never read, logged or displayed — only replaced.

**Deployment**: `vercel --prod` from the folder, or connect a Git repository.
**Not** by dragging the folder onto the Vercel dashboard — that publishes
`/api` as static files and every admin function returns 404. This has bitten
this project once already.

Check after deploying: open `/api/whoami`. JSON is correct; Vercel's 404 page
or JavaScript source means the functions did not build.

---

## 10. Known limits, honestly

1. **Tasks, snags, change requests, attachments and the freeze checklist are
   still device-only.** Two people looking at the same project see different
   task lists. This is the largest remaining gap.
2. **Attachments hold metadata only.** The file itself lives in the browser
   session and disappears when the tab closes. Supabase Storage is not
   connected.
3. **No customer email automation.** Planned, then deliberately deferred;
   it needs Resend plus DNS records on moodofwood.in.
4. **No live updates.** You see new reports on page load or by pressing
   Refresh. For a ten-person team this was judged enough.
5. **Roles are fixed in code.** Adding "Senior Designer" means a small code
   change, not a settings screen. This was a deliberate trade — making roles
   dynamic means rewriting every permission check.
6. **Historical site reports and materials typed before the shared tables
   existed** remain on the device that typed them.

---

## 11. Suggested order of work from here

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
