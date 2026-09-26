# Architecture Decisions

> **Scope:** Current decisions guiding the local architecture.

| Decision | Rationale | Consequence |
| --- | --- | --- |
| FastAPI owns identity | One local application and PostgreSQL authority for credentials, sessions, invitations, and recovery | Argon2/JWT/cookie and bearer contracts are implemented in FastAPI |
| PostgreSQL is the only relational service | Easier self-hosted operation and one schema owner | Alembic baseline, owner/runtime roles, and disposable data path |
| Private filesystem bytes with PostgreSQL metadata | Closest local equivalent to private object storage without a separate service | Quarantine, immutable ready objects, scanner gate, and backup coupling |
| FastAPI-only production server | Remove the Node.js runtime while preserving the React/Next.js authoring model | Next.js produces static assets at build time; FastAPI serves UI, API, SSE, and 404 responses from one versioned payload |
| Caddy only for opt-in production-level paths | Daily work does not need TLS, a gateway container, or a second browser URL | The installed `gateway` profile stays disabled; production Caddy has one FastAPI upstream, while daily `next dev` directly serves the browser origin and proxies `/api` to FastAPI |
| PostgreSQL notification plus SSE | Opaque invalidation without a second data API | Clients resync through authorized reads |
| Optional SMTP outbox | Installation must work without a mail server while allowing configured action delivery | Encrypted PostgreSQL outbox and bounded SMTP worker are implemented; delivery is disabled by default and at least once |

Encrypted backups have a standalone guarded foundation. Windows/macOS
packaging, bundled PostgreSQL service management, automatic setup, backup
scheduling and supported customer recovery remain incomplete and require
native acceptance before release.
