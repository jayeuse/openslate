# Security Architecture

> **Scope:** Implemented application controls and deployment gaps.

FastAPI is the application authorization, data, and static-content boundary.
Supabase Auth verifies email/password credentials and issues provider JWTs.
FastAPI's [identity dependency](../../backend/app/common/dependencies/auth.py)
verifies the signature, issuer, audience, expiry, subject, and provider session
through [`SupabaseAuthClient`](../../backend/app/core/integrations/supabase_auth.py).
It then requires an explicit `users.supabase_user_id` binding to an eligible
OpenSlate profile. A provider account or matching email alone never grants
application access. FastAPI owns the local profile, roles, groups, permissions,
and domain authorization.

Production browsers use a same-origin Caddy gateway with one FastAPI upstream.
The [cookie helpers](../../backend/app/systems/access/auth/cookies.py) set
Secure, HttpOnly cookies in production. `openslate_access` contains the provider
access JWT; `openslate_refresh` contains an opaque application handle. FastAPI
stores the handle digest and encrypted provider token pair in `identity_sessions`,
along with local expiry and revocation state. A CSRF cookie/token protects
state-changing browser requests. Session listing, self/admin revocation, and
account-disablement checks in
[`provider_sessions.py`](../../backend/app/systems/access/identity/provider_sessions.py)
remain application-owned; a valid provider JWT does not revive a revoked
application session. CLI clients use bearer tokens through the same admission
checks, and mixed cookie/bearer credentials are rejected.

Daily development opens Next.js directly and uses its same-origin
development-only `/api` proxy to reach loopback FastAPI. In
`ENVIRONMENT=development`, local loopback/private/link-local browser origins
and local HTTP are permitted only while FastAPI remains bound to loopback. Test
and production-level Caddy/full-stack paths retain strict origin, host,
response-header, body-limit, concurrency, and rate-limit policy. Test,
production, and non-loopback development require the exact configured Origin.
Relaxed loopback development accepts a missing Origin or a valid local browser
Origin.

Supabase Auth owns password credentials and invitation/recovery action tokens;
OpenSlate retains local login throttling. Lifecycle password challenges
reverify through Supabase Auth and require the result to map back to the same
eligible local actor. Supabase Database is PostgreSQL. Separate bootstrap,
application-owner, and constrained-runtime roles isolate provisioning,
Alembic, and request queries. [`migration_scope.py`](../../backend/app/core/database/migration_scope.py)
limits Alembic to application objects; Supabase owns Auth and Storage schemas.
The runtime's only Auth-schema read is the narrowly granted provider-session
liveness check provisioned by
[`provision_database_role.py`](../../backend/operations/provision_database_role.py).
The browser receives no database credentials, and provider user metadata is
never an authorization source.

File metadata and authorization state remain application-owned. File bytes use
opaque keys in private Supabase Storage quarantine and ready buckets through a
server-only [Storage client](../../backend/app/systems/platform/files/supabase_storage.py).
FastAPI authorizes every transfer; the [scanner workflow](../../backend/app/systems/platform/files/scan_processing.py)
checks stored bytes and integrity before promotion, and only a durable clean
verdict permits download. A private bucket or privileged Storage key does not
replace application authorization.

Authenticated SSE carries opaque invalidations over PostgreSQL
`LISTEN`/`NOTIFY`; Supabase Realtime is not the active event transport.
Subscriber limits, reauthorization, bounded queues, and send timeouts limit
retained stream resources. FastAPI separates exact static exports, `/api`, and
`/api/events`; it never sends UI HTML for an API or missing-asset path. Static
route/asset cache policy and response security headers belong to FastAPI/Caddy,
not a Node.js frontend process. Audit redacts sensitive fields and does not
record raw passwords, tokens, object paths, or bytes.

[`/api/ready`](../../backend/app/main.py) currently checks database connectivity
only; it does not establish Auth, Storage, SMTP, scanner, or complete stack
readiness. The encrypted [Restic backup](../../packaging/backup/backup_installation.py)
and [restore](../../packaging/backup/restore_installation.py) commands exist,
but production TLS, the complete five-volume backup/restore path, scanned-file
access through the restored API, reboot recovery, and final release acceptance
remain unverified. Windows Docker Desktop/WSL2 is the intended Windows server
path, but Windows-host startup, reboot, and restore acceptance are pending.
macOS is not a server target, and no native server installer is part of this
Compose scope. These deployment boundaries must not be described as verified
production controls. See [Deployment Architecture](12-deployment-architecture.md)
and the [Supabase implementation plan](../../infra/supabase/PLAN.md).
