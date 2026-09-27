# Infrastructure

> **Scope:** Per-client self-hosted Supabase services, the OpenSlate application boundary, and current operating limits.

OpenSlate uses Supabase as a self-hosted service stack for each installation. Supabase Database is PostgreSQL, so this replaces the standalone PostgreSQL container and pgweb workflow while keeping PostgreSQL, SQLAlchemy, and Alembic. It does not migrate existing data or make OpenSlate a multi-tenant hosted service. Each client has a separate Compose project, credentials, networks, and persistent volumes.

The checked-in stack is defined by [`infra/supabase/compose.yaml`](../../infra/supabase/compose.yaml), with a [`development overlay`](../../infra/supabase/compose.dev.yaml) and a [`production application overlay`](../../infra/supabase/compose.production.yaml). The upstream images are digest-pinned. Supabase Realtime, Functions, Analytics, and Supavisor are not started. The selected release and operating contract are described in [`infra/supabase/README.md`](../../infra/supabase/README.md).

## Compose topology

The base provider project contains Supabase PostgreSQL, Auth, Storage, Studio, postgres-meta, PostgREST, imgproxy, and the internal Envoy gateway. Mailpit is added only by the development overlay. Project name and volume prefixes come from `OPENSLATE_INSTANCE_ID`; the Compose wrapper admits only the installation identified by the owner-only environment and its Docker ownership record.

The development overlay publishes the database, gateway, and Mailpit UI on loopback host ports. `./scripts/dev.py db` starts the development provider stack through [`scripts/environment.py`](../../scripts/environment.py), which validates the private root `.env`, limits the environment passed to Docker, and records the selected instance. FastAPI and `next dev` remain host processes. The browser calls FastAPI through Next's development-only `/api` proxy; FastAPI calls Auth and Storage through the loopback Supabase gateway. The optional root `gateway` profile is a local production-style Caddy preview, not the customer deployment.

The production overlay adds the unified FastAPI/static-frontend API image, the scanner worker, ClamAV, and Caddy. Caddy is the only public listener and forwards the UI, API, and SSE to FastAPI. The production database has no published host port. Provider services, the API, and scanner use private Compose networks; provider Studio access stays loopback-bound behind gateway authentication. Production requires separate owner-only provider and application environment files, real Auth SMTP, existing private paths, and prepared images. See the [production input contract](../../infra/supabase/README.md#production-application-overlay).

The stack has no pgweb service or `openslate_inspector` login. Supabase Studio replaces pgweb as the provider operator interface and has broader administrative power than a read-only database viewer. Keep it on its loopback-only gateway path and use its configured operator credentials.

## Database and application authority

PostgreSQL remains the relational engine. Provider initialization owns Supabase schemas and roles; [`backend/migrations/env.py`](../../backend/migrations/env.py) and Alembic own only OpenSlate application schema. A fresh Supabase baseline and explicit migration-scope checks keep provider objects outside application migration ownership.

The application database uses three separate connections:

- `DATABASE_BOOTSTRAP_URL` uses the pinned provider's `supabase_admin` login to provision application roles and grants. It is an operator-only input.
- `MIGRATION_DATABASE_URL` uses `openslate_owner` for Alembic operations.
- `DATABASE_URL` uses the constrained `openslate_runtime` role for FastAPI and workers.

The role provisioner, [`backend/operations/provision_database_role.py`](../../backend/operations/provision_database_role.py), verifies the runtime grants and installs a narrowly scoped read-only `auth.sessions` policy. The runtime role can read only the provider session identifiers it needs to confirm that an Auth session remains live. It receives no Auth mutation rights. Application tables remain inaccessible to browser provider keys, and ordinary domain reads and mutations go through FastAPI's SQLAlchemy boundary.

## Authentication and authorization

Supabase Auth answers who signed in. OpenSlate keeps its own application user, invitation eligibility, identity session, role, group, and permission state in PostgreSQL. A Supabase user ID is explicitly bound to an OpenSlate profile; matching email alone does not create application access. The FastAPI authentication dependency verifies the provider credential and session, resolves the bound active profile, and evaluates current OpenSlate authorization for each request.

Provider roles and user metadata do not grant application permissions. Workspace capabilities, roles, groups, Board grants, Report audiences, and account lifecycle rules remain backend decisions. The browser never receives the Supabase secret key or direct credentials for application tables. Relevant code is in [`supabase_auth.py`](../../backend/app/core/integrations/supabase_auth.py), [`provider_sessions.py`](../../backend/app/systems/access/identity/provider_sessions.py), and the Access authorization modules.

## Storage and scanning

The application creates two private buckets, `openslate-quarantine` and `openslate-ready`, through [`backend/operations/provision_storage.py`](../../backend/operations/provision_storage.py). File metadata and application authorization remain in PostgreSQL; bytes move through the server-side Supabase Storage API and persist in the provider's `supabase-storage-data` volume. There is no local-filesystem storage mode and no direct browser access to object bytes.

FastAPI authorizes upload and download. New content enters quarantine, the separate scanner worker checks the stored bytes against the upload metadata and scans them with ClamAV, and only a verified clean object is promoted to ready storage. The application denies reads until the clean result is committed and rechecks access on download. The provider adapter is [`supabase_storage.py`](../../backend/app/systems/platform/files/supabase_storage.py); scan and promotion behavior remains in the platform file service and worker.

The checked-in ClamAV image currently targets Linux amd64. Its definitions and manifest are mounted read-only in the production overlay. Windows server operation uses Linux containers through Docker Desktop/WSL2, but Windows startup, reboot, scanner, and restore acceptance is still pending. macOS remains available as a development workstation; it is no longer a supported server target.

## Events and readiness

OpenSlate continues to publish opaque PostgreSQL invalidations to authenticated SSE clients. The listener uses a direct session-affine PostgreSQL `LISTEN` connection. SSE sends invalidation or resync signals only; clients refetch through authorized FastAPI endpoints. Supabase Realtime is a future feature decision, not the current transport.

`/api/health` reports that the API process can answer a request. `/api/ready` reports separate Database, Auth, Storage, SMTP configuration, and scanner states. Database checks use a bounded read-only transaction; provider checks use their health endpoints. SMTP readiness means required configuration is present, not that delivery succeeded. Scanner readiness requires both a direct ClamAV probe and the worker's exact database advisory lock; it does not measure queue progress. The scanner is required in production and optional in development/test. The production API joins the private scanner network and mounts the generation manifest read-only. A disposable production Compose rehearsal exercised all-required readiness and bounded Auth, Storage, and scanner failure/recovery. These checks do not establish schema compatibility, backup currency, SMTP delivery, scanner queue progress, native Linux host boot/reboot behavior, or Windows operation.

## Operational boundary

The Compose definitions, provider adapters, database provisioning, Storage setup, and offline backup/restore commands are checked in. A guarded five-volume restore rehearsal with a separate target exercised DB-only session finalization, restored application authorization and file access, and service restart using Linux containers on macOS Docker Desktop. This does not establish native Linux host boot/reboot or Windows runtime behavior, nor full customer-release acceptance; see [Deployment Architecture](12-deployment-architecture.md) and the [restore runbook](../../infra/supabase/RESTORE.md).
