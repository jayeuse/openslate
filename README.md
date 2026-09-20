# OpenSlate

OpenSlate is a self-hosted foundation for configurable business operations. It
uses a host-run FastAPI backend and Next.js frontend with vanilla PostgreSQL,
private local file bytes, and a same-origin Caddy gateway.

## Stack and boundaries

- Frontend: Next.js 16, React 19, TypeScript, Tailwind CSS 4, and Playwright
- Backend: Python 3.12+, FastAPI, Pydantic, SQLAlchemy, and Alembic
- Local platform: one disposable PostgreSQL 17 container for development and CI
- Authentication: FastAPI Identity with Argon2 credentials, local PostgreSQL
  sessions/action tokens, signed JWTs, HttpOnly browser cookies plus CSRF, and
  bearer tokens for CLI use
- Auditing: application ORM mutations only, with transactional minimal diffs
  and sensitive-value redaction
- Invalidation: authenticated SSE driven by PostgreSQL `LISTEN`/`NOTIFY`; event
  payloads do not contain row snapshots
- Files: PostgreSQL metadata plus private local filesystem quarantine and ready
  object bytes

The FastAPI API owns application reads and writes, identity, file access, and
SSE authorization. Alembic owns the application schema. Do not write
application data through direct SQL or external database clients.

Audit logs cover normal application ORM entity mutations in the same
transaction as the business change. Alembic, direct SQL, filesystem byte
operations, and external clients are outside the application audit boundary.
Bulk and raw ORM mutation statements remain unsupported because they
cannot produce reliable per-record snapshots.

## Environment configuration

Repository automation, backend operator commands, and frontend launch helpers
use distinct locations. See the [command layout](scripts/README.md) before
adding or moving a command.

Edit only the ignored root `.env`, using `.env.example` as its structure. It
contains secrets, the existing administrator's local sign-in details, stack
ports, endpoints, and runtime limits. `${NAME}` references keep shared values
and ports in one place. Missing, blank, invalid, duplicate, or unresolved
configuration fails with the variable name; application code supplies no
replacement values or legacy aliases.

`frontend/.env.local` is generated from a fixed allowlist by local `npm run dev`,
`npm run build`, and `npm start`. Do not edit it or source root `.env` into
Next.js. Administrator credentials, owner/bootstrap database credentials, and
JWT signing material are excluded. Public frontend settings are baked in at build
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
   Keep an existing configured `.env`. Start the documented disposable
   PostgreSQL service before applying the schema.

   ```bash
   cp .env.example .env
   chmod 600 .env
   ./scripts/dev.py db
   ```

2. Fill the blank secret and administrator fields in root `.env`. Use
   PostgreSQL psycopg URLs for `DATABASE_BOOTSTRAP_URL`,
   `MIGRATION_DATABASE_URL`, the constrained runtime `DATABASE_URL`, and the
   read-only `DATABASE_INSPECTOR_URL` used by pgweb.
   Generate `AUTH_JWT_SECRET` and `SECURITY_EVENT_SERVER_KEY`; configure
   `PUBLIC_ORIGIN`, `CORS_ORIGINS`, and an absolute `FILES_STORAGE_ROOT`.

   `ADMIN_EMAIL`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` describe the existing
   local administrator/test account. Saving these values does not create an
   account or change its password.

3. Install backend dependencies, provision the owner/runtime/inspector roles
   through the cluster-admin connection, then apply the schema using the owner
   connection:

   ```bash
   # backend/
   uv sync --locked
   uv run python operations/provision_database_role.py
   uv run alembic upgrade head
   uv run alembic check
   ```

4. For an installation without an administrator, run the local bootstrap using
   `ADMIN_EMAIL` and `ADMIN_USERNAME`. SMTP is optional and disabled by default.
   A disabled installation uses the local temporary-password setup flow. Enable
   SMTP only after configuring and validating every `SMTP_*` setting.

   ```bash
   # backend/
   uv run python operations/bootstrap_admin.py
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

6. Start the containerized HTTPS gateway from the repository root:

   ```bash
   ./scripts/dev.py caddy
   ```

   On Windows, replace `./scripts/dev.py` with `py scripts/dev.py` in the
   developer commands.

With the example development ports, open OpenSlate at
[localhost:3448](https://localhost:3448). FastAPI docs remain available to the
developer at [localhost:8000/docs](http://localhost:8000/docs). The first
browser visit may require accepting Caddy's local development certificate.
Caddy is the installation-style HTTPS gateway. During `npm run dev`,
[localhost:3000](http://localhost:3000) is also supported: Next.js proxies its
same-origin `/api/*` requests to the configured FastAPI development origin.

## Local containers with Compose

The root Compose configuration is for local developer services. PostgreSQL is
the only database container; the `gateway` profile runs Caddy and the `db-ui`
profile runs pgweb. Migrations, role provisioning, and first local administrator
creation remain explicit commands. The environment helper validates the settings
for each selected service, generates private runtime files only for pgweb or
Caddy, and passes only each service's allowed settings. PostgreSQL always binds
to loopback.

From the repository root:

```bash
./scripts/dev.py db          # PostgreSQL only
./scripts/dev.py pgweb       # Optional database UI
./scripts/dev.py caddy       # HTTPS gateway
./scripts/dev.py containers  # All three containers
./scripts/dev.py status
./scripts/dev.py stop
```

FastAPI and Next.js run on the host through the commands in Local setup; Compose
does not build or run them. `down` leaves the development database volume intact
unless it is explicitly removed. Full rendered Compose configuration contains
secrets; use `config --quiet` for routine validation.

The gateway configuration is regenerated from `.env` at
`.agent-runtime/caddy/Caddyfile`. Caddy reaches the host-run FastAPI and Next.js
processes through Docker's host gateway, while only HTTPS port `3448` is
published on loopback. Its local certificate authority is retained in the
`caddy-data` volume across container restarts.

### Optional pgweb database UI

After role provisioning, start pgweb from the repository root through the
environment helper:

```bash
./scripts/dev.py pgweb
```

Open [localhost:8081](http://localhost:8081). pgweb is pinned to a reviewed
image, binds only to loopback, and connects with the dedicated
`openslate_inspector` login. PostgreSQL permits that login to read application
tables and rejects inserts, updates, deletes, schema changes, role changes, and
database creation. Its generated passfile is readable by pgweb's non-root UID,
while its `.agent-runtime/pgweb` directory is owner-only on the host. The pgweb
process also runs with its read-only mode enabled.

The UI can display all data in the local development database, so keep it on
loopback and stop it when it is no longer needed:

```bash
./scripts/dev.py stop pgweb
```

pgweb is a developer inspection tool. It is not included in the Windows/macOS
customer application or exposed through Caddy.

Scanner work is host-run or exercised by the disposable test runner. Before
starting the file worker, configure an existing absolute definitions path and
the matching `FILES_CLAMAV_HOST`, `FILES_CLAMAV_PORT`, and
`FILES_CLAMAV_MANIFEST_PATH`. The PostgreSQL-only Compose path does not start
or provision ClamAV. It is not the Windows/macOS customer installation path.

## Stop and reset

Stop local development services while preserving their data:

```bash
./scripts/dev.py stop
```

For a destructive disposable database reset, remove only the documented local
PostgreSQL volume, restart the database, then apply the application schema:

```bash
docker compose rm --stop --force postgres
docker volume rm openslate_postgres-data
./scripts/dev.py db
cd backend
uv run python operations/provision_database_role.py
uv run alembic upgrade head
```

To clear local application data and private file objects while keeping the
existing sample administrator usable, stop FastAPI and the file scanner, then
run the guarded reset utility from `backend/`:

```bash
# Read-only plan: review the preserved administrator and per-table counts.
uv run python operations/reset_application_data.py

# Rebuild the plan, then enter its impact digest exactly when prompted.
uv run python operations/reset_application_data.py --execute
```

The utility requires the configured disposable PostgreSQL connections,
`ADMIN_EMAIL`, and the canonical `BACKEND_PORT=8000`; it verifies Alembic head
and fails closed on schema drift or an active API/scanner. Every application profile except `ADMIN_EMAIL`'s
matching profile is deleted, along with all domain, relationship, audit, and
lifecycle rows, saved views, file metadata, and every custom role. It resets
the workspace singleton's editable fields to their migration defaults while
preserving its ID. The utility refuses to run when another effective
administrator exists; pending, disabled, and soft-deleted
admin-shaped profiles are reset. It preserves the matching active administrator
profile and the required `admin` and `member` roles. After the database commit
it deletes private local objects, including objects without matching file rows.
Filesystem deletion cannot share the database
transaction: if it fails, the utility reports that the database was already
reset and requires a fresh dry run before retrying cleanup. Because deleted
profiles are removed, retained `performed_by` references to them are
intentionally cleared by the database's `ON DELETE SET NULL` behavior;
retained non-admin identities cannot access FastAPI after their application
profiles are removed.

This utility is local-only. It is not a release rollback or a hosted recovery
mechanism; recovery requires the separately selected backup and restore process.

Schema changes go through `backend/migrations/` and are checked with Alembic.

## Domain API

Roles, users, departments, modules, fields, records, and audit reads are
administrator-only. Domain collections use the standard list contract and
expose `POST`, `GET`, `PATCH`, soft `DELETE`, and restore where applicable.
Records validate active field definitions, required values, select options, and
JSON value types.

FastAPI Identity issues short-lived signed JWTs, stores local sessions and
action tokens in PostgreSQL, and manages HttpOnly browser cookies plus CSRF.
Optional SMTP delivery uses a PostgreSQL outbox with encrypted payloads,
bounded retry, and one-time invitation/recovery links. It remains healthy when
disabled. Authenticated SSE invalidates client caches without carrying row
data. Files live in the private configured storage root and are mediated by
FastAPI.

## Verification

After PostgreSQL is running and Alembic has applied the schema:

```bash
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
`python3 scripts/run_tests.py backend section runtime --layer isolated`. From
`frontend/`, run `npm run test:section -- security --layer isolated` or
`npm run test:affected -- --list`. See the [testing workflow](docs/architecture/16-testing-architecture.md)
for sections, affected selection, and full verification.

PostgreSQL integration tests can use the local database URL without exposing
it in source control:

```bash
TEST_DATABASE_URL="$DATABASE_URL" uv run pytest tests/test_audit_integration.py
```

## Proposed customer installation

The [deployment architecture](docs/architecture/12-deployment-architecture.md)
describes a future Windows or macOS server app that one customer installs on a
host computer for browser and installable web-app access by their team. It
specifies platform packaging, automatic setup and safe retry, updates, backups,
and recovery. The repository now has a development native Manager shell and a
guarded encrypted-backup command, but no signed customer installer or bundled
native services. The local developer setup above remains the supported path.

## Future hosted deployment

Hosted deployment is not implemented or production-ready. The approved contract
and release order are in [Deployment architecture](docs/architecture/12-deployment-architecture.md):
one trust domain per deployment with isolated local identity, PostgreSQL,
private files, secrets, backups, and administrator population; shared tenancy
is deferred. Caddy is the browser-facing origin and FastAPI remains private
behind its same-origin `/api` route.

CI verifies both standalone images but does not publish or deploy them. The
frontend image uses same-origin API paths; neither image migrates, provisions,
or bootstraps the database.

Registry, secret manager, SMTP provider, RPO/RTO, retention, full restore
procedure, and hosted topology remain selections or blockers. The SMTP outbox
and backup command are application foundations; they do not choose or operate
those external services for a hosted deployment.

The vanilla PostgreSQL baseline requires the owner migration connection and
separate runtime-role provisioning. Before a hosted cutover, verify that the
deployment principal has the documented owner/bootstrap capabilities.

## Repository architecture

- `backend/app/core/` owns configuration, database wiring, security, and
  integrations.
- `backend/app/common/` contains shared dependencies, exceptions, and
  utilities.
- `backend/app/systems/` groups capability packages under product domains:
  `sandbox` for organization structure, `access` for identity/roles, `manage`
  for workspace/audit, `openview` for saved views, and `platform` for files.
  `boards` and `comms` are reserved. This backend grouping does not connect
  the frontend's local sample features to the API.
- `backend/migrations/` is the only supported path for application schema
  changes.
- `backend/app/systems/manage/audit/` owns transactional ORM listeners,
  before/after diffing, redaction, and administrator-only audit reads.
- `frontend/src/app/` contains App Router routes; reusable primitives live
  under `frontend/src/components/ui/`.
- `infra/docker/` retains standalone backend and frontend deployment images;
  local development uses PostgreSQL plus host-run services.
