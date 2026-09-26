# Security Architecture

> **Scope:** Implemented application controls and deployment gaps.

FastAPI is the application authorization, data, and static-content boundary.
Production browsers use a same-origin Caddy gateway with one FastAPI upstream
and Secure, HttpOnly access/refresh cookies. Daily development opens Next.js
directly and uses its same-origin development-only `/api` proxy to reach
loopback FastAPI. In `ENVIRONMENT=development`, local loopback/private/link-local
browser origins and local HTTP are permitted only while FastAPI remains bound to
loopback. Test and production-level Caddy/full-stack paths retain strict origin,
host, response-header, body-limit, concurrency, and rate-limit policy.
State-changing browser requests always require a CSRF token. Test, production,
and non-loopback development require the exact configured Origin. Relaxed
loopback development accepts a missing Origin or a valid local browser Origin.
CLI clients use bearer tokens. Mixed cookie and bearer credentials are rejected.

Local Identity uses Argon2 password hashing, server-side session state, rotated refresh tokens, one-time action tokens, and login throttling. Protected dependencies validate signed JWTs and then reload active user, role, and session state. Setup-only, disabled, deleted, pending, or revoked identities fail closed.

PostgreSQL uses separate owner and constrained runtime credentials. FastAPI alone accesses application rows; the browser has no database credentials. Local files use opaque keys, private directory permissions, no-follow/handle-safe access, quarantine, digest/size verification, scanner gating, and authorization on every transfer.

SSE is authenticated and contains opaque invalidation data only. Subscriber limits, short-lived authorization checks, bounded queues, and send timeouts limit retained stream resources. FastAPI separates exact static exports, `/api`, and `/api/events`; it never sends UI HTML for an API or missing-asset path. Static route/asset cache policy and response security headers belong to FastAPI/Caddy, not a Node.js frontend process. Audit redacts sensitive fields and does not record raw passwords, tokens, object paths, or bytes.

The standalone backup foundation uses encrypted Restic repositories. Automated
backup scheduling, installed-host key operations, supported customer recovery,
Windows/macOS installer security, disk encryption checks, LAN TLS setup, secret
delivery and operational monitoring still require deployment work and native
acceptance. They must not be represented as verified production controls. See
[Deployment Architecture](12-deployment-architecture.md).
