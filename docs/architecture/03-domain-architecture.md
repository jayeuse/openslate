# Domain Architecture

> **Scope:** Business capabilities and their durable boundaries.

OpenSlate groups domain behavior under FastAPI `systems` packages:

| Area | Responsibilities |
| --- | --- |
| `access` | Supabase Auth identity binding, application users, roles, groups, Access policy, invitations, recovery, service-identity metadata |
| `sandbox` | Shared design draft/history, safe publication, departments, modules, fields, records, relationships, lifecycle, temporary tests, and record trigger execution |
| `openview` | Saved views, chart preferences, dashboards, reports, frozen report runs and schedules |
| `boards` | Shared boards, grants, widgets, announcements, events, reminders, attachments and record links |
| `manage` | Workspace profile and audit history |
| `platform` | Private files and scan queue, SSE invalidations, scheduled work, and in-app notifications |

Users and roles are application-owned rows in the [user model](../../backend/app/systems/access/users/models.py). Supabase Auth owns password credentials and email-action tokens; a provider subject must be explicitly bound to an eligible OpenSlate profile before it can start an application session. OpenSlate keeps revocable [`IdentitySession`](../../backend/app/systems/access/identity/models.py) rows and rate-limit buckets in its own PostgreSQL schema. Each session binds the provider user and session IDs, stores a digest of its opaque refresh handle, and retains the encrypted current provider token pair. The literal `admin` role has all capabilities; malformed permission documents fail closed. See [data architecture](06-data-architecture.md#identity-and-files) and [authentication and authorization](08-authentication-authorization.md).

Files have application metadata in the [file model](../../backend/app/systems/platform/files/models.py), an opaque object key, scan state, and nullable `enc_version`. Bytes stay in private Supabase Storage quarantine and ready buckets through the [Storage adapter](../../backend/app/systems/platform/files/supabase_storage.py). FastAPI mediates access; metadata alone never makes bytes readable, and download remains denied until the [scan and promotion workflow](../../backend/app/systems/platform/files/scan_processing.py) has completed ClamAV scanning and integrity verification.

The Sandbox publish is the only way to create or change departments, modules, and fields. A published module accepts new records while it has at least one active field; there is no separate schema acceptance step.

Lifecycle and audit behavior are application services. Audit captures ORM mutations in the same transaction as the domain change; Alembic and direct SQL are outside that capture boundary.
