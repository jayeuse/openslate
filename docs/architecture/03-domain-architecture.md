# Domain Architecture

> **Scope:** Business capabilities and their durable boundaries.

OpenSlate groups domain behavior under FastAPI `systems` packages:

| Area | Responsibilities |
| --- | --- |
| `access` | Supabase Auth identity binding, application users, roles, groups, group-access policy, invitations, and recovery |
| `sandbox` | Shared design draft/history, safe publication, departments, modules, fields, records, relationships, lifecycle, temporary tests, and record trigger execution |
| `openview` | Department dashboards, shared saved views, reports, frozen report runs and schedules |
| `boards` | The company Board, one Board for each department, project Boards and their groups; posts with their published revisions, events with author-set reminders, tiles, attachments and record links |
| `manage` | Workspace profile and audit history |
| `platform` | Private files, SSE invalidations, scheduled work, and in-app notifications |

User profiles and their role values are application-owned in the [user model](../../backend/app/systems/access/users/models.py). Supabase Auth owns password credentials and email-action tokens; a provider subject must be explicitly bound to an eligible OpenSlate profile before it can start an application session. OpenSlate keeps revocable [`IdentitySession`](../../backend/app/systems/access/identity/models.py) rows and rate-limit buckets in its own PostgreSQL schema. Each session binds the provider user and session IDs, stores a digest of its opaque refresh handle, and retains the encrypted current provider token pair. [`effective_levels`](../../backend/app/systems/access/policy/scope.py) resolves access from current account eligibility, role, and group-access rows: module rows override that group's department row, the highest level across groups wins, and a guest is limited to `read`. See [data architecture](06-data-architecture.md#identity-and-files) and [authentication and authorization](08-authentication-authorization.md).

Files have application metadata in the [file model](../../backend/app/systems/platform/files/models.py), an opaque object key, a lifecycle state, and nullable `enc_version`. Bytes stay in the private Supabase Storage `openslate-ready` bucket through the [Storage adapter](../../backend/app/systems/platform/files/supabase_storage.py). FastAPI mediates access; metadata alone never makes bytes readable. The [file service](../../backend/app/systems/platform/files/service.py) validates the file type, writes the bytes, and marks the file `ready` in the same upload request; download is denied in every other state.

The Sandbox publish is the only way to create or change departments, modules, and fields. A published module accepts new records while it has at least one active field; there is no separate schema acceptance step.

A relationship field links records of its source module to records of one target module. The two modules can be in the same department or in two different active departments. To create, replace, or remove a link, a user needs `write` on the source module and `read` on the target module; a target the user cannot read is reported as missing (404). A user sees a link only when they can read both modules, and hidden links add nothing to lists or counts ([`relationships/access.py`](../../backend/app/systems/sandbox/relationships/access.py)). Lifecycle applies the same rules in both cases: close and reopen change no link rows, a purge removes the links of the purged rows, and a relationship field outside the purge that targets a purged module blocks the purge.

Server-backed OpenView content belongs to departments and modules. Dashboards, widgets, saved views, and Reports have no persisted per-person or role audience: their readers come from department or module access. Browser-local sample controls do not grant access. A Report run stores the module readers eligible when it is captured; reading its output also requires current module access ([`capture_run_eligible_users`](../../backend/app/systems/openview/reports/eligibility.py), [`run_reader_router.py`](../../backend/app/systems/openview/reports/run_reader_router.py)):

1. A dashboard belongs to one department and has a `position` in it. A user who can read something in the department reads its dashboards. Only `manage` on the department, or an administrator, creates, changes or archives a dashboard. Each widget must read a module of the dashboard's department.
2. A saved view and a report belong to one module, and so to its department. Every user who can read the module reads them. Only `manage` on the module creates, changes or deletes them, and sets report schedules. One active view of each module can be its default; making a view the default clears the previous default in the same transaction.
3. Any non-guest reader of the module runs a report on demand, and the run keeps that user as its actor. A scheduled run acts as the workspace: its audit entries have no user in `performed_by` and carry `actor_label = "Scheduled report: <name>"` ([`platform/scheduling/execution.py`](../../backend/app/systems/platform/scheduling/execution.py)); it keeps running after every user who edited the Report is disabled.
4. The module readers at run capture are stored as the run's eligible readers. Output requests check both that captured eligibility and current module read access, so a user who loses access cannot open an earlier run.
5. Chart settings are not saved. The Charts screen keeps them for the open page only.
6. A department purge removes the department's dashboards and their widgets, as it removes the saved views of its modules. A widget in another department's dashboard that reads a purged module or field blocks the purge.

Boards are for communication. The Board scope decides who sees it; there is no audience on a post, an event or a tile, and there is no personal Board state:

1. There is one company Board. Every active account reads it; only administrators post, add events and change tiles on it.
2. Each department has one Board. A Sandbox publish creates it for a new department and keeps its name equal to the department name; closing the department archives the Board and reopening restores it. The level on it is the department level ([`boards/access.py`](../../backend/app/systems/boards/access.py)); a user who reads only some modules of the department reads the Board. A department purge removes its Board and owned content, including published history, reminder work and notifications. Attached files must already have confirmed-purged bytes; references from other Boards still block source deletion. The [dependency inventory](../../backend/app/systems/sandbox/lifecycle/department_board_dependencies.py) and [lifecycle executor](../../backend/app/systems/sandbox/lifecycle/execution.py) include the owned graph in the locked, audited purge.
3. Administrators create project Boards and choose their groups in `board_groups`. The level on a project Board is the highest level of the user's groups there.
4. `read` shows posts, events and tiles. `write` adds posts and events and lets authors change, archive, and restore their own content ([`post_router.py`](../../backend/app/systems/boards/post_router.py), [`event_router.py`](../../backend/app/systems/boards/event_router.py)). `manage` also pins posts, changes tiles, and manages other users' posts and events. A guest reads at most.
5. Each publish of a post adds an immutable revision; readers open earlier versions through `GET /api/boards/{id}/posts/{post_id}/revisions`. Deleting a post that was never published removes it; deleting a published post archives it. Only the Board purge removes revisions.
6. The author sets reminder timings (at the start, 15 minutes before, 1 day before) on an event. The worker queues one `scheduled_work` row for each reminder and occurrence and notifies current Board readers when it is due. A reminder may be delivered through and including 15 minutes after its due time; older reminders expire without delivery.
7. Publication and reminder notifications go to every account that can read the Board when they are delivered.

Lifecycle and audit behavior are application services. Audit captures ORM mutations in the same transaction as the domain change; Alembic and direct SQL are outside that capture boundary.
