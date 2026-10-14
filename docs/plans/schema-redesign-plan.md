> **Status: redesign implemented; original slice recipe retained as history.** The active fresh-install root is `089c54b88aa6`; the prior chain is archived. Current forward migrations extend that root, and development-instance reinitialization still requires approval. The [original spec](../specs/schema-redesign.md) describes the redesign target, not all later Tier 1/Tier 2 features. No scanner exists and no stopped historical acceptance command is reauthorized here. Current release/host limitations are in [known gaps](../reviews/known-gaps.md).

# Schema Redesign Implementation Plan

## 1. Scope

### 1.1 Outcome

The redesign produced 49 application tables at the fresh root, with department/module access through groups, record triggers instead of published automations, department-owned OpenView content, scoped Boards and audit department ancestry. The active committed chain now creates **55 application tables**: the root's 49 plus `backup_policies`, `update_statuses`, `backup_runs`, `identity_mfa_observations`, `backup_export_operations` and `charts`. Count upgrade `op.create_table`/`op.drop_table` operations in parent order under [active revisions](../../backend/migrations/versions/), not model `__tablename__` declarations. Exclude Alembic bookkeeping and Supabase-owned schemas. See [data architecture](../architecture/06-data-architecture.md).

Sections 2–5 retain the original redesign steps and before/after matrix, not pending instructions. Later features and current grants/role names follow the architecture and current migrations; historical removed-resource descriptions do not restore those resources. The missing retired-test inventory is replaced with current protection paths below.

### 1.2 Non-goals

- Automations, generalized notifications, file changes, the organization-wide theme, the Manage Backup, Licensing and Updates panels, user API keys, board templates, read tracking and field-level access. The spec lists them as deferred.
- Data conversion for a real installation. There is none (decision 8).
- The UI-equivalent sample data. [ui-equivalent-sample-data-plan.md](ui-equivalent-sample-data-plan.md) is re-planned after this redesign.

### 1.3 Decisions that govern this plan

| Topic | Decision | Source |
|---|---|---|
| Real data | None. Development only. The redesign ends with a new fresh-install root. | User, 2026-09-27 |
| Field model | Select option IDs, a record title field and a `user` field type are slice 7. | User |
| Renames | Rename all: `groups`, `group_members`, `board_posts` and the related board tables, and `record_triggers`. | User |
| Trigger rename reach | Everywhere: tables, columns, Sandbox document, issue codes, API paths, screen copy. No conversion of old designs. | User |
| Pinned records | Remove `board_record_placements`. | User |
| Audit department | Add `audit_logs.department_id`. | User |
| Field-level access | Later. | User |
| Scheduled reports | Run as the workspace. Module readers can open runs. Managers set schedules. | User |
| Event reminders | Set by the author on the event. Every occurrence notifies the board audience. | User |
| Draft delete | A never-published post is deleted. A published post is archived. | User |
| Seeder | Retire the sample-data seeder in slice 1 (D1). | User, 2026-09-27 |
| Delete stubs | Remove the three 409 "Use Close" delete routes in slice 1 (D11). | User, 2026-09-27 |
| Field reorder | Remove `POST /api/modules/{id}/fields/reorder` in slice 1 (D12). | User, 2026-09-27 |
| Read tracking | Not a Boards responsibility. | User |

### 1.4 Defaults chosen by this plan

These choices are needed to write the slices. Change any of them before its slice starts.

| # | Default | Reason |
|---|---|---|
| D1 | **Historical decision delivered.** Retire the old seeder during redesign, then rebuild it against supported controls after slice 8. The current `backend/operations/seed_sample_data.py` is that later API-based runner. | The old role/CRUD/owner-based dependencies no longer define sample admission; use the current [sample-pack contract](sample-pack-contract.md). |
| D2 | Slice 3 uses an integration branch with sub-pull requests. Main receives slice 3 only when all of it passes the gate. | Slice 3 cannot land in one reviewable pull request, and a half-migrated access model on main would need a compatibility layer, which `AGENTS.md` discourages. |
| D3 | Each slice adds a normal Alembic revision on top of `c4ec36fc30cc`. Slice 8 replaces the chain with a new root. | Each slice then passes `alembic upgrade head` and `alembic check` on its own. |
| D4 | The identity response (`GET /api/auth/me`, `access/auth/router.py:294`) returns `role` and an `access` list of `{department_id, module_id, level}`. It no longer returns `permissions`. | The frontend needs the effective levels to show or hide controls. |
| D5 | Rebuilt Access screens use TanStack Query per `.agents/skills/query-cache-patterns/SKILL.md`. | Access today reloads the whole snapshot after each change. The rebuild is the cheapest time to adopt the shared pattern. |
| D6 | A Sandbox publish creates one department board for each new department. The slice 5 migration creates the one company board and a board for each existing department. | The spec says each department has one board. |
| D7 | Administrators create project boards and assign `board_groups`. A `manage` level in `board_groups` lets that group manage the board. | Project boards cross departments, so no department manager owns them. |
| D8 | Users with `manage` on a department can read the audit entries of that department. | The reason for `audit_logs.department_id`. |
| D9 | Only administrators use the Sandbox, publish, and lifecycle close, reopen and purge. The export restriction is superseded by Tier 2 D12: module readers may export CSV and Excel. | The spec makes schema changes administrator-only. Tier 2 retains those controls and applies module read access to record export. |
| D10 | Record and relationship invalidation events carry `module_id`. The SSE hub sends them only to subscribers who can read that module. | The current payload cannot be filtered by department (finding T2-4). |
| D11 | **Confirmed by the user.** Slice 1 removes the `DELETE /api/departments/{id}`, `/api/modules/{id}` and `/api/fields/{id}` routes. Today they only return 409 "Use Close". | They exist only to redirect old clients, and no client uses them. |
| D12 | **Confirmed by the user.** Slice 1 removes `POST /api/modules/{id}/fields/reorder`. Field order then comes only from the Sandbox document. | It is a direct schema change outside the publish. The Sandbox designer must support field order, and it already stores field positions in the document. |
| D13 | The Access nav item shows for administrators and for users with `manage` on any department. A manager sees only the Groups tab, only the groups they may manage, and can change only their members. | `/api/auth/me` returns `role` and `access`, so the frontend can gate the nav. The backend still enforces every rule. |
| D14 | Members change through a dedicated `PUT /api/access/groups/{id}/members` with `If-Match`. `PATCH` keeps name and description and is administrator-only. A non-guest active user with `manage` on every department that the group's `group_access` rows reach may replace the members. A group with no access rows is administrator-only. A manager may add active or pending non-administrator users, including guests, may remove anyone including other managers and themselves, and may add members to a group that grants `manage`. `GET /api/access/groups` and `GET /api/access/groups/{id}` return only the groups a manager may change. `GET /api/access/member-candidates` returns the minimal list a manager needs: ID, display name, username, email, role and status of non-administrator, non-deleted users. | The spec gives `manage` the right to change the members of groups that stay inside the manager's departments. The administrator already chose each group's levels, so adding a member gives that person exactly what the administrator decided. A dedicated route keeps one authorization rule per resource. |
| D15 | `GET /api/reports/audience-roles` returns 422 because `/api/reports/{report_id}` matches the path. This is accepted: the route no longer exists. | A 404 would need a route-order change for a path that nothing calls. |

### 1.5 Boards continuation decisions

Confirmed by the user on 2026-09-28:

- Authors retain the ability to archive their own posts and events; the frontend must expose the actions allowed by the backend.
- Reminder timings remain start, 15 minutes before, and 1 day before. A reminder may be delivered up to and including 15 minutes after its due time; older reminders are not delivered. Delivery still uses the current board audience and must not duplicate an occurrence.
- Purging a department also purges its department board and owned content, matching department-owned dashboard cleanup. The purge preview and confirmation must cover that content while preserving safeguards for unrelated boards, file storage, and concurrent changes.

**File boundary for the department cascade.** Implement the database cascade with the existing file-purge prerequisite: file bytes must already have a confirmed purge before their metadata and owner are removed. This preserves the plan's deferred file scope. The question of adding a resumable combined byte-deletion workflow remains a separate scope decision; it does not block the approved cascade for content that satisfies the existing file guard.

## 2. Delivery strategy

### 2.1 Order

```
1 routes ─► 2 record triggers ─► 3 access (integration branch 3a–3e) ─┬─► 4 OpenView
                                                                      ├─► 5 Boards
                                                                      ├─► 6 audit department
                                                                      └─► 7 field model ─► 8 new root
```

Slices 4, 5 and 6 are independent after slice 3. Run them one at a time in the shared checkout, or in parallel only in separate worktrees. Slice 7 follows slice 3 because the person picker needs the access filter. Slice 8 follows all others.

| Slice | Size | Main risk |
|---|---|---|
| 1 Close schema routes | S | Tests that build data through the routes |
| 2 Record triggers | M | Constraint and index names that still contain the old table names |
| 3 Access | XL | A read path without the department filter |
| 4 OpenView | L | The report run actor and eligibility |
| 5 Boards | L | Eight database functions with old table names in their bodies |
| 6 Audit department | S | The department lookup for each audited entity |
| 7 Field model | L | Select values and person values in filters, grouping and CSV |
| 8 New root | M | Schema drift between the chain and the new root |

### 2.2 Definition of done for every slice

1. The slice checklist in section 3 is complete for every table the slice touches.
2. `uv run alembic upgrade head` and `uv run alembic check` pass on the owned Supabase instance (from `backend/`).
3. A database query finds no constraint, index, trigger or function name that contains a removed or renamed table name.
4. The affected architecture documents and `AGENTS.md` lines describe the new behavior (section 6).
5. **Testing-workflow replacement:** The former once-per-pull-request gate instruction is historical. Follow [root `AGENTS.md`](../../AGENTS.md) and [Testing Architecture](../architecture/16-testing-architecture.md): focused repair and one stable affected batch, then `python3 scripts/prepush.py --base <base-ref> --serial` only right before a push. Backend coverage retains both 90% overall and changed-line gates; local coverage runs the stack-free unit lane before three integration stacks, with no overlapping frontend/backend heavy lanes.
6. For UI changes: screenshots at 1440×900 and 390×844, then a `ui-reviewer` pass, per `CLAUDE.md`.
7. The acceptance criteria of the slice pass with recorded evidence.

### 2.3 Approval gates

| Gate | When |
|---|---|
| Public API removal and change | Each pull request. The spec approves the direction; the pull request lists the exact routes. |
| Resetting development application data with `backend/operations/reset_application_data.py` | Before a slice migration that drops data the reset does not preserve. Ask each time. |
| Recreating the development database volume | Slice 8. `AGENTS.md` forbids `docker compose down -v` without approval. |
| Editing `AGENTS.md` | Slice 3 and slice 5. In scope, but name the changed lines in the pull request. |

### 2.4 Test rules

Follow the root testing rule in `AGENTS.md`. Use focused tests while a slice changes; run each full suite once at its gate. Delete tests of removed features. Rewrite tests of changed behavior. Change setup-only tests through the shared helpers in `backend/tests/rbac/support.py` and local `make_*` helpers (per `backend/AGENTS.md`). Use isolated PostgreSQL for every database guarantee. Never weaken an assertion to make a slice pass.

## 3. Checklist for each table change

The schema plumbing investigation found that a table change touches more than the migration. Use this checklist for every row of the matrix in section 5.

### 3.1 New table

1. Add the model to `backend/app/systems/<page>/<capability>/models.py` and import it in `backend/app/core/database/model_registry.py`.
2. Generate the revision and review it by hand. Default privileges from the baseline grant `SELECT, INSERT, UPDATE, DELETE` to `openslate_app` automatically. An append-only table also needs `REVOKE UPDATE, DELETE, TRUNCATE ... FROM openslate_app`.
3. A new database function needs `REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` and `GRANT EXECUTE ... TO openslate_app`. Default privileges do not cover functions.
4. Classify the table in `backend/app/systems/platform/events/models.py`: private, administrator, all authenticated, entity only, or capability-filtered. A table in no set is broadcast to all authenticated users.
5. Add the table to `APPLICATION_TABLES`, `NON_PRESERVED_TABLES` if applicable, `DELETE_ORDER` and `_LOCK_APPLICATION_STATEMENT` in `backend/operations/reset/models.py`. `reset/planning.py` compares these with the live schema.
6. Audit is on by default. Set `__audit_enabled__ = False` only for session, rate-limit or queue data. Set `__audit_redacted_fields__` for sensitive columns.

### 3.2 Renamed table or column

1. Rename the model class and `__tablename__`. Write `op.rename_table` and `op.alter_column(..., new_column_name=...)` by hand. Autogenerate reads a rename as drop and create, which loses data.
2. Rename every index, unique constraint, foreign key, check constraint and primary key so that it matches the naming convention in `backend/app/core/database/base.py`. Use `ALTER INDEX ... RENAME` and `ALTER TABLE ... RENAME CONSTRAINT`.
3. Replace every database function whose body names the old table or column with `CREATE OR REPLACE FUNCTION`, and grant `EXECUTE` again. A table rename does not change function bodies.
4. Replace the old name in the SSE classification sets. A missed name falls through to broadcast to all authenticated users.
5. Replace the old name in the four `reset/models.py` constants and in any SQL text in that file.
6. Old `audit_logs.entity_type` values keep the old table name. Any filter by entity type must accept both names. Development data is reset, so this matters only until slice 8.

### 3.3 Dropped table

1. Remove the model and its `model_registry.py` import. `migration_scope.py` still sees the owned table, so `alembic check` reports the drift until the revision drops it.
2. Drop the table in the revision. The downgrade recreates the empty table; the data does not return.
3. Remove the name from the SSE sets and from `reset/models.py`.
4. Remove the routers, services, schemas, tests and frontend code that use it.

### 3.4 Changed column

1. Change the model and write the revision by hand when data must move.
2. Search `reset/models.py`, `backend/tests/fullstack_runner.py` and `backend/operations/*.py` for the column name. These files hold SQL text and ORM code outside the normal import graph.

## 4. Slices

### Slice 1: Close the direct schema routes

**Outcome.** The Sandbox publish is the only way to change departments, modules and fields. `modules.is_schema_accepted` no longer exists.

**Schema.**

```sql
ALTER TABLE modules DROP COLUMN is_schema_accepted;
```

**Backend.**

1. Remove these routes (the public API change of this slice):
   - `POST /api/departments`, `PATCH /api/departments/{id}`, `POST /api/departments/{id}/restore`, `DELETE /api/departments/{id}` (409 stub) in `sandbox/departments/router.py`.
   - `POST /api/modules`, `PATCH /api/modules/{id}`, `POST /api/modules/{id}/restore`, `POST /api/modules/{id}/schema/accept`, `DELETE /api/modules/{id}` in `sandbox/modules/router.py`.
   - `POST /api/fields`, `PATCH /api/fields/{id}`, `POST /api/fields/{id}/restore`, `DELETE /api/fields/{id}`, `POST /api/modules/{id}/fields/reorder` in `sandbox/fields/router.py`. Field order changes through the Sandbox publish.
2. Keep all `GET` routes. Lifecycle `reopen` routes in `sandbox/lifecycle/router.py` replace `restore`.
3. Remove the `*Create`, `*Update` and `*Reorder` schema classes. Keep the response schemas, `fields/validation.py` and `fields/impact.py`; the publish path uses them.
4. Remove every write and read of `is_schema_accepted`: `publications/executor.py:288,302,414`, `lifecycle/execution.py:141`, `records/router.py:408` (keep the "at least one active field" check that follows it), and the module filters in `openview/charts`, `openview/dashboards`, `openview/views`, `openview/reports`, `platform/scheduling/service.py`, `boards/widget_router.py`, `boards/portability*.py`, `boards/record_link_service.py` and `boards/placement_router.py`.
5. Retire the seeder (default D1).

**Frontend.** Remove `is_schema_accepted` from `frontend/src/lib/api.ts:23`. No screen calls the removed routes.

**Tests.**
- Current protection: [catalog request/read-only contracts](../../backend/tests/catalog/test_fields_api_contract.py), [strict request schemas](../../backend/tests/catalog/test_request_schema_contracts.py), [dynamic persistence](../../backend/tests/catalog/test_dynamic_field_persistence_integration.py), [field concurrency](../../backend/tests/catalog/test_dynamic_field_concurrency_integration.py), [decimal database compatibility](../../backend/tests/catalog/test_dynamic_field_database_integration.py), [provider SSE](../../backend/tests/events/test_provider_sse_acceptance.py) and [lifecycle integration](../../backend/tests/lifecycle_integration/). The removed CRUD/schema-accept/seeder tests are historical, not runnable paths.
- Add: a record can be created in a module immediately after the publish that creates it.

**Acceptance criteria.**

| ID | Criterion |
|---|---|
| S1-1 | Each removed route returns 404 or 405. OpenAPI does not list it. |
| S1-2 | After a publish that creates a module with fields, `POST /api/records` for that module succeeds. |
| S1-3 | After a lifecycle close of every field of a module, `POST /api/records` returns 409. |
| S1-4 | OpenView and Boards module lists show every active published module. |
| S1-5 | `alembic check` passes, and `modules` has no `is_schema_accepted` column. |

**Risk.** Closing the last field of a module is still allowed. Record creation then refuses, which matches today's behavior.

### Slice 2: Record triggers

**Outcome.** "Published automations" become record triggers everywhere. Triggers run as the workspace.

**Schema.**

| Old | New |
|---|---|
| `published_automation_definitions` | `record_triggers`, column `trigger_kind` → `event_kind` |
| `published_automation_conditions` | `record_trigger_conditions`, column `automation_id` → `trigger_id` |
| `published_automation_actions` | `record_trigger_actions`, column `automation_id` → `trigger_id` |
| `published_automation_events` | `record_trigger_events`, column `scheduled_automation_id` → `scheduled_trigger_id` |
| `published_automation_runs` | `record_trigger_runs`, column `automation_id` → `trigger_id` |
| `sandbox_bindings.kind` value `'automation'`, column `automation_id` | value `'trigger'`, column `trigger_id` |
| `sandbox_test_runs.automation_ids` | `trigger_ids` |
| `sandbox_documents.schema_version`, `sandbox_versions` CHECK `= 2` | CHECK `= 3` |

Rename every constraint and index (checklist 3.2). Update the `sandbox_bindings` rows with `UPDATE ... SET kind = 'trigger'` before the new CHECK. Replace the existing Sandbox document row with an empty version-3 document, because old designs are not converted.

**Backend.**

1. Rename the package `sandbox/automations` → `sandbox/record_triggers`, `publications/automation_mutations.py` → `trigger_mutations.py`, `publications/automation_comparison.py` → `trigger_comparison.py` and `test_runs/automation_values.py` → `trigger_values.py`. Rename the classes to match.
2. The Sandbox document: `SandboxSnapshot.automations` → `triggers`, `AutomationDocument` → `TriggerDocument`, `schema_version: Literal[3]` (`designs/schemas.py:384-394`), and the default in `designs/defaults.py:14`. A version-2 payload returns 422 with the message "This design uses an older format and cannot be opened."
3. Rename the issue codes `automation.*` → `trigger.*` in `designs/validation.py`.
4. Rename the route `GET /api/sandbox/automation-runs` → `GET /api/sandbox/trigger-runs`.
5. Run as the workspace: delete `publisher_policy.py`; remove the publisher check in `runner.py:30-70`; add `actor_label: str | None` to `AuditContext` (`manage/audit/context.py:10`); make the audit listener write it; set `performed_by=None` and `actor_label="Trigger: <name>"` in `runner._set_context`.
6. Rename the internal request paths in `outbox.py:138` and `runner.py:476-482` and the worker log tags in `worker.py`.
7. Keep the loop protection (`depth` ≤ 10, `action_budget` 100) as it is.

**Frontend.** Rename in the 23 files under `frontend/src/components/systems/sandbox/` that the investigation listed, including `page.tsx:703` (the issue-code routing), `state/api.ts`, `domain/document-types.ts`, `document-parser.ts`, `automation-studio.tsx` and `automation-flow.tsx` (rename the files), and the copy "Automations" → "Triggers". Remove `domain/document-migration.ts` and show a clear message when a version-1 or version-2 file is imported.

**Current tests.** [Record triggers](../../backend/tests/sandbox_record_triggers/), including `test_policy_execution_integration.py` and `test_runner_policy.py`, protect workspace execution after publisher disablement. [Publication](../../backend/tests/sandbox_publications/), [temporary Test](../../backend/tests/sandbox_test_runs/), [design](../../backend/tests/sandbox_designs/), [isolated Sandbox](../../frontend/tests/isolated/sandbox/) and [real-stack Sandbox](../../frontend/tests/fullstack/sandbox-workspace.spec.ts) suites retain the current boundaries. The old automation test package is retired.

**Acceptance criteria.**

| ID | Criterion |
|---|---|
| S2-1 | A trigger still runs after its publisher is disabled. |
| S2-2 | The audit entry of a trigger change has `performed_by` NULL and `actor_label` "Trigger: <name>". |
| S2-3 | Saving a version-2 document returns 422 with the message in step 2. |
| S2-4 | A validation issue on a trigger opens the Triggers section of the Sandbox screen. |
| S2-5 | No table, column, constraint, index, route or issue code contains "automation". |

### Slice 3: Access

**Outcome.** Groups give `read`, `write` or `manage` on departments and modules. Every read path filters by the user's access. Roles, rules, service identities and department memberships are gone.

**Branch.** `codex/schema-redesign-access`. Sub-slices 3a to 3e are separate pull requests into that branch. Slice 3a can go to main directly because it changes no behavior. Between 3b and 3e the Access screen does not load, because its API is gone and its replacement is not built yet. The integration branch exists for that reason: main never has this state. Each sub-pull request still passes the gate, so every wire change lands together with all of its consumers.

#### 3a: Separate the sample data from Access (frontend only)

1. Move `Person`, `departments` and `initialPeople` from `access/domain/model.ts` to `frontend/src/components/systems/shared/data/`. Update the 11 importers in `comms/`, `platform/`, `openview/` and `boards/`.
2. Remove the Boards sample runtime's use of `access/adapters/federated-adapters.ts`, `access/domain/controller-utils.ts` (`resolveControllerAccess`) and `access/state/controller.tsx` (`readAccessProjection`, `ACCESS_OWNER_KEYS`) in `boards/state/controller.tsx:9-18`. Give the Boards sample a local audience rule.
3. Acceptance: every sample screen renders as before; `npm run verify` passes.

#### 3b: Schema and identity

**Schema.**

```sql
ALTER TABLE users ADD COLUMN role text;
UPDATE users SET role = CASE
  WHEN identity_kind = 'guest' THEN 'guest'
  WHEN (SELECT r.role FROM roles r WHERE r.id = users.role_id) = 'admin' THEN 'admin'
  ELSE 'member'
END;
ALTER TABLE users ALTER COLUMN role SET NOT NULL,
  ADD CONSTRAINT ck_users_role CHECK (role IN ('admin','member','guest')),
  ADD CONSTRAINT ck_users_guest CHECK ((role = 'guest') = (sponsor_user_id IS NOT NULL AND expires_at IS NOT NULL)),
  DROP COLUMN role_id, DROP COLUMN identity_kind;

ALTER TABLE access_groups RENAME TO groups;
ALTER TABLE access_group_members RENAME TO group_members;

CREATE TABLE group_access (
  -- base columns
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  module_id uuid NULL REFERENCES modules(id) ON DELETE RESTRICT,
  level text NOT NULL CHECK (level IN ('read','write','manage'))
);
-- unique (group_id, department_id, module_id) NULLS NOT DISTINCT among active rows

ALTER TABLE workspace_profiles
  ADD COLUMN invitation_expiry_days int NOT NULL DEFAULT 7 CHECK (invitation_expiry_days BETWEEN 1 AND 365),
  ADD COLUMN guest_duration_days int NOT NULL DEFAULT 30 CHECK (guest_duration_days BETWEEN 1 AND 365);

-- Seven columns outside Access reference roles.id. Drop them before roles.
-- Reset development application data first (approval gate); rows with a role audience are not converted.
ALTER TABLE saved_views DROP COLUMN audience_role_id;          -- and remove 'role' from its audience CHECK
ALTER TABLE reports DROP COLUMN audience_role_id;              -- same
ALTER TABLE board_widgets DROP COLUMN audience_role_id;        -- same
ALTER TABLE board_announcements DROP COLUMN audience_role_id;  -- same
ALTER TABLE board_announcement_revisions DROP COLUMN audience_role_id;  -- same
ALTER TABLE board_events DROP COLUMN audience_role_id;         -- same
ALTER TABLE board_grants DROP COLUMN principal_role_id;        -- remove 'role' from principal_type CHECK

DROP TABLE access_rules, access_policy_versions, access_default_groups,
  access_default_departments, access_policy_defaults, service_identities,
  user_departments, roles;
```

The foreign keys are in `openview/views/models.py:91`, `openview/reports/models.py:58`, `boards/models.py:157,226`, `boards/event_models.py:106` and `boards/announcement_models.py:139,217`. Slices 4 and 5 later remove the rest of these audience columns.

The invitation settings move in this sub-slice, not in slice 6, because `access_policy_defaults` is dropped here. The four other defaults fields (`service_duration_days`, `default_deny`, `require_guest_sponsor`, `require_service_owner`) are dropped. Their behavior becomes fixed rules: no service identities, default deny, and a sponsor for every guest. A service rule in the application checks that `group_access.module_id` belongs to `department_id`.

**Backend.**

1. Replace `is_internal_identity` (`identity/eligibility.py:37`) with `user.role != 'guest'` checks, and `require_roles(ADMIN)` with `user.role == 'admin'` in all 18 call sites, including the two that pass the string `"admin"` (`platform/files/board_router.py:55`, `platform/files/lifecycle_router.py:39`).
2. Rewrite `require_fresh_exact_admin` (`common/dependencies/auth.py:99-135`), `identity/provider_sessions.py:76-77,110,167`, `identity/admin_recovery.py:59`, `operations/bootstrap_admin.py:75-165`, `users/service.py`, `users/account_operations.py` and `users/coordination.py` for `users.role`.
3. Invitations: `InvitationCreate` takes `role` and `group_ids` and no longer takes `role_id`, `identity_kind`, `department_ids` or `primary_department_id`. Guest expiry comes from `workspace_profiles.guest_duration_days`. Remove `load_creation_defaults`, `CreationDefaults` and the dead `load_invitation_expiry_days`.
4. Remove the routers and their public routes: `/api/roles*`, `/api/access/service-identities*`, `/api/access/rules*`, `/api/access/rules/impact-preview`, `/api/access/rules/apply`, `/api/access/checks`, `/api/access/capabilities`, `GET` and `PATCH /api/access/defaults`.
5. Rewrite the groups routes in `access/policy/configuration_router.py`: `GET` and `POST /api/access/groups`; `GET`, `PATCH` and `DELETE /api/access/groups/{id}` with members; `PUT /api/access/groups/{id}/access` that replaces the group's `group_access` rows under `If-Match`.
6. Move the invitation settings to `PATCH /api/workspace`.
7. The identity response returns `role` and `access` (default D4).
8. Replace `user_departments` consumers: `boards/announcement_inbox.py:92-96`, `boards/announcement_service.py:280-287` and `boards/event_router.py:106-113` use a new `department_reader_ids(db, department_id)` built on `group_access`. Slice 5 removes these audiences completely. The lifecycle files `sandbox/lifecycle/batch_dependencies.py:469`, `execution.py:12,50` and `membership_dependencies.py` plan and purge `group_access` rows that reference the department or module. Remove the `DEFAULT_DEPARTMENT_REFERENCE` close blocker in `sandbox/lifecycle/planning.py:99-120`.
9. Update `operations/reset/models.py` (`_PROFILE_STATEMENT`, `_ROLES_STATEMENT`, `_ACCESS_POLICY_*_STATEMENT`, `_EFFECTIVE_ADMIN_PROFILES_STATEMENT`, `_PROFILE_DELETE_COUNTS_STATEMENT`, the table constants), `operations/reset/planning.py:42-43,68-69,263-304`, and `backend/tests/fullstack_runner.py:147-157` (`User(role=...)`) in this pull request. The coverage gate fails without the runner change.
10. SSE: remove `roles` from `_ADMINISTRATOR_ENTITIES`; put `groups`, `group_members` and `group_access` in `_ENTITY_ONLY_ENTITIES`.
11. Update root `AGENTS.md`: the sentence "Authorization uses ten flat read/write capabilities; …" describes the old model.
12. Remove the role branches of the audience and grant code, because `user.role_id` no longer exists: `boards/access.py:116,138` (role grants), `boards/announcement_service.py:278-363`, `boards/event_router.py:104-148,233-271`, `boards/widget_router.py:83-111`, `boards/grant_router.py` (`/grant-roles`), `openview/views/access.py`, `openview/reports/audience.py`, `openview/reports/audience_router.py` (`/audience-roles`), `openview/views/catalog.py` (`/audience-options?kind=role`). The user, everyone and department audiences stay until slices 4 and 5.
13. Frontend consumers in the same pull request: `frontend/src/lib/auth-api.ts:20-32` (`role_id` → `role`, add `access`), `openview/adapters/openview-queries.ts:9`, `openview/components/server-backed-reports.tsx:17`, and the role options in `openview/adapters/reports-api.ts:214,371,498`, `report-audience-selector.tsx`, `report-draft.ts:59-60`, `views-api.ts`, `boards/components/board-content-audience-picker.tsx` and `server-backed-board-grants.tsx`.

**Tests.**
- The custom-role, rules/default-policy, service-identity and capability-catalog test inventory is retired. Current Access protection lives under [Access](../../backend/tests/access/), [users](../../backend/tests/users/) and [RBAC](../../backend/tests/rbac/); do not use the old removed file list as runnable evidence.
- Split: `test_access_configuration_router.py`, `test_access_group_defaults_service.py`, `test_access_group_deletion_concurrency.py`, `test_access_group_deletion_integration.py`. Keep the group cases.
- Change the shared helper `tests/rbac/support.py`: `make_user(role=...)`, a new `make_group_access(...)`, and remove `_PolicySnapshotDatabase`. Update the local builders in `tests/files/conftest.py:21-27`, `tests/security_events/support.py:89`, `tests/access/test_last_admin_concurrency.py` and `tests/access/test_admin_sessions.py`. About 128 setup-only files then need only import changes.
- Current identity/recovery and reset protection: [recovery contracts](../../backend/tests/auth/test_auth_recovery_contracts.py), [provider auth](../../backend/tests/auth/test_provider_auth_integration.py), [user tests](../../backend/tests/users/), [lifecycle](../../backend/tests/lifecycle/) and [Access reset integration](../../backend/tests/reset_application_data/test_access_reset_integration.py).

#### 3c: The access function and every read path

1. Add `backend/app/systems/access/policy/scope.py` with `effective_levels(db, user)`, `allowed_module_ids(db, user, level)` and `level_for(db, user, department_id, module_id)`. Rules: administrator has `manage` everywhere; inactive, pending or expired users have nothing; the most specific row of each group wins; the highest level across groups wins; a guest is capped at `read`.
2. Replace `require_capability`, `require_all_capabilities`, `require_legacy_capability` (47 sites), `require_fresh_capabilities`, `has_capability`, `effective_permissions`, `authorize_workspace_capabilities` and `check_workspace_access`. Delete the dead `require_fresh_legacy_capabilities`. Delete `access/users/permissions.py`, `access/policy/evaluator.py` and `access/policy/authorization.py`. The three step-up checks get named replacements:
   - `sandbox/publications/router.py:118` (publish): `require_fresh_exact_admin`.
   - `sandbox/records/query_router.py:93` (aggregate snapshot): a fresh `level_for(..., 'read')` on the module inside the snapshot transaction.
   - `openview/reports/router.py:357` (on-demand run): the same fresh module read check.
   The plain calls of `authorize_workspace_capabilities` in `openview/reports/run_service.py:133`, `platform/files/access.py:40`, `platform/scheduling/execution.py:90` and `sandbox/publications/router.py:70` get the same treatment.
3. Apply the filter at every point in the leak checklist:

| Path | Filter point |
|---|---|
| `records/router.py` list, get, create, update, delete, restore | `list_records`, `_record()` (276), `_active_module` and `_lock_active_module` (283-304) |
| `records/query.py` query, grouped, window, aggregate, aggregate snapshot, CSV export | `compile_query` (157) or `validate_definition` (67), shared by all eight endpoints |
| `relationships/router.py` list, get, create, delete, assign | `projection.py:101-163` (both endpoints readable, else the edge is hidden), `mutations.py` (`write` on the source module, `read` on the target module) |
| `platform/files/access.py:33` and `parent()` (149-179) | Check the record module, which `parent()` already loads |
| `openview/reports/run_service.py:128` capture | Covered by `compile_query`; the actor is the workspace after slice 4 |
| `openview/reports/audience.py:74` eligibility | Only users who can read the report module |
| `openview/reports/run_reader_router.py` run reads | Recheck `read` on the report module at read time |
| `openview/views/access.py` `visible_to` | Require `read` on the view module |
| `sandbox/modules/router.py`, `departments/router.py`, `fields/router.py` `GET` | Return only readable departments, modules and fields |
| `platform/events/models.py:100` and `hub.py:182` | Default D10: add `module_id` to record and relationship events; filter in `_can_receive`. Change the frontend consumer `openview/components/openview-query-sync.tsx` in the same pull request. |
| `boards/record_link_service.py:35` | Mark a link unavailable when the user cannot read its module |
| Sandbox, publications, test runs, lifecycle, triggers | Administrator only (default D9) |

4. Tests: for each row of the table, one database test with a user who has no group for the department, and one with a guest who tries to write. Tests of the current flat checks in `tests/rbac/test_permissions.py`, `test_domain_routes.py`, `tests/files/test_workspace_policy*.py`, `tests/events/*` and `tests/record_queries/*` are rewritten.

#### 3d: Manager delegation

1. A user with `manage` on every department that a group's `group_access` rows reference can change the members of that group. Other group changes stay administrator-only.
2. Tests: a manager of Inventory can add a member to an Inventory-only group; the same manager gets 403 for a group that also reaches Finance.

#### 3e: Access screens

1. Remove (about 8,500 lines): `adapters/federated-adapters.ts`, `adapters/adapters.ts`, `components/identity-access-check.tsx`, `components/permission-rules.tsx`, `components/reviews-view.tsx` (already unreachable), `components/role-management.tsx`, the `RoleEditor` part of `components/role-group-editors.tsx` (lines 307-1033), `domain/policy.ts`, `domain/policy-bundle.ts`, most of `domain/controller-commands.ts` and `domain/controller-policy.ts`, `state/simulator-check.ts` and `state/sample-projection.ts`.
2. Rebuild (about 13,500 lines) with TanStack Query (default D5): people directory without services, the invitation form with role and groups, the identity editor and preview without the simulator tab, the groups editor with a department and module access editor, an effective-access view for a user (level, module and the group that gives it), the organization chart grouped through groups, the overview health cards (last administrator, groups without access, users without groups, guests that expire soon), and the invitation settings.
3. Keep: `access-search-toolbar.tsx`, `state/draft-journal-storage.ts`, `state/draft-navigation.tsx`, `helpers/editor-helpers.ts`, and the conflict helpers in `role-group-editors.tsx` (lines 88-306).
4. Remove the unused `CAPABILITIES`, `Role`, `RolePermissions` and `User.role_id` types from `frontend/src/lib/api.ts:163-181`.
5. Current frontend protection follows the four-view Access surface under [HTTP tests](../../frontend/tests/http/) and [real-stack Access controls](../../frontend/tests/fullstack/access-controls.spec.ts). Removed role/rules/review/sample-boundary tests and the old Defaults case are not current test targets.

**Acceptance criteria for slice 3.**

| ID | Criterion |
|---|---|
| S3-1 | A member with no group for Finance gets no Finance record from any path in the 3c table. |
| S3-2 | A member whose group has `read` on Inventory and `write` on the Prices module can write Prices records and cannot write other Inventory records. |
| S3-3 | A user in two groups gets the highest level for each module. |
| S3-4 | A guest in a `write` group cannot create, change or delete a record. |
| S3-5 | An administrator reads and writes everything. |
| S3-6 | An SSE subscriber without Finance access receives no Finance record events. |
| S3-7 | A report run lists only eligible users who can read its module, and a user who lost access cannot open the run. |
| S3-8 | An invitation with `role = guest` requires a sponsor and gets the configured guest duration. |
| S3-9 | The removed routes return 404, and the frontend has no reference to them. |
| S3-10 | The Access screens pass the visual loop at both widths and a `ui-reviewer` pass. |

### Slice 4: OpenView belongs to departments

**Schema.**

```sql
-- Development dashboards have no department. Reset application data before this revision (approval gate).
ALTER TABLE dashboards
  ADD COLUMN department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  ADD COLUMN position int NOT NULL DEFAULT 0,
  DROP COLUMN owner_id;
ALTER TABLE saved_views DROP COLUMN owner_id, DROP COLUMN visibility, DROP COLUMN audience_kind,
  DROP COLUMN audience_role_id, DROP COLUMN audience_user_id,
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;
-- unique (module_id) WHERE is_default AND NOT is_deleted
ALTER TABLE reports DROP COLUMN owner_id, DROP COLUMN audience_kind,
  DROP COLUMN audience_role_id, DROP COLUMN audience_user_id;
DROP TABLE dashboard_defaults, saved_view_defaults, openview_chart_preferences;
```

`dashboards.refresh_cadence` stays. The dashboard default foreign key that pointed to `(dashboards.id, dashboards.owner_id)` goes with `dashboard_defaults`.

**Backend.**

1. Dashboards: remove `_owner_clause` (`dashboards/router.py:83-95`) and `GET` and `PUT /api/dashboards/default`. Reading needs `read` on the department; writing needs `manage`. The service rule checks that each widget module belongs to the dashboard department (`dashboards/widget_validation.py`).
2. Views: remove `GET /api/views/audience-options` and `GET`, `PUT` and `DELETE /api/views/defaults[/{module_id}]` (`views/catalog.py`). `visible_to` is module `read`. Create, change and delete need `manage`. Setting `is_default` clears the old default of the module in one transaction.
3. Reports: remove `GET /api/reports/audience-roles` and `/audience-users` (`reports/audience_router.py`) and `_owner_clause` (`reports/router.py:97-109`). Reading needs module `read`; changes and schedules need `manage`. Replace `_eligible_owner` (`platform/scheduling/service.py:55-75`) with a workspace actor; `execution.py:88-96` and `run_service.py:128-139` capture without a user. The run audit label is "Scheduled report: <name>" for scheduled runs; on-demand runs keep the requesting user. `capture_run_eligible_users` stores all module readers at run time.
4. Charts: remove `openview/charts/router.py` and `models.py`, and `GET` and `PUT /api/charts/preferences`.
5. SSE: remove `saved_view_defaults` from the sets; keep `saved_views` as entity only, now filtered by module (default D10).
6. `reset/models.py`: remove the three dropped tables.

**Frontend.** Remove `adapters/chart-preferences-api.ts`, `components/report-audience-selector.tsx` and `components/audience-confirmation.tsx`. Change `adapters/dashboards-api.ts` (owner, default calls at lines 929 and 938), `adapters/views-api.ts` (audience options, defaults, `isDefault`), `components/report-recipe-editor.tsx`, `report-draft.ts`, `report-schedule-controls.tsx`, `adapters/report-schedule-api.ts`, and the four `server-backed-*` workspaces. Temporary filters stay in the URL. Hide create and edit controls from users without `manage`.

**Current tests.** [Dashboards](../../backend/tests/dashboards/), [Reports](../../backend/tests/reports/), [Charts](../../backend/tests/charts/), [scheduling](../../backend/tests/platform_scheduling/) and [migrations](../../backend/tests/migrations/) protect the current persistence boundaries. Personal defaults/audience-role/chart-preference tests from before the redesign are retired; shared saved Charts were added later and have their own current coverage.

**Acceptance criteria.**

| ID | Criterion |
|---|---|
| S4-1 | A member with `read` on Inventory sees every Inventory dashboard, view and report, and cannot change them. |
| S4-2 | A member with `manage` on Inventory creates a dashboard; a widget on a Finance module is refused. |
| S4-3 | Setting a default view clears the previous default of that module. |
| S4-4 | A scheduled report runs after every user who edited it is disabled. |
| S4-5 | A user who can no longer read the report module cannot open its runs. |
| S4-6 | No route, response field or screen mentions owner or audience in OpenView. |

### Slice 5: Boards

**Schema.**

1. Renames, with every constraint and index (checklist 3.2):

| Old | New |
|---|---|
| `board_announcements` | `board_posts` |
| `board_announcement_revisions` | `board_post_revisions` |
| `board_announcement_revision_attachments` | `board_post_revision_attachments` |
| `board_announcement_revision_record_links` | `board_post_revision_record_links` |
| `board_content_attachments` | `board_attachments` |
| `board_content_record_links` | `board_record_links` |
| column `announcement_id` (revisions, attachments, record links, `scheduled_work`) | `post_id` |

2. `boards`: add `scope text NOT NULL CHECK (scope IN ('company','department','project'))`, a CHECK that `department_id` is set only for `department`, a unique partial index on `scope` WHERE `scope = 'company'` AND NOT `is_deleted`, a unique partial index on `department_id` WHERE `scope = 'department'` AND NOT `is_deleted`; drop `owner_id` and `default_section`. Insert the company board and one board for each department (default D6).
3. `CREATE TABLE board_groups (board_id → boards, group_id → groups, level CHECK IN ('read','write','manage'))`, unique on the pair among active rows. A service rule allows rows only for project boards.
4. Drop the audience columns from `board_posts`, `board_post_revisions`, `board_events` and `board_widgets`, and `creator_id` from `board_widgets`.
5. Reminders: drop `recipient_id` and `occurrence_id`-per-recipient uniqueness; `board_event_reminders` becomes `(board_id, event_id, timing)` unique on `(event_id, timing)`. `scheduled_work` gets `occurrence_start_at` for `event-reminder`, and the unique constraint `uq_scheduled_work_reminder` becomes unique on `(reminder_id, occurrence_start_at)`. The constraint `uq_scheduled_work_announcement_occurrence` becomes `uq_scheduled_work_post_occurrence` on `(post_id, source_revision)`, and the kind value `announcement-publish` becomes `post-publish`.
6. Drop `board_grants`, `board_templates`, `board_favorites`, `board_homes`, `board_record_placements` and `board_announcement_personal_states`.
7. Replace the database functions (with `GRANT EXECUTE` again):

| Function | Change |
|---|---|
| `reject_board_announcement_revision_update` | Rename to `reject_board_post_revision_update`; trigger on `board_post_revisions` |
| `validate_board_content_attachment` | Rename to `validate_board_attachment`; body reads `board_posts` and `post_id` |
| `reject_board_content_owner_change` | Rename to `reject_board_attachment_owner_change`; body uses `post_id` |
| `validate_revision_attachment` | Body reads `board_post_revisions.post_id` |
| `reject_revision_attachment_update` | Trigger on `board_post_revision_attachments` |
| `board_record_link_guard` | Body reads `board_posts` and `post_id` (today it reads `board_announcements`) |
| `board_revision_record_link_guard` | Body reads `board_post_revisions` |
| `reject_file_board_move` | Unchanged; `files.board_id` stays |

**Backend.**

1. Replace `boards/access.py` (`can_access_board`, grant priority and deny) with `board_level(db, user, board)`: administrator `manage`; company board `read` for every active user and `manage` for administrators; department board = the department level; project board = the highest `board_groups` level of the user's groups.
2. Remove routers: `grant_router.py`, `personal_router.py`, `template_router.py`, `announcement_personal_router.py`, `placement_router.py`. Rewrite `access_preview_router.py` for `board_groups`.
3. Rename the route segment `/announcements` to `/posts` in `announcement_router.py`, `announcement_author_router.py` and `announcement_manage_state_router.py`.
4. Remove audience code: `announcement_service.py:278-363`, `event_router.py:104-148,233-271` and the audience branch of `announcement_inbox.py:72-121`. The inbox fans out to every user with `read` on the board.
5. Delete: a post that was never published is deleted with its attachments and scheduled work; a published post is archived (`announcement_router.py:445-497`). Only `lifecycle_router.py::purge_board` removes revisions.
6. Add `GET /api/boards/{board_id}/posts/{post_id}/revisions` (list, newest first) and `GET .../revisions/{revision_id}`. Readers of the board can use them.
7. Reminders: rewrite `reminder_router.py` and `reminder_service.py` for author-set timings (`write` on the board); rewrite `platform/scheduling/materializer.py` and `reminder_execution.py` to create one work row per reminder and occurrence and to notify every board reader.
8. Sandbox publish creates the department board for each new department (`publications/structure_mutations.py`). A department close archives its board; purge removes it.
9. Portability: drop `default_section` and widget audience from the bundle (`portability.py:257`, `portability_router.py:271,289-314`).
10. `lifecycle_router.py:71-83`: remove the dropped child models; add `BoardGroup`.
11. SSE: rename the entries in `_PRIVATE_INVALIDATION_ENTITIES`; remove `board_grants`, `board_record_placements`, `board_favorites`, `board_homes`, `board_templates` and `board_announcement_personal_states`; add `board_groups`.
12. `reset/models.py`: renames and drops.
13. Update `AGENTS.md`: Boards is built, not reserved.

**Frontend.** Remove `board-grants-api.ts`, `server-backed-board-grants.tsx`, `use-server-board-grants.ts`, `board-content-audience-api.ts`, `board-content-audience-picker.tsx`, `board-templates-api.ts`, `server-backed-board-templates.tsx`, `use-server-board-templates.ts`, `board-placements-api.ts` and `server-backed-board-placements.tsx`. Rebuild access preview for `board_groups`. Change the board management model (scope, groups), the post and event editors (no audience), the widgets (no audience), the reminders UI (author sets timings on the event), the delete confirmation copy, portability, and the rename to posts. Add an "Edited" link that opens the revision history.

**Current tests.** [Boards](../../backend/tests/boards/) and [scheduling](../../backend/tests/platform_scheduling/) cover scope/group access, posts/revisions, events/reminders, links, widgets and lifecycle. The old grants, personal announcements, placements and templates inventory is retired, not current protection. Current migrations and Board HTTP tests cover the replacement contracts.

**Acceptance criteria.**

| ID | Criterion |
|---|---|
| S5-1 | Every active user reads the company board; only administrators post on it. |
| S5-2 | A member with `write` on Inventory posts on the Inventory board; a member without Inventory access cannot see it. |
| S5-3 | Members of a group in `board_groups` read a project board; others cannot. |
| S5-4 | Publishing a post twice creates two revisions; a reader opens both. |
| S5-5 | Deleting a draft removes it; deleting a published post archives it and keeps its revisions. |
| S5-6 | A weekly event with a "1 day before" reminder notifies every board reader before each occurrence. |
| S5-7 | Each replaced database function rejects the same invalid rows as before. |
| S5-8 | A new department from a publish has its board. |

### Slice 6: Audit department

**Schema.** `ALTER TABLE audit_logs ADD COLUMN department_id uuid NULL;` with an index on `(department_id, created_at, id)`. No foreign key, like `entity_id`: audit entries outlive departments. `audit_logs` stays append-only; the column needs no new grant.

**Backend.**

1. In `manage/audit/listeners.py`, derive the department at write time: `departments` → its ID; `modules`, `saved_views`, `reports` → the module department; `fields`, `records` → through the module; `relationship_edges` → the source record module; `dashboards` → its column; `boards` → its department when the scope is `department`; `board_posts`, `board_events`, `board_widgets` and their children → through the board; `group_access` → its column. Everything else stays NULL.
2. `GET /api/audit-logs` accepts `department_id`. Managers must supply a department they manage at department level; an omitted or unauthorized department returns 403. Administrators may omit the filter to see everything. Apply the filter to both items and pagination totals. Audit responses include nullable `department_id`. Detail, export, and security-event routes remain administrator-only.

**Tests.** One test per entity family for the derived department; one test that a manager of Inventory gets 403 for Finance entries.

**Acceptance criteria.** S6-1: a record change in Inventory produces an entry with the Inventory department. S6-2: a manager of Inventory lists Inventory entries only.

### Slice 7: Field model

**Schema.**

```sql
ALTER TABLE modules ADD COLUMN title_field_id uuid NULL REFERENCES fields(id) ON DELETE RESTRICT;
ALTER TABLE fields DROP CONSTRAINT ck_fields_type,
  ADD CONSTRAINT ck_fields_type CHECK (type IN (... existing ..., 'user'));
ALTER TABLE board_record_links DROP COLUMN label;
ALTER TABLE board_post_revision_record_links DROP COLUMN label;
-- sandbox_documents / sandbox_versions CHECK schema_version = 4
```

Select options change inside `fields.config` from `["In stock", …]` to `[{"id": "<uuid>", "label": "In stock"}, …]`. Record values for select fields store the option ID. The migration must refuse incompatible nonempty field/record/link/history data or a nonempty Sandbox draft. An already-empty version-3 draft may become the empty version-4 draft without resetting accounts or provider data. If the guard finds content, obtain explicit approval for the separate application-data reset before proceeding; do not silently convert or discard it.

**Backend.**

1. `fields/validation.py`: validate option objects with unique IDs and labels; validate select values as option IDs; validate `user` values as IDs of active users with `read` on the module.
2. `modules.title_field_id`: a service rule requires an active field of the same module of type text, long text, email, URL, int, number, decimal or select.
3. Sandbox document version 4: option IDs, `titleFieldId` on modules and the `user` field type; the publish executor applies them.
4. Query compiler (`records/query.py`, `grouping.py`, `aggregation.py`): filters compare option IDs; grouping and CSV (`export.py`) and report capture show labels; `user` values show display names.
5. Record triggers: literal values of select and `user` fields store IDs.
6. New route `GET /api/modules/{module_id}/assignable-users` for the person picker.
7. Board record links show the live record title. Existing module and record data-source responses expose nullable `title_field_id`, so candidate selectors request and display that field too; no new metadata endpoint is needed.

**Frontend.** The Sandbox field editor (option editor with stable IDs, title field picker, `user` type), existing record forms (person picker), tables, filters and CSV display, and board record links. **Confirmed by the user on 2026-09-28:** keep OpenView's live record inspector read-only; extend existing forms, API, filters and displays rather than adding live record creation or editing to OpenView.

**Existing-form boundary.** Sandbox TestWorkspace is a draft-only trigger simulator, not a live record editor. Its module IDs have no exposed live binding, so person values there are explicitly simulated UUIDs and cannot claim current assignment eligibility. The live `assignable-users` picker serves published-module filters; live record writes and production trigger actions enforce active-user/module-read eligibility. Do not add a global user picker or a new binding API to make draft simulation appear live.

**Relationship mapping compatibility.** Preserve the existing label-based select mapping rule: source option labels must be contained in the target labels. Independently created fields may have different option IDs. The draft relationship simulator resolves the source ID to its label and then the matching target option ID before validating the projected value. Do not introduce shared option identities or a new mapping configuration. Missing labels remain incompatible.

**Board bundle portability.** Preserve version-3 named-source portability for select filters: export stored option IDs as labels and resolve imported labels to the target field's option IDs, including membership lists. Missing or ambiguous labels fail existing validation. Empty checks keep their null values. This adapts the existing portable contract without sharing option IDs across installations or changing the bundle version. User output-field references remain portable by field name and type, and value-free User checks remain supported. Reject value-bearing User filters on export and import: their installation-specific user UUIDs have no defined portable identity binding. Do not invent person-name matching, a new user directory, or a new bundle version; live User filters remain supported.

**Person read and write boundary.** Keep structural UUID validation separate from current eligibility: live create, explicitly supplied update values, restore and production trigger assignments check the selected user through the existing module-reader policy. Preserve the existing PATCH contract: supplying `data` replaces the active field values, so explicitly included person IDs are revalidated even when unchanged. A PATCH that does not replace `data` may retain unavailable person values. Moving a record to another module remains unsupported (409); this slice adds no move capability. Querying historical values and draft simulation do not grant assignment eligibility. The module-scoped picker returns only ID, display name and username to callers who can read that module. Raw record and grouping values remain IDs; transient display labels use the same eligibility-aware resolver for reads, grouping, CSV and report capture. Select equality and membership compare IDs. Existing select contains filters resolve their selected option ID to its current label; global select search uses labels rather than UUIDs. An ineligible trigger assignment follows the existing validation-failure transaction rollback and bounded retry/terminal-failure path; do not silently skip an action or add a new failure framework.

**Title lifecycle and display defaults.** A standalone close or purge of the selected title field is blocked until a Sandbox publication clears or changes the selection. Closing a whole module or department preserves the selection for reopening; reopening validates the selection against the effective active fields. Purging a whole module or department clears title pointers on the modules being purged in the same audited transaction before deleting their fields. Publication resolves title selections after field bindings and before closing removed structure. An absent or empty title displays the existing `Record <first eight ID characters>` fallback. Person pickers offer only active module readers; stored person values that are no longer eligible display `Unavailable user`, while the stored ID remains unchanged. These are implementation defaults within the field contract, not broader lifecycle or user-directory changes.

**Acceptance criteria.**

| ID | Criterion |
|---|---|
| S7-1 | Renaming a select option in the Sandbox changes the label on every record, filter and group. |
| S7-2 | A `user` field accepts only active users who can read the module. |
| S7-3 | A board record link shows the current value of the record title field. |
| S7-4 | CSV export shows option labels and user display names. |

### Slice 8: New fresh-install root

1. Generate one revision with `down_revision = None` that creates the final schema, the grants and default privileges, every database function with its `EXECUTE` grant, and the singleton rows (`sandbox_documents` version 4, the company board).
2. Move the slice revisions to `backend/migrations/history/schema_redesign/`, like `history/vanilla_postgresql/`.
3. Prove equality: apply the chain to one empty database and the new root to another; `pg_dump --schema-only` of the `public` schema must be identical, and `alembic check` must pass on both.
4. Update `docs/architecture/01-system-overview.md` and `06-data-architecture.md` with the root revision ID and the model-autogeneration, supplement-review, and schema-comparison procedure. The active root is `089c54b88aa6`; its predecessor chain is under `history/schema_redesign/`.
5. Caution: recreating the development database deletes the provider volume with its Auth and Storage state. Get approval, then follow `infra/supabase/README.md` for a fresh instance, `provision_database_role.py`, `alembic upgrade head`, `alembic check`, `provision_storage.py` and `bootstrap_admin.py`.
6. The [UI-equivalent sample plan](ui-equivalent-sample-data-plan.md) now uses supported record/relationship authoring, real Platform import/export and the department library. The original read-only OpenView population prerequisite is superseded.

Keep the existing record-trigger suspension columns and run-state value in this root: execution still reads them. Removing dormant write paths or columns is separate cleanup; the new root must reproduce the final chain without unrelated schema changes.

## 5. Per-table matrix

"SSE" names the change in `platform/events/models.py`. "Reset" means the four constants in `operations/reset/models.py`. "Fn" means database functions.

| Table (current) | Target | Slice | Migration | Fn / grants | SSE | Reset | Main tests | Frontend consumer |
|---|---|---|---|---|---|---|---|---|
| `users` | Δ `role`; − `role_id`, `identity_kind` | 3b | Backfill role, drop columns | – | Keep administrator | Profile SQL | `rbac/support.py`, auth, users | Access people, identity response |
| `roles` | Removed | 3b | Drop | – | Remove | Remove | Delete role tests | Access roles (removed) |
| `user_departments` | Removed | 3b | Drop | – | – | Remove | Lifecycle membership | Org chart (rebuilt) |
| `access_groups` | `groups` | 3b | Rename | – | Entity only | Rename | Group tests | Groups editor |
| `access_group_members` | `group_members` | 3b | Rename | – | Entity only | Rename | Group tests | Groups editor |
| – | + `group_access` | 3b | Create | – | Entity only | Add | Scope tests (3c) | Access editor |
| `access_rules` | Removed | 3b | Drop | – | – | Remove | Delete rule tests | Rules UI (removed) |
| `access_policy_versions` | Removed | 3b | Drop | – | – | Remove | Delete | – |
| `access_policy_defaults` | Removed | 3b | Drop; settings to `workspace_profiles` | – | – | Remove | Delete defaults tests | Defaults dialog (rebuilt) |
| `access_default_groups` | Removed | 3b | Drop | – | – | Remove | Delete | – |
| `access_default_departments` | Removed | 3b | Drop | – | – | Remove | Lifecycle planning | – |
| `service_identities` | Removed | 3b | Drop | – | – | Remove | Delete service tests | Services tab (removed) |
| `identity_sessions` | Unchanged | – | – | – | – | – | – | Sessions |
| `identity_rate_limit_buckets` | Unchanged | – | – | – | – | – | – | – |
| `departments` | Unchanged | 1, 3c | – | – | Filter by access | – | Catalog, lifecycle | Lists |
| `modules` | − `is_schema_accepted`; + `title_field_id` | 1, 7 | Drop column; add column | – | Filter by access | – | Catalog, records | Sandbox, OpenView |
| `fields` | Type `user`; option IDs in config | 7 | CHECK change | – | Filter by access | – | Field validation | Sandbox field editor |
| `records` | Select and user values are IDs | 3c, 7 | – | – | + `module_id`, filtered | – | Record queries | OpenView tables |
| `relationship_edges` | Unchanged | 3c | – | – | + `module_id`, filtered | – | Relationships | OpenView |
| `published_automation_definitions` | `record_triggers` | 2 | Rename, column rename | – | – | Rename | Trigger tests | Sandbox triggers |
| `published_automation_conditions` | `record_trigger_conditions` | 2 | Rename | – | – | Rename | Trigger tests | Sandbox triggers |
| `published_automation_actions` | `record_trigger_actions` | 2 | Rename | – | – | Rename | Trigger tests | Sandbox triggers |
| `published_automation_events` | `record_trigger_events` | 2 | Rename | – | – | Rename | Trigger tests | – |
| `published_automation_runs` | `record_trigger_runs` | 2 | Rename | – | – | Rename | Trigger run route | Trigger runs list |
| `sandbox_documents` | Version 3, then 4 | 2, 7 | CHECK, replace row | – | – | – | Designs | Sandbox |
| `sandbox_versions` | Version CHECK | 2, 7 | CHECK | – | – | – | Designs | Versions |
| `sandbox_publications` | Unchanged | – | – | – | – | – | Publications | Publish dialog |
| `sandbox_bindings` | `kind 'trigger'`, `trigger_id` | 2 | Update rows, CHECK, rename column | – | – | – | Planner | – |
| `sandbox_test_runs` | `trigger_ids` | 2 | Rename column | – | – | – | Test runs | Test workspace |
| `lifecycle_confirmation_challenges` | Unchanged | – | – | – | – | – | Lifecycle | Close dialogs |
| `lifecycle_rate_limit_buckets` | Unchanged | – | – | – | – | – | – | – |
| `lifecycle_rate_limit_failures` | Unchanged | – | – | – | – | – | – | – |
| `dashboards` | + `department_id`, `position`; − `owner_id` | 4 | Columns | – | Private (keep) | – | Dashboard routes | Dashboards |
| `dashboard_widgets` | Unchanged | 4 | – | – | – | – | Widget validation | Widgets |
| `dashboard_defaults` | Removed | 4 | Drop | – | – | Remove | Delete | Default picker (removed) |
| `saved_views` | − owner and audience; + `is_default` | 3b (role audience), 4 | Columns, partial unique index | – | Entity only, filtered | – | View routes | Views |
| `saved_view_defaults` | Removed | 4 | Drop | – | Remove | Remove | Delete | Default picker (removed) |
| `openview_chart_preferences` | Removed | 4 | Drop | – | – | Remove | Delete chart tests | Charts screen (removed) |
| `reports` | − owner and audience | 3b (role audience), 4 | Columns | – | Private (keep) | – | Report routes | Reports |
| `report_runs` | Unchanged | 4 | – | – | Private (keep) | – | Run routes | Runs |
| `report_run_rows` | Unchanged | – | – | – | Private (keep) | – | Runs | Runs |
| `report_run_eligible_users` | Unchanged; module readers | 3c, 4 | – | – | – | – | Eligibility | – |
| `report_schedules` | Unchanged; `manage` | 4 | – | – | Private (keep) | – | Schedule routes | Schedule controls |
| `boards` | + `scope`; − `owner_id`, `default_section` | 5 | Columns, indexes, seed rows | – | Private (keep) | – | Board routes | Board management |
| – | + `board_groups` | 5 | Create | – | Private | Add | Board access | Project board settings |
| `board_grants` | Removed | 3b (role principal), 5 | Drop | – | Remove | Remove | Delete grant tests | Grants UI (removed) |
| `board_widgets` | − audience, `creator_id` | 3b (role audience), 5 | Columns | – | Private (keep) | – | Widget tests | Board widgets |
| `board_record_placements` | Removed | 5 | Drop | – | Remove | Remove | Delete | Placements UI (removed) |
| `board_favorites` | Removed | 5 | Drop | – | Remove | Remove | Delete | None |
| `board_homes` | Removed | 5 | Drop | – | Remove | Remove | Delete | None |
| `board_templates` | Removed | 5 | Drop | – | Remove | Remove | Delete | Templates UI (removed) |
| `board_events` | − audience | 3b (role audience), 5 | Columns | – | Private (keep) | – | Event tests | Calendar |
| `board_event_reminders` | Author timings | 5 | Columns, unique | – | – | – | Reminder tests | Event editor |
| `board_announcements` | `board_posts`, − audience | 3b (role audience), 5 | Rename, columns | Guard fns read it | Rename | Rename | Post tests | Posts |
| `board_announcement_revisions` | `board_post_revisions` | 3b (role audience), 5 | Rename, `post_id` | Immutable trigger | Rename | Rename | Revision tests | Edit history (new) |
| `board_announcement_revision_attachments` | `board_post_revision_attachments` | 5 | Rename | Two fns | – | Rename | Attachment tests | Attachments |
| `board_announcement_revision_record_links` | `board_post_revision_record_links` | 5, 7 | Rename; drop `label` | One fn | – | Rename | Link tests | Record links |
| `board_content_attachments` | `board_attachments` | 5 | Rename, `post_id` | Two fns | – | Rename | Attachment tests | Attachments |
| `board_content_record_links` | `board_record_links` | 5, 7 | Rename; drop `label` | One fn | – | Rename | Link tests | Record links |
| `board_announcement_personal_states` | Removed | 5 | Drop | – | Remove | Remove | Delete | Read state (removed) |
| `files` | Unchanged | 3c | – | `reject_file_board_move` unchanged | Keep | – | File access | Attachments |
| `scheduled_work` | `post_id`, `occurrence_start_at` | 5 | Columns, CHECK, unique | – | – | – | Scheduling | – |
| `in_app_notifications` | Unchanged | – | – | – | Private recipient | – | Notification routes | Notifications |
| `audit_logs` | + `department_id` | 2, 6 | Column, index; `actor_label` written | Append-only kept | Keep | – | Audit tests | Audit |
| `security_events` | Unchanged | – | – | Append-only | Keep | – | – | Audit |
| `workspace_profiles` | + invitation settings | 3b | Columns | – | Keep | – | Workspace routes | Invitation settings |

## 6. Documentation

| Slice | Documents |
|---|---|
| 1 | `docs/architecture/07-api-architecture.md`, `03-domain-architecture.md`, `backend/AGENTS.md:49` (names the seeder) |
| 2 | `03-domain-architecture.md`, `09-lifecycle-and-state-management.md`, `10-audit-and-history.md`, `21-glossary.md` |
| 3 | `08-authentication-authorization.md`, `14-security-architecture.md`, `05-frontend-architecture.md`, `13-runtime-flows.md`, root `AGENTS.md` |
| 4 | `03-domain-architecture.md`, `06-data-architecture.md` |
| 5 | `03-domain-architecture.md`, root `AGENTS.md` (Boards is built) |
| 6 | `10-audit-and-history.md` |
| 7 | `06-data-architecture.md` (option IDs, user values) |
| 8 | `01-system-overview.md`, `06-data-architecture.md` |

Skills in `.agents/skills/` that describe the flat capabilities (`webapp-security-review`, `postgres-patterns`, `fastapi-backend-patterns`) need the same update in slice 3. They are local files, not tracked by Git.

## 7. Risks and rollback

| Risk | Control |
|---|---|
| A read path without the access filter leaks records. | One function, the 3c checklist, and one denial test for each row. |
| A renamed table falls through the SSE classification and broadcasts. | Checklist 3.2 step 4, and a test that lists every audited table and its classification. |
| A database function still names an old table. | Checklist 3.2 step 3, a test for each function, and a query for old names in `pg_proc.prosrc`. |
| A constraint or index keeps an old name, and `alembic check` passes anyway. | Definition of done step 3. |
| The integration branch drifts from main. | Merge main into it after each sub-slice. |
| The new root differs from the chain. | The schema dump comparison in slice 8. |
| A manager escalates access through a shared group. | Slice 3d rule and its tests. |

**Rollback.** Use only the downgrade supported by the specific revision. Slice 7 deliberately refuses downgrade: option IDs and removed Board labels cannot be converted losslessly to version 3. Recover that development lineage through an approved fresh initialization or a supported backup restoration, rather than inventing lost values. Other supported downgrades of dropped tables recreate empty tables. After slice 8, restoring the old lineage requires the archived chain and a compatible database; do not stamp an existing database onto the new root.

## 8. Open items

| Item | Needed before |
|---|---|
| Spec decision 6: library documents. Remain deferred with files. | After this plan |
| Spec decisions 9 and 10: generated `is_deleted` and soft delete only on restorable tables. Continuation scope default: defer beyond these eight slices; neither is included in the implementation checklist. | Separate follow-up unless the user expands scope |
| Spec decision 11: one rate-limit table. Remains deferred; not in any slice. | Optional follow-up |
| Spec decision 14: `actor_label` for users. Keep the spec's existing declined status; slice 2 adds the write path for triggers only. | Separate user decision |
| Revalidate the "rewrite" test lists. The investigations classified many files by name and code path, not line by line. | Start of each slice |
