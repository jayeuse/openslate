# OpenSlate

OpenSlate is a self-hosted foundation for configurable business operations. It
uses a host-run FastAPI backend and Next.js frontend with the Supabase CLI as
the local platform for PostgreSQL, Auth, Realtime, Storage, Studio, and
Mailpit.

## Stack and boundaries

- Frontend: Next.js 16, React 19, TypeScript, Tailwind CSS 4, and Playwright
- Backend: Python 3.12+, FastAPI, Pydantic, SQLAlchemy, and Alembic
- Local platform: Supabase CLI with PostgreSQL 17
- Authentication: Supabase Auth; global public signup and anonymous sign-in
  are disabled. The email/password provider remains enabled only so invited
  users can accept invitations and sign in.
- Auditing: application ORM mutations only, with transactional minimal diffs
  and sensitive-value redaction
- Realtime: private Supabase Broadcast invalidation events only; event payloads
  do not contain row snapshots
- Storage: Supabase Storage only; the local filesystem is not an application
  storage backend

The FastAPI API owns application reads and writes. Alembic owns the application
schema. Supabase's Data API intentionally exposes only the managed
`graphql_public` surface, not the application schema. Do not write application
data through PostgREST/Data API, Studio, direct SQL, or external database
clients.

Audit logs cover normal application ORM entity mutations in the same
transaction as the business change. Supabase Auth, Studio, direct SQL, Alembic,
Data API operations, and external clients are outside the application audit
boundary. Bulk and raw ORM mutation statements remain unsupported because they
cannot produce reliable per-record snapshots.

## Environment configuration

Edit only the ignored root `.env`, using `.env.example` as its structure. It
contains secrets, the existing administrator's local sign-in details, stack
ports, endpoints, and runtime limits. `${NAME}` references keep shared values
and ports in one place. Missing, blank, invalid, duplicate, or unresolved
configuration fails with the variable name; application code supplies no
replacement values or legacy aliases.

`frontend/.env.local` is generated from a fixed allowlist by local `npm run dev`,
`npm run build`, and `npm start`. Do not edit it or source root `.env` into
Next.js. Administrator credentials, owner database credentials, and private
Supabase keys are excluded. Public frontend settings are baked in at build
time, so changing them requires a rebuild. See the
[configuration inventory](docs/architecture/17-configuration.md) for ownership.

Validate configuration from the repository root after installing backend
dependencies:

```bash
uv run --directory backend python ../scripts/environment.py check
```

## Local setup

Run these commands from the repository root unless a directory is shown.

1. For a new checkout, copy `.env.example` to `.env` and restrict its access.
   Keep an existing configured `.env`. Review the stack ports before starting
   Supabase; `supabase/config.toml` reads them directly from root `.env`.

   ```bash
   cp .env.example .env
   chmod 600 .env
   supabase start
   supabase status -o env
   ```

2. Fill the blank secret and administrator fields in root `.env`. Treat the
   complete Supabase status output as secret. Map `DB_URL` to
   `MIGRATION_DATABASE_URL`, using the `postgresql+psycopg://` scheme; map
   `ANON_KEY` to `SUPABASE_PUBLISHABLE_KEY` and `SERVICE_ROLE_KEY` to
   `SUPABASE_SECRET_KEY`. Confirm `API_URL` agrees with the configured
   `SUPABASE_URL`. Keep the example's port references in connection URLs.
   Generate a private `SECURITY_EVENT_SERVER_KEY`. Choose the runtime login's
   password once and URL-encode it only in `DATABASE_URL`, whose username is
   `openslate_runtime`.

   `ADMIN_EMAIL`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` describe the existing
   local administrator/test account. Saving these values does not create an
   account or change its password. `SUPABASE_ACCESS_TOKEN` is needed only for
   the optional sample-data seed command.

3. Install backend dependencies, apply the schema using the owner connection,
   and provision the runtime login using the password in `DATABASE_URL`:

   ```bash
   # backend/
   uv sync --locked
   uv run alembic upgrade head
   uv run alembic check
   uv run python scripts/provision_database_role.py
   ```

4. For an installation without an administrator, run the invitation bootstrap
   using `ADMIN_EMAIL` and `ADMIN_USERNAME`. Open the invitation in Mailpit and
   set the password in the app. Bootstrap does not apply `ADMIN_PASSWORD`:

   ```bash
   # backend/
   uv run python scripts/bootstrap_admin.py
   ```

5. Start host services in separate terminals. Their bind addresses and ports
   come from root `.env`:

   ```bash
   # backend/
   uv run python -m app --reload

   # frontend/
   npm ci
   npm run dev
   ```

With the example ports, the app is at [localhost:3000](http://localhost:3000),
FastAPI docs at [localhost:8000/docs](http://localhost:8000/docs), Studio at
[127.0.0.1:54323](http://127.0.0.1:54323), and Mailpit at
[127.0.0.1:54324](http://127.0.0.1:54324). Supabase API/database ports are
`SUPABASE_API_PORT` and `SUPABASE_DB_PORT`. Verify local platform bindings with
`supabase status` before use. Do not apply PostgreSQL network restrictions that
block Supabase's internal service connections.

## Local containers with Compose

The existing root `compose.yaml` can run the backend, frontend, and ClamAV
independently. Supabase remains CLI-managed; migrations and account setup stay
separate. Use the environment helper for every Compose command. It validates
root `.env`, derives Docker-reachable service URLs in memory, and passes only
each service's allowed settings. JWT issuer identity stays unchanged. No second
database URL or generated Compose secret file is needed.

From the repository root:

```bash
uv run --directory backend python ../scripts/environment.py compose config --quiet
uv run --directory backend python ../scripts/environment.py compose up -d --build backend frontend
uv run --directory backend python ../scripts/environment.py compose ps
uv run --directory backend python ../scripts/environment.py compose logs -f backend frontend
uv run --directory backend python ../scripts/environment.py compose down
```

Stop any host servers using the configured application ports before starting
their containers. Repeat `up -d --build` after source or public frontend setting
changes. `down` leaves Supabase and its data intact; use `supabase stop`
separately. Full rendered Compose configuration contains secrets; use
`config --quiet` for routine validation.

Before starting `clamav`, set `SCANNER_DEFINITIONS` to an existing absolute path
containing verified immutable definitions, following the
[scanner provisioning procedure](docs/architecture/11-infrastructure.md#daily-definition-maintenance-and-first-provisioning).
Compose mounts definitions read-only and does not refresh them. The separate
scanner worker also requires `FILES_CLAMAV_HOST`, `FILES_CLAMAV_PORT`, and the
matching readable `FILES_CLAMAV_MANIFEST_PATH`; starting the engine alone does
not process uploads.

The app ports use `COMPOSE_BIND_HOST`; ClamAV has no published port and uses an
internal network. All three services run as non-root with read-only roots and
dropped capabilities. Logs use `CONTAINER_LOG_DIR` in temporary container
storage. This Compose path targets local Docker Desktop; Linux deployments must
make the Supabase host ports reachable through the Docker host gateway without
publishing them publicly.

## Stop and reset

Stop the local platform while preserving its data:

```bash
supabase stop
```

For a destructive local database reset, run the platform reset and then apply
the application schema again:

```bash
supabase start
supabase db reset
cd backend
uv run alembic upgrade head
```

To clear only Alembic-owned application data while keeping the existing sample
administrator usable, stop the FastAPI and frontend processes, keep the local
Supabase stack running, and run the guarded reset utility from `backend/`:

```bash
# Read-only plan: review the preserved administrator and per-table counts.
uv run python scripts/reset_application_data.py

# Rebuild the plan, then enter its impact digest exactly when prompted.
uv run python scripts/reset_application_data.py --execute
```

The utility accepts only the loopback Supabase database at
`127.0.0.1:54322/postgres`, requires `MIGRATION_DATABASE_URL` and
`ADMIN_EMAIL`, verifies the running Supabase project and Alembic head, and
fails closed on schema drift. Every application profile except `ADMIN_EMAIL`'s
matching profile is deleted, along with all domain, relationship, audit, and
lifecycle rows and every custom role. The utility refuses to run when another
effective administrator exists; pending, disabled, and soft-deleted
admin-shaped profiles are reset. It preserves the matching active administrator
profile and the required `admin` and `member` roles. Supabase-managed schemas
and all Auth identities remain unchanged. Because deleted profiles are removed,
retained `performed_by` references to them are intentionally cleared by the
database's `ON DELETE SET NULL` behavior; retained non-admin Auth identities
cannot access FastAPI after their application profiles are removed.

This utility is local-only. It is not a release rollback or a hosted recovery
mechanism; recovery requires the separately selected backup and restore process.

Never add application SQL files under `supabase/migrations` or use Supabase
seed files. Schema changes go through `backend/migrations/` and are checked
with Alembic.

## Domain API

Roles, users, departments, modules, fields, records, and audit reads are
administrator-only. Domain collections use the standard list contract and
expose `POST`, `GET`, `PATCH`, soft `DELETE`, and restore where applicable.
Records validate active field definitions, required values, select options, and
JSON value types.

The authentication integration uses Supabase Auth JWTs. Admin invitations are
sent through the server-only Supabase secret key and delivered to local
Mailpit. The browser uses only the publishable key. Realtime is a private
Broadcast channel used to invalidate client data; it is not a second data API.
Files belong in Supabase Storage and must not be mounted from a root `storage/`
directory.

## Verification

After the platform is running and Alembic has applied the schema:

```bash
# root
supabase status

# backend/
uv run alembic check
uv run ruff check .
uv run mypy app
uv run pytest

# frontend/
npm run lint
npm run typecheck
npm run build
npm test
```

From the repository root, run a backend section with
`python3 scripts/test.py backend section runtime --layer isolated`. From
`frontend/`, run `npm run test:section -- security --layer isolated` or
`npm run test:affected -- --list`. See the [testing workflow](docs/architecture/16-testing-architecture.md)
for sections, affected selection, and full verification.

PostgreSQL integration tests can use the local database URL without exposing
it in source control:

```bash
TEST_DATABASE_URL="$DATABASE_URL" uv run pytest tests/test_audit_integration.py
```

## Future hosted deployment

Hosted deployment is not implemented or production-ready. The approved contract
and release order are in [Deployment architecture](docs/architecture/12-deployment-architecture.md):
one trust domain per deployment with isolated Auth, PostgreSQL, Storage, secrets,
backups, and administrator population; shared tenancy is deferred. FastAPI is
private in the hosted topology. Only the required Supabase Auth, JWKS, and
Realtime surfaces remain public, under controlled provider policy. The frontend
uses `/bff/*`; direct Next `/api` and API documentation rewrites are not part of
the contract.

CI verifies both standalone images but does not publish or deploy them. The
frontend image requires public Supabase build arguments and receives
`BACKEND_URL` only at runtime; neither image migrates, provisions, bootstraps,
or starts Supabase.

Provider, registry, secret manager, SMTP, RPO/RTO, retention, actual backup
implementation, and hosted topology remain selections/blockers. No
provider-neutral infrastructure is checked in.

Migration `0010` requires an owner-capable path for policy DDL on
`realtime.messages` and permission to provision the application database
roles. Local Supabase supplies that path through a tightly scoped CLI-only
fallback. Before a hosted cutover, verify the hosted migration principal can
perform those operations or apply the Realtime policy through a separately
approved owner-capable deployment step; the migration intentionally fails
closed otherwise.

## Repository architecture

- `backend/app/core/` owns configuration, database wiring, security, and
  integrations.
- `backend/app/common/` contains shared dependencies, exceptions, and
  utilities.
- `backend/app/systems/` is organized by business capability. Domain systems
  own their CRUD routers, schemas, validation, and persistence behavior.
- `backend/migrations/` is the only supported path for application schema
  changes.
- `backend/app/systems/audit/` owns transactional ORM listeners,
  before/after diffing, redaction, and administrator-only audit reads.
- `frontend/src/app/` contains App Router routes; reusable primitives live
  under `frontend/src/components/ui/`.
- `infra/docker/` retains standalone backend and frontend deployment images;
  local orchestration is Supabase CLI plus host-run services.
