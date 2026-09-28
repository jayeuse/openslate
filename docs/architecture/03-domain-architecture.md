# Domain Architecture

> **Scope:** Business capabilities and their durable boundaries.

OpenSlate groups domain behavior under FastAPI `systems` packages:

| Area | Responsibilities |
| --- | --- |
| `access` | Supabase Auth identity binding, application users, roles, groups, Access policy, invitations, recovery, service-identity metadata |
| `sandbox` | Shared design draft/history, safe publication, departments, modules, fields, records, relationships, lifecycle, temporary tests, and record trigger execution |
| `openview` | Department dashboards, shared saved views, reports, frozen report runs and schedules |
| `boards` | Shared boards, grants, widgets, announcements, events, reminders, attachments and record links |
| `manage` | Workspace profile and audit history |
| `platform` | Private files and scan queue, SSE invalidations, scheduled work, and in-app notifications |

Users and roles are application-owned rows in the [user model](../../backend/app/systems/access/users/models.py). Supabase Auth owns password credentials and email-action tokens; a provider subject must be explicitly bound to an eligible OpenSlate profile before it can start an application session. OpenSlate keeps revocable [`IdentitySession`](../../backend/app/systems/access/identity/models.py) rows and rate-limit buckets in its own PostgreSQL schema. Each session binds the provider user and session IDs, stores a digest of its opaque refresh handle, and retains the encrypted current provider token pair. The literal `admin` role has all capabilities; malformed permission documents fail closed. See [data architecture](06-data-architecture.md#identity-and-files) and [authentication and authorization](08-authentication-authorization.md).

Files have application metadata in the [file model](../../backend/app/systems/platform/files/models.py), an opaque object key, scan state, and nullable `enc_version`. Bytes stay in private Supabase Storage quarantine and ready buckets through the [Storage adapter](../../backend/app/systems/platform/files/supabase_storage.py). FastAPI mediates access; metadata alone never makes bytes readable, and download remains denied until the [scan and promotion workflow](../../backend/app/systems/platform/files/scan_processing.py) has completed ClamAV scanning and integrity verification.

The Sandbox publish is the only way to create or change departments, modules, and fields. A published module accepts new records while it has at least one active field; there is no separate schema acceptance step.

OpenView content belongs to departments. There is no personal content and no audience on a view or a report:

1. A dashboard belongs to one department and has a `position` in it. A user who can read something in the department reads its dashboards. Only `manage` on the department, or an administrator, creates, changes or archives a dashboard. Each widget must read a module of the dashboard's department.
2. A saved view and a report belong to one module, and so to its department. Every user who can read the module reads them. Only `manage` on the module creates, changes or deletes them, and sets report schedules. One active view of each module can be its default; making a view the default clears the previous default in the same transaction.
3. Any non-guest reader of the module runs a report on demand, and the run keeps that user as its actor. A scheduled run acts as the workspace: its audit entries have no user in `performed_by` and carry `actor_label = "Scheduled report: <name>"`, and it keeps running after every user who edited the report is disabled.
4. The users who can read the module when a run is created may open that run. Access is checked again when a run is opened, so a user who loses read on the module cannot open earlier runs.
5. Chart settings are not saved. The Charts screen keeps them for the open page only.
6. A department purge removes the department's dashboards and their widgets, as it removes the saved views of its modules. A widget in another department's dashboard that reads a purged module or field blocks the purge.

Lifecycle and audit behavior are application services. Audit captures ORM mutations in the same transaction as the domain change; Alembic and direct SQL are outside that capture boundary.
