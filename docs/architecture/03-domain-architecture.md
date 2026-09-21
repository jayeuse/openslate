# Domain Architecture

> **Scope:** Business capabilities and their durable boundaries.

OpenSlate groups domain behavior under FastAPI `systems` packages:

| Area | Responsibilities |
| --- | --- |
| `access` | Local identity, users, roles, permissions, invitations, recovery |
| `sandbox` | Shared design draft/history, safe publication, departments, modules, fields, records, relationships, lifecycle, temporary tests, and published automation execution |
| `openview` | Saved views |
| `manage` | Workspace profile and audit history |
| `platform` | Private files, scan queue, worker, and SSE events |

Users are application-owned rows with a role. Credentials, sessions, password and invitation action tokens, and throttling buckets are separate PostgreSQL tables. The literal `admin` role has all capabilities; malformed permission documents fail closed.

Files have application metadata, an opaque object key, scan state, and nullable `enc_version`. Bytes stay in a private quarantine or ready filesystem location. Metadata and bytes are intentionally separate: a database transaction cannot make a file readable until the scanner and promotion path have verified the object.

Lifecycle and audit behavior are application services. Audit captures ORM mutations in the same transaction as the domain change; Alembic and direct SQL are outside that capture boundary.
