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

Production Uvicorn resolves forwarded client addresses only from the configured
Caddy/API private subnet; Caddy overwrites `X-Forwarded-For` with its socket peer.
IP policy and throttling use that resolved server address, not arbitrary browser
headers. Only Caddy and API may join the trusted network; see the
[proxy boundary](../../infra/supabase/README.md#production-application-overlay).

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
opaque keys in the private Supabase Storage `openslate-ready` bucket through a
server-only [Storage client](../../backend/app/systems/platform/files/supabase_storage.py).
FastAPI authorizes every transfer. Uploads pass a file-extension
allowlist, and a [bounded parser subprocess](../../backend/app/systems/platform/files/validation_worker.py)
checks that each file is a real PDF, PNG, JPEG, DOCX, XLSX, or PPTX before the
Storage write. Downloads are served as attachments with `nosniff`. OpenSlate
runs no antivirus scan; type validation is not malware detection. A private
bucket or privileged Storage key does not replace application authorization.

Encrypted [backup exports](../../backend/app/systems/manage/backups/downloads.py)
require an eligible administrator and current-password reauthentication through
Supabase Auth. Admission is a short-lived, single-use handle bound to the actor,
session, and export in an HttpOnly, Secure, Strict cookie scoped to the content
path; responses expose only its expiry. The host produces an encrypted Restic
repository archive in its confined export root. The API's read-only export bind
contains finished archives; source repositories, Restic password files, and private
backup configuration are not mounted into it. Content preparation validates the
owned file and commits a `backup.export.download` ATTEMPT before streaming.
An ATTEMPT is not proof that the browser saved the archive.

Audit history is also scope-aware. Administrators can list across departments;
other users must hold department-level `manage` and explicitly filter one
department. Audit-log detail, export, and SecurityEvent access remain
administrator-only ([`audit/router.py`](../../backend/app/systems/manage/audit/router.py)).
The audit listener derives the department from entity ancestry before a purge
removes parent rows ([`department_ancestry.py`](../../backend/app/systems/manage/audit/department_ancestry.py)).

Authenticated SSE carries opaque invalidations over PostgreSQL
`LISTEN`/`NOTIFY`; Supabase Realtime is not the active event transport.
Subscriber limits, reauthorization, bounded queues, and send timeouts limit
retained stream resources. FastAPI separates exact static exports, `/api`, and
`/api/events`; it never sends UI HTML for an API or missing-asset path. Static
route/asset cache policy and response security headers belong to FastAPI/Caddy,
not a Node.js frontend process. Audit redacts sensitive fields and does not
record raw passwords, tokens, object paths, or bytes.

[`/api/ready`](../../backend/app/main.py) reports bounded Database, Auth,
Storage, and SMTP-configuration component states
([`readiness.py`](../../backend/app/core/readiness.py)). This component report
does not establish mail delivery, schema compatibility, backup integrity, or
complete stack readiness. The encrypted [Restic backup](../../packaging/backup/backup_installation.py)
and [restore](../../packaging/backup/restore_installation.py) commands support the
operator procedure. A guarded production Compose rehearsal exercised TLS trust,
encrypted five-volume restore, restored-file authorization, and service restart
using Linux containers on macOS Docker Desktop. Local encrypted-export verification
is separate from pending production-bind and native-browser gateway acceptance.
Native Linux host boot/reboot and final release acceptance remain pending. Windows
Docker Desktop/WSL2 is the intended Windows server path, but Windows-host startup,
reboot, and restore acceptance are pending.
macOS is not a server target, and no native server installer is part of this
Compose scope. These deployment boundaries must not be described as verified
production controls. See [Deployment Architecture](12-deployment-architecture.md)
and the [Supabase implementation plan](../../infra/supabase/PLAN.md).
