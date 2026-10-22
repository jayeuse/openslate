# Infrastructure

> **Scope:** Per-client self-hosted Supabase services, the OpenSlate application boundary, and current operating limits.

OpenSlate uses Supabase as a self-hosted service stack for each installation. Supabase Database is PostgreSQL, so this replaces the standalone PostgreSQL container and pgweb workflow while keeping PostgreSQL, SQLAlchemy, and Alembic. It does not migrate existing data or make OpenSlate a multi-tenant hosted service. Each client has a separate Compose project, credentials, networks, and persistent volumes.

The checked-in stack is defined by [`infra/supabase/compose.yaml`](../../infra/supabase/compose.yaml), with a [`development overlay`](../../infra/supabase/compose.dev.yaml) and a [`production application overlay`](../../infra/supabase/compose.production.yaml). The upstream images are digest-pinned. Supabase Realtime runs for private organization channels (gateway route `/realtime/v1/websocket` only). Functions, Analytics, and Supavisor are not started. The selected release and operating contract are described in [`infra/supabase/README.md`](../../infra/supabase/README.md).

## Compose topology

The base provider project contains Supabase PostgreSQL, Auth, Storage, Realtime, Studio, postgres-meta, imgproxy, and the internal Envoy gateway; PostgREST is not included. Mailpit is added only by the development overlay. Project name and volume prefixes come from `OPENSLATE_INSTANCE_ID`; the Compose wrapper admits only the installation identified by the owner-only environment and its Docker ownership record. One installation can hold multiple organizations without becoming a shared hosted SaaS service.

The development overlay publishes the database, gateway, private publisher listener and Mailpit UI on loopback host ports. `./scripts/dev.py db` starts the development provider stack through [`scripts/environment.py`](../../scripts/environment.py), which validates the private root `.env`, limits the environment passed to Docker, and records the selected instance. FastAPI and Next.js remain host processes. HTTP `/api` uses Next's development-only proxy to the configured loopback `BACKEND_PORT`; [`run-next.mjs`](../../frontend/tooling/run-next.mjs) handles the exact-origin Realtime upgrade at `FRONTEND_DEV_PORT`. FastAPI calls Auth and Storage through the loopback provider gateway. The optional root `gateway` profile is a local production-style Caddy preview, not the customer deployment.

The production overlay adds the unified FastAPI/static-frontend API image and Caddy. Caddy is the public ingress and forwards UI, API and SSE to FastAPI, with an exact-origin WebSocket-only route to the provider gateway. No Node.js frontend process is part of production. The production database and private publisher have no published host port. Provider services and the API use private Compose networks; provider Studio access stays loopback-bound behind gateway authentication. Production requires separate owner-only provider and application environment files, real Auth SMTP, existing private paths, and prepared images. See the [production input contract](../../infra/supabase/README.md#production-application-overlay).

Browser Realtime ingress uses `api-gw:8000` behind Caddy's restricted
`/realtime/v1/websocket` route. The separate server publisher is
`api-gw:8001/realtime/v1/api/broadcast`, admitted by the server key and selected by
`REALTIME_PUBLISH_URL`; Caddy does not expose it. The development-only
`SUPABASE_REALTIME_PUBLISH_PORT` mapping remains loopback-bound and authenticated,
not a claim of browser-unreachability. See the
[Caddy route](../../infra/caddy/Caddyfile.template),
[Envoy listeners](../../infra/supabase/upstream/envoy/lds.template.yaml) and
[operator boundary](../../infra/supabase/README.md#opencomms-ingress-and-private-publication).

The stack has no pgweb service or `openslate_inspector` login. Supabase Studio replaces pgweb as the provider operator interface and has broader administrative power than a read-only database viewer. Keep it on its loopback-only gateway path and use its configured operator credentials.

## Database and application authority

PostgreSQL remains the relational engine. Provider initialization owns Supabase schemas and roles; [`backend/migrations/env.py`](../../backend/migrations/env.py) and Alembic own only OpenSlate application schema. A fresh Supabase baseline and explicit migration-scope checks keep provider objects outside application migration ownership.

The application database uses three separate connections:

- `DATABASE_BOOTSTRAP_URL` uses the pinned provider's `supabase_admin` login to provision application roles and grants. It is an operator-only input.
- `MIGRATION_DATABASE_URL` uses `openslate_owner` for Alembic operations.
- `DATABASE_URL` uses the constrained `openslate_runtime` role for FastAPI and its in-process workers.

The role provisioner, [`backend/operations/provision_database_role.py`](../../backend/operations/provision_database_role.py), verifies the runtime grants and installs a narrowly scoped read-only `auth.sessions` policy. The runtime role can read only the provider session identifiers it needs to confirm that an Auth session remains live. It receives no Auth mutation rights. Application tables remain inaccessible to browser provider keys, and ordinary domain reads and mutations go through FastAPI's SQLAlchemy boundary.

## Authentication and authorization

Supabase Auth answers who signed in. OpenSlate keeps its own application user, invitation eligibility, identity session, role, group, and permission state in PostgreSQL. A Supabase user ID is explicitly bound to an OpenSlate profile; matching email alone does not create application access. The FastAPI authentication dependency verifies the provider credential and session, resolves the bound active profile, and evaluates current OpenSlate authorization for each request.

Provider roles and user metadata do not grant application permissions. Workspace capabilities, roles, groups, Board groups, Report audiences, and account lifecycle rules remain backend decisions. The browser never receives the Supabase secret key or direct credentials for application tables. Relevant code is in [`supabase_auth.py`](../../backend/app/core/integrations/supabase_auth.py), [`provider_sessions.py`](../../backend/app/systems/access/identity/provider_sessions.py), and the Access authorization modules.

## Storage

The application provisions two private buckets through [`backend/operations/provision_storage.py`](../../backend/operations/provision_storage.py): `openslate-ready` for organization files, including conversation attachments, and `openslate-avatars` for account avatars. File metadata and application authorization remain in PostgreSQL; bytes move through the server-side Supabase Storage API and persist in the provider's `supabase-storage-data` volume. There is no local-filesystem storage mode and no direct browser access to object bytes.

FastAPI authorizes upload and download. The upload request validates the file type with an allowlist and a bounded parser subprocess, writes the bytes to the ready bucket, and commits the file as `ready` with its digest and size. There is no antivirus scan. The application denies reads in every other state and rechecks access on download. The provider adapter is [`supabase_storage.py`](../../backend/app/systems/platform/files/supabase_storage.py); upload, reconciliation, and purge behavior remains in the platform file service.

Windows server operation uses Linux containers through Docker Desktop/WSL2, but Windows startup, reboot, and restore acceptance is still pending. macOS remains available as a development workstation; it is no longer a supported server target.

## Events and readiness

Other application pages retain opaque PostgreSQL invalidations to authenticated SSE clients through a direct session-affine `LISTEN` connection. OpenComms uses private Realtime topics for opaque notifications and transient presence/typing signals. In both cases, consumers read content through current-authorized FastAPI endpoints; an event, cached view or join grant is not a content permission.

The [`FastAPI lifespan`](../../backend/app/main.py) owns the publisher and existing
scheduling worker. [`OpenComms job polls`](../../backend/app/systems/comms/jobs/worker.py)
run schedules, exports, retention and optional previews in the bound organization;
there is no additional worker service or message broker. Durable job state and
leases live in PostgreSQL, while the bounded publication queue is process-local
and best effort. Request-buffered events submit after response completion;
resource-owned jobs submit after their own commit/SQL-session close independently
of a triggering HTTP response. Neither holds SQL resources through publication I/O.

`/api/health` reports that the API process can answer a request. `/api/ready` reports separate Database, Auth, Storage, and SMTP configuration states, all required. Database checks use a bounded read-only transaction; provider checks use their health endpoints. SMTP readiness means required configuration is present, not that delivery succeeded. These probes do not establish schema compatibility, backup currency, SMTP or Realtime delivery, native Linux host boot/reboot behavior, or Windows operation.

## Operational boundary

The Compose definitions, provider adapters, database provisioning, Storage setup and offline backup/restore commands are implemented. Runtime acceptance remains a separate requirement: native Linux host boot/reboot, Windows operation, restored identity/file authorization and customer-release checks cannot be inferred from configuration or component health. See [Deployment Architecture](12-deployment-architecture.md) and the [restore runbook](../../infra/supabase/RESTORE.md) for the operating boundaries; execution results belong in separate acceptance evidence.
