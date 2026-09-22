# System Overview

> **Scope:** OpenSlate's production-server contract, ownership boundaries, and implementation status.

OpenSlate is a self-hosted web application for configurable business operations. Its production server is FastAPI behind one same-origin Caddy gateway. The browser UI is a statically exported Next.js application served by FastAPI; Node.js and Next.js are build and local-development tools, not production services. FastAPI owns identity, authorization, application data, files, audit capture, static UI delivery, and server-sent invalidation events.

## Production runtime contract

| Concern | Owner |
| --- | --- |
| Browser UI | Static Next.js export and React, delivered by FastAPI |
| HTTPS gateway | Caddy, with one production FastAPI upstream |
| Browser routes, assets, and 404s | FastAPI static-site delivery |
| Business API, authorization, and SSE | FastAPI with synchronous SQLAlchemy |
| Schema and durable state | Vanilla PostgreSQL and Alembic |
| Identity | FastAPI Identity tables: credentials, sessions, action tokens, and rate-limit buckets |
| Files | PostgreSQL metadata plus private local filesystem bytes |
| Invalidation | Authenticated SSE backed by PostgreSQL `LISTEN`/`NOTIFY` |

The browser never writes application rows directly. FastAPI uses the runtime PostgreSQL role; Alembic uses the owner connection. Application mutations use `AuditSession` and produce transactional, redacted audit rows.

## Development boundary

Daily development retains `next dev` for hot reload and uses it as the direct
browser origin. Its development-only `/api` proxy forwards API and SSE traffic
to loopback FastAPI. Caddy, TLS, and the disabled `gateway` profile are excluded
from that path. Caddy remains installed and configured for an operator-started
production preview and production-level acceptance; this does not introduce a
Next.js production runtime or a browser-facing second service in a packaged
deployment.

## Status boundaries

- Vanilla PostgreSQL, FastAPI Identity, private filesystem storage, Caddy configuration, and authenticated SSE are implemented application contracts.
- The FastAPI-only production-server cutover is the selected deployment contract: one FastAPI payload includes the static frontend assets and contains no Node.js frontend process, image, listener, or runtime configuration.
- Sandbox design documents, history, temporary test evidence, publication, and
  supported published automations are durable FastAPI/PostgreSQL contracts.
  Other UI-first workspace surfaces may still use browser-local sample state;
  do not present those interactions as persisted behavior.
- SMTP delivery is optional and disabled by default. When enabled, FastAPI queues encrypted invitation and recovery payloads in PostgreSQL, then a bounded worker delivers them through the configured SMTP transport.
- Signed Windows/macOS server-app installers, automated setup, bundled database lifecycle, and tested backup/restore remain unverified until clean-host acceptance proves them.

See [system context](02-system-context.md), [data architecture](06-data-architecture.md), and [deployment architecture](12-deployment-architecture.md).
