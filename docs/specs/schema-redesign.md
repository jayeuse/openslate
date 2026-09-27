# Schema Redesign

> **Status: proposed.** Nothing in this document is implemented. The verified current state is in [docs/architecture](../architecture/README.md). This document records the target schema, the reasons for each change, the open decisions, and the delivery order.

## Outcome

The database models how OpenSlate is meant to work:

- An administrator designs departments, modules, fields, relationships and record triggers in the Sandbox, and publishes them.
- Each department has a home (OpenView) where its people read and change records, open dashboards and run reports.
- Boards are for communication: one company board, one board for each department, and project boards across departments.
- Groups decide who can read, write or manage each department and module.
- Everything that users create belongs to a department. There is no personal content.

The current database has 64 application tables. The target has 49. A smaller table count is a result of the design, not its goal.

## Principles

1. Remove duplication and dead code. Do not remove recorded business facts. A fact that is not stored when it occurs cannot be rebuilt later.
2. Everything that users create belongs to a department, a board or the company. Facts about a person stay (for example, "Bob changed this record"). Personal content goes (for example, private dashboards).
3. The users define the system. Access is set per department and module, and managers inside each department control their own content.
4. There is one way to change the data model: the Sandbox publish.

## Current-state findings

These findings are from source code. They are the reasons for most of the changes.

| Finding | Source |
|---|---|
| The authorization check loads only workspace-scope rules. Department, module and field rules are stored and validated, but never evaluated. | [authorization.py:368](../../backend/app/systems/access/policy/authorization.py), [rules_service.py:161](../../backend/app/systems/access/policy/rules_service.py) |
| Department membership does not limit record access. It controls only board audiences and department purge. | `user_departments` users in `boards/` and `sandbox/lifecycle/` |
| Service identities have no token or sign-in. Only the access simulator and the rules use them. | [service_identities/](../../backend/app/systems/access/service_identities/) |
| The direct create and update routes for departments, modules and fields exist next to the Sandbox publish. No frontend screen uses them to write. Tests and the sample-data seeder use them. | [modules/router.py:203](../../backend/app/systems/sandbox/modules/router.py), [seed_sample_data.py](../../backend/operations/seed_sample_data.py) |
| Record triggers (now "published automations") run as the publisher and stop when the publisher loses `records.write`. | [publisher_policy.py](../../backend/app/systems/sandbox/automations/publisher_policy.py) |
| Board announcement title, body and links are redacted in the audit log. The audit log cannot serve as post history. | [announcement_models.py:83](../../backend/app/systems/boards/announcement_models.py) |
| Select options are plain strings, and records store the option text. | [validation.py:138](../../backend/app/systems/sandbox/fields/validation.py) |
| Every table has both `is_deleted` and `deleted_at`. Some queries check both. | [base_model.py](../../backend/app/core/base_model.py) |
| The Manage screens make no server calls. The organization theme is saved in browser storage. | [manage/](../../frontend/src/components/systems/manage/), [appearance-preferences.ts](../../frontend/src/lib/appearance-preferences.ts) |
| The Platform screens (search, import and export, account, file library, record actions) run on sample data. Only the report notifications panel uses the server. | [platform/page.tsx](../../frontend/src/components/systems/platform/page.tsx) |
| Record values are stored in one JSONB column, `records.data`, keyed by field ID. A module is a set of rows in `modules`, `fields` and `records`, not its own table. | [query.py:134](../../backend/app/systems/sandbox/records/query.py) |
| Board post revisions are stored, but no route lists them. Deleting a post deletes all of its revisions. | [announcement_router.py](../../backend/app/systems/boards/announcement_router.py), [server-backed-board-announcement-lifecycle.tsx:353](../../frontend/src/components/systems/boards/components/server-backed-board-announcement-lifecycle.tsx) |
| `audit_logs.performed_by` uses `ON DELETE SET NULL`, and `actor_label` is not filled for users. A permanent user purge removes the actor from their audit entries. | [audit/models.py:49](../../backend/app/systems/manage/audit/models.py) |
| Security events are committed through a separate session, so denied and failed attempts are kept when the request changes roll back. | [audit/service.py:135](../../backend/app/systems/manage/audit/service.py) |

## Target schema

All tables keep the shared base columns (`id`, `created_at`, `updated_at`, soft delete, `performed_by`) unless a later decision changes them. **+** marks a new table. **Δ** marks a changed table.

In the graph, `A ──< B` means "one A has many B". `A >── B` is the same link read from the other side. `A ──> B` means "A points to B".

```
ACCESS
users ──< group_members >── groups ──< group_access >──┬── departments
  │                           └──< board_groups         └── modules (optional)
  └──< identity_sessions

LIVE MODEL
departments ──< modules ──< fields
                  ├──< records ──< relationship_edges >── records
                  └──< record_triggers ──< record_trigger_conditions
                         │             └──< record_trigger_actions
                         └─ runtime: record_trigger_events ──< record_trigger_runs

SANDBOX
sandbox_documents ──< sandbox_versions
   └─ publish ──> sandbox_publications ; sandbox_bindings
sandbox_test_runs ; lifecycle_confirmation_challenges ; lifecycle_rate_limit_*

OPENVIEW (department home)
departments ──< dashboards ──< dashboard_widgets ──> modules
modules ──< saved_views
modules ──< reports ──< report_runs ──< report_run_rows
                  │               └──< report_run_eligible_users
                  └──< report_schedules

BOARDS (communication)
boards (company | department | project) ──< board_groups (project boards only)
  ├──< board_posts ──< board_post_revisions ──< revision attachments and record links
  │        └──< board_attachments ; board_record_links
  ├──< board_events ──< board_event_reminders
  └──< board_widgets ──> modules

PLATFORM AND MANAGE
files ; scheduled_work ──< in_app_notifications
audit_logs ; security_events ; workspace_profiles
```

### Access and identity (6 tables)

| Table | Columns and rules |
|---|---|
| Δ `users` | Add `role` (`admin`, `member`, `guest`; text with CHECK). Remove `role_id` and `identity_kind`. CHECK: `role = 'guest'` if and only if `sponsor_user_id` and `expires_at` are set. |
| Δ `groups` (was `access_groups`) | `name`, `description`, `revision`. Name is unique among active rows, case-insensitive. |
| Δ `group_members` (was `access_group_members`) | `group_id`, `user_id`. Unique pair among active rows. A user can be in many groups. Administrators are not in groups. |
| + `group_access` | `group_id`, `department_id`, `module_id` (NULL means the whole department), `level` (`read`, `write`, `manage`). Unique on (`group_id`, `department_id`, `module_id`). |
| `identity_sessions` | Unchanged. |
| `identity_rate_limit_buckets` | Unchanged. |

### Live model (10 tables)

| Table | Change |
|---|---|
| `departments`, `fields`, `records`, `relationship_edges` | Unchanged, except for the open field decisions below. |
| Δ `modules` | Remove `is_schema_accepted`. |
| Δ `record_triggers` (was `published_automation_definitions`) | Rename `trigger_kind` to `event_kind`. Triggers run as the workspace. `publisher_id` stays as history. |
| Δ `record_trigger_conditions`, `record_trigger_actions`, `record_trigger_events`, `record_trigger_runs` | Renamed from `published_automation_*`. |

To a user, a module such as Products looks like its own table. In the database, the Sandbox publish adds rows: one `modules` row, one `fields` row for each column, and one `records` row for each record, with all values in `records.data`. No publish creates a database table. The backend validates each value against its field type before it saves the record.

### Sandbox and lifecycle (8 tables)

All unchanged, except for Δ `sandbox_bindings`: the `kind` value `'automation'` becomes `'trigger'`.

### OpenView (8 tables)

| Table | Change |
|---|---|
| Δ `dashboards` | Replace `owner_id` with `department_id`. Add `position`. |
| `dashboard_widgets` | Unchanged. The widget module must be in the dashboard department (service rule). |
| Δ `saved_views` | Remove `owner_id`, `visibility` and the audience columns. Add `is_default` with a unique partial index: one default for each module. |
| Δ `reports` | Remove `owner_id` and the audience columns. The department comes from the module. |
| `report_runs`, `report_run_rows`, `report_run_eligible_users`, `report_schedules` | Unchanged. |

Example for an Inventory department:

```
Inventory (department)
├── Dashboards                          dashboards
│    └── "Stock Overview"
│         └── tiles                     dashboard_widgets (each tile reads one module)
└── Products (module)
     ├── records                        records (live model)
     ├── saved views                    saved_views ("All products", "Low stock")
     └── reports                        reports
          └── "Month-end stock"
               ├── schedule             report_schedules
               └── runs (frozen)        report_runs, report_run_rows, report_run_eligible_users
```

How views, dashboards and reports work:

1. Nothing in OpenView exists before the administrator publishes the modules and fields.
2. Views, tiles and report recipes store module and field IDs in their JSON definitions. The tables do not describe the data.
3. A module without a saved view shows an automatic "All records" table with every field. This needs no database row.
4. A new department has no dashboards. A user with `manage` adds dashboards and tiles.
5. A field rename does not break a view, because the view stores the field ID. A removed field makes the view invalid, and the existing `invalid_view` check reports it.
6. Users with `manage` create and change the department dashboards, shared views and reports. There are no personal views or dashboards. Temporary filters live in the page address and are not saved.

### Boards (11 tables)

| Table | Change |
|---|---|
| Δ `boards` | Add `scope` (`company`, `department`, `project`). CHECK: `department_id` is set only for department scope. Unique partial index: one company board. Remove `owner_id` and `default_section`. |
| + `board_groups` | `board_id`, `group_id`, `level` (`read`, `write`, `manage`). Only for project boards. |
| Δ `board_posts` (was `board_announcements`) | Remove the audience columns. |
| Δ `board_post_revisions` and its attachment and record-link tables | Remove the audience columns. Each publish of a post adds one revision. Readers see the latest revision and can open the earlier ones ("Edited" history). This needs a new read route and screen. Deleting a published post archives it, so its history stays. Only a lifecycle purge removes revisions. |
| Δ `board_events` | Remove the audience columns. |
| Δ `board_event_reminders` | Remove `recipient_id`. The author sets the reminder. The board audience receives it. |
| Δ `board_widgets` | Remove the audience columns and `creator_id`. |
| Δ `board_attachments`, `board_record_links` | Renamed from `board_content_*`. |

Example:

```
Company board (all users)                 boards, scope = company
Inventory board (Inventory access)        boards, scope = department
 ├── posts                                board_posts
 │    └── "Stock count on Friday"
 │         ├── published versions         board_post_revisions (+ their attachments and record links)
 │         ├── attached files             board_attachments
 │         └── linked records             board_record_links
 ├── events                               board_events
 │    └── reminder: 1 day before          board_event_reminders
 └── tiles                                board_widgets
"Store Opening" board (project)           boards, scope = project
 └── who can use it                       board_groups (for example Marketing: write, Inventory: read)
```

Boards rules (proposed):

1. The board scope decides who sees the board. There is no audience on each post, event or tile.
2. On the company board, administrators post. On a department or project board, `write` users add posts and events, and `manage` users also pin posts, change tiles and change the posts of other users.
3. A post with a future `publish_at` stays hidden until that time. A post shows "New" for its first 7 days. OpenSlate does not track who read a post.
4. Each publish of a post adds a revision. Readers can open the earlier versions, like an "Edited" history.
5. Deleting a published post archives it. Only the lifecycle purge removes a post and its revisions.

### Platform and Manage (6 tables)

| Table | Change |
|---|---|
| `files` | Unchanged. File changes are deferred. |
| `scheduled_work` | Stays in Platform as the one shared job queue for report runs, post publishing and event reminders. Boards and OpenView both add jobs, and one worker runs them. Its announcement and reminder links follow the Boards changes. |
| `in_app_notifications` | Unchanged. It delivers "your scheduled report is ready". Other notification kinds are deferred. |
| `security_events` | Unchanged and separate from `audit_logs`. The audit log records committed data changes. Security events record actions that change no data (downloads, exports, invitations) and denied or failed attempts, which must survive a rolled-back request. A single Activity screen can show both. |
| Δ `audit_logs` | Add `department_id` (nullable, open decision 13). The audit listener sets it when it writes the entry. It stays NULL for company-level entities. |
| Δ `workspace_profiles` | Add `invitation_expiry_days` and `guest_duration_days`. |

## Removed tables (17)

| Table | Replacement |
|---|---|
| `roles` | `users.role` and `group_access` |
| `user_departments` | Derived from `group_members` and `group_access` |
| `service_identities` | None. Record triggers run as the workspace. User-owned API keys come later if an integration needs them. |
| `access_rules`, `access_policy_versions` | `group_access` (allow-only) |
| `access_policy_defaults` | Columns on `workspace_profiles` |
| `access_default_groups`, `access_default_departments` | The inviter selects groups in the invitation form |
| `dashboard_defaults`, `saved_view_defaults`, `openview_chart_preferences` | Department defaults, or removed as personal content |
| `board_favorites`, `board_homes` | Removed as personal content |
| `board_grants` | Board scope and `board_groups` |
| `board_templates` | None. It stores no business fact and can come back later. |
| `board_record_placements` | Posts that link to the record (`board_record_links`). |
| `board_announcement_personal_states` | None. Read tracking is not a Boards responsibility. A post shows "New" for its first 7 days, computed from `publish_at`. Pinned posts stay at the top. |

## Access behavior

1. If the user role is `admin`, allow all actions everywhere. Administrators alone change the schema through the Sandbox.
2. If the user is disabled, pending or expired, deny.
3. For each group of the user, find the most specific `group_access` row for the target: the module row, or else the department row.
4. Take the highest level across all groups. Groups only add access; there is no deny.
5. If the user role is `guest`, limit the level to `read`.
6. `read` allows reading records. `write` also allows creating, changing and deleting records. `manage` also allows changing the department dashboards, board, shared views and reports, and the members of groups whose access is entirely inside departments that the user manages.
7. With no matching row, deny. A user without a group for a department sees nothing in it.

Relationship links into a department or module that the user cannot read are hidden from that user.

Company boards are readable by all users. Department boards follow the department access. Project boards follow `board_groups`. Data tiles on project boards show each viewer only the data that the viewer can read.

One function, `allowed_module_ids(user, level)`, supplies the access filter to every read path: record query, CSV export, report capture, relationship lists and widgets.

## Record triggers

A record trigger acts only on the record that started it. Its only action is "set field". Anything that acts on other records, sends messages or calls external systems is an automation. Automations are deferred.

The rename from "automations" to "record triggers" applies everywhere: tables, the Sandbox design document, validation issue codes, API paths and screen copy. The Sandbox document format version increases. Development data is reset, so old saved designs are not converted; the backend refuses them with a clear message.

Record triggers run as the workspace. Their audit entries have no user in `performed_by` and carry `actor_label = "Trigger: <name>"`.

## Scheduled work

- A scheduled report runs as the workspace, like a record trigger. Anyone who can read the report module can open its runs; access is checked again when a run is opened. Users with `manage` on the department create and change schedules.
- An event reminder belongs to the event. The author chooses one or more timings. For a repeating event, every occurrence sends the reminder to everyone who can read the board, as an in-app notification.
- Deleting a post that was never published removes it. Deleting a published post archives it.

## Deferred

- Automations (multi-step actions on other records, notifications, webhooks).
- The organization-wide theme (`workspace_profiles.theme`).
- The Manage Backup, Licensing and Updates panels.
- User-owned API keys.
- Board templates.
- Read tracking for board posts. If it returns, it belongs to notifications, not to Boards.
- File changes: scan history (`file_scans`), one place for the file owner link, the `file` field type and library documents (open decisions 5 and 6).
- Generalized notifications (record, post, event and report subjects, and notification settings). `in_app_notifications` stays as it is until then.
- Features that the Platform screens show but that have no tables: record import (with column mapping and import history), workspace search (a full-text index on `records.data`), user settings (language and personal theme), and presence (online or away, kept in the live connection, not in the database).
- An Activity screen that shows audit entries and security events together.
- Record discussions and thread replies (the reserved Comms area).

## Decisions

Resolved on 2026-09-27: 1 (later), 2, 3, 4 (yes, slice 7), 5 (deferred with files), 7 (all renames), 8 (no installation with real data), 12 (remove pinned records), 13 (add `audit_logs.department_id`). Items 6, 9, 10, 11 and 14 remain open.


| # | Decision | Recommendation |
|---|---|---|
| 1 | Field-level access (`group_field_access`: `group_id`, `field_id`, `level` of `hidden` or `read`) now or later | **Decided: later.** |
| 2 | Select options with IDs (`[{id, label}]`), with records that store the ID | **Decided: yes, slice 7.** |
| 3 | A record title field (`modules.title_field_id`) | **Decided: yes, slice 7.** |
| 4 | A `user` (person) field type | **Decided: yes, slice 7.** The Workload widget, "assigned to me" and the "Assign record to" action need it. |
| 5 | A `file` field type (`files.field_id`) | **Deferred** with the other file changes. |
| 6 | Library documents (`files.purpose = 'library_document'`, no frontend use) | Remove, or make them a department library (`files.department_id`). |
| 7 | Renames: `access_groups` to `groups`, `access_group_members` to `group_members`, `board_announcements` to `board_posts` and the related board tables | **Decided: rename all.** |
| 8 | Is there an installation with real data? | **Decided: no, development only.** The redesign replaces the migration baseline with a new fresh-install root, and development volumes are reset. No data conversion. |
| 9 | `is_deleted` as a generated column from `deleted_at` | Yes. |
| 10 | Soft delete only on restorable tables | Yes, table by table, when each area changes. |
| 11 | One shared rate-limit table for identity and lifecycle | Optional. A fixed window is acceptable for delete confirmations. |
| 12 | Pinned records on boards (`board_record_placements`) | **Decided: remove.** Posts link to records instead. |
| 13 | `audit_logs.department_id` | **Decided: add.** |
| 14 | Fill `audit_logs.actor_label` for users too | Recommended, so that a permanent user purge does not remove the actor. Currently declined: audit logs stay as they are. |

## Delivery order

Each slice is one pull request with its own Alembic revision, except slice 3, which uses an integration branch. The detailed plan is [schema-redesign-plan.md](../plans/schema-redesign-plan.md).

| # | Slice | Depends on |
|---|---|---|
| 1 | Remove the direct schema write routes and `modules.is_schema_accepted`. Keep the read routes and the lifecycle routes. The sample-data seeder uses these routes today, so this slice also decides the seeder: move it to the Sandbox publish, or mark it unsupported until the sample-data plan is redone. | None. The sample-data plan ([ui-equivalent-sample-data-plan.md](../plans/ui-equivalent-sample-data-plan.md)) waits for this redesign. |
| 2 | Rename published automations to record triggers. Run them as the workspace. The Sandbox draft reader accepts the old name in old versions. | None |
| 3 | The access model: `users.role`, groups, `group_access`, `manage`, the access function in every read path, the Access screens, and the invitation settings on `workspace_profiles` (they move when `access_policy_defaults` is dropped). Remove the rules layer and service identities. | None |
| 4 | OpenView belongs to departments. | Slice 3 |
| 5 | The Boards changes, including the post edit history (read route and screen) and archive instead of delete for published posts. | Slice 3 |
| 6 | Manage: `audit_logs.department_id`. | Slice 3 |
| 7 | Field model: select option IDs, `modules.title_field_id`, and the `user` field type. | Slices 1 and 3 (the person picker needs the access filter) |
| 8 | A new fresh-install migration root that replaces the slice revisions. | All other slices |

Slice 3 is the largest. About 53 backend files use the current capability checks, and about 148 backend test files refer to roles. A shared test helper that creates a user in a group reduces the test changes.

## Planned verification

These are planned checks. None of them has run.

- For each slice: `uv run alembic upgrade head` and `uv run alembic check` on the owned Supabase instance.
- Slice 3: database tests that prove a user without a group for a department cannot read its records through the record query, CSV export, report capture, relationship lists or widgets. Also: a guest cannot write, the highest level wins across groups, and a manager cannot change a group that reaches a department outside their management.
- Slice 2: an existing trigger still runs after its publisher loses access.
- Frontend: rendered checks of the changed Access, OpenView and Boards screens at desktop and mobile widths.
- The canonical gate `python3 scripts/prepush.py --base <base-ref>` for each pull request, with the backend 90% coverage threshold.

## Risks

| Risk | Control |
|---|---|
| A read path misses the department filter and leaks records. | All read paths use `allowed_module_ids`. Slice 3 tests each path. |
| A manager gives access to another department through a shared group. | Managers can change only groups whose access is entirely inside departments they manage. |
| The highest-level rule surprises administrators. | The Access screens show the effective level for each user and module, and the group that gives it. |
| Old Sandbox versions use the old automation names. | The draft reader accepts both names. Stored versions do not change. |
| A data migration fails on a real installation. | Open decision 8. A dry run and a restore rehearsal run first. |
| A permanent user purge removes the actor from audit entries. | Normal deletes are soft. Open decision 14 describes the fix. |
| An author changes a published post without a trace. | Revisions keep every published version, and delete archives the post. |
