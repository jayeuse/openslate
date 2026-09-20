# System Overview

> **Scope:** Current OpenSlate runtime, ownership boundaries, and implementation status.

OpenSlate is a self-hosted web application for configurable business operations. A Next.js interface and a FastAPI application run behind one same-origin Caddy gateway. FastAPI owns identity, authorization, application data, files, audit capture, and server-sent invalidation events.

## Current runtime

| Concern | Current owner |
| --- | --- |
| Browser UI | Next.js and React |
| Gateway | Caddy: `/api` to FastAPI and remaining paths to Next.js |
| Business API and authorization | FastAPI with synchronous SQLAlchemy |
| Schema and durable state | PostgreSQL and Alembic |
| Identity | FastAPI Identity tables: credentials, sessions, action tokens, and rate-limit buckets |
| Files | PostgreSQL metadata plus private local filesystem bytes |
| Invalidation | Authenticated SSE backed by PostgreSQL `LISTEN`/`NOTIFY` |

The browser never writes application rows directly. FastAPI uses the runtime PostgreSQL role; Alembic uses the owner connection. Application mutations use `AuditSession` and produce transactional, redacted audit rows.

## Status boundaries

- Local PostgreSQL, FastAPI Identity, private filesystem storage, Caddy configuration, and authenticated SSE are implemented in the repository.
- The workspace remains UI-first for much visible sample business state. Do not present sample interactions as persisted business automation.
- SMTP delivery is optional and disabled by default. When enabled, FastAPI queues encrypted invitation and recovery payloads in PostgreSQL, then a bounded worker delivers them through the configured SMTP transport.
- Signed Windows/macOS server-app installers, automated setup, bundled database lifecycle, and tested backup/restore are planned rather than implemented.

See [system context](02-system-context.md), [data architecture](06-data-architecture.md), and [deployment architecture](12-deployment-architecture.md).
