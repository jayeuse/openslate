# Architecture Decisions

> **Scope:** Current decisions guiding the local architecture.

| Decision | Rationale | Consequence |
| --- | --- | --- |
| FastAPI owns identity | One local application and PostgreSQL authority for credentials, sessions, invitations, and recovery | Argon2/JWT/cookie and bearer contracts are implemented in FastAPI |
| PostgreSQL is the only relational service | Easier self-hosted operation and one schema owner | Alembic baseline, owner/runtime roles, and disposable data path |
| Private filesystem bytes with PostgreSQL metadata | Closest local equivalent to private object storage without a separate service | Quarantine, immutable ready objects, scanner gate, and backup coupling |
| Same-origin Caddy gateway | Keeps browser sessions and CSRF on one origin | `/api` and `/api/events` route to FastAPI; UI routes go to Next.js |
| PostgreSQL notification plus SSE | Opaque invalidation without a second data API | Clients resync through authorized reads |
| Optional SMTP outbox | Installation must work without a mail server while allowing configured action delivery | Encrypted PostgreSQL outbox and bounded SMTP worker are implemented; delivery is disabled by default and at least once |

Windows/macOS packaging, bundled PostgreSQL service management, encrypted backups, and automatic setup remain implementation decisions still to be proven by native acceptance tests.
