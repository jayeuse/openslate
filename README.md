# OpenSlate

OpenSlate is a self-hosted, single-installation application for each client. Its
server stack runs with Docker Compose and includes Supabase Database, Auth,
Storage, and Studio alongside the OpenSlate API, static frontend, Caddy, and
ClamAV. Development uses the same pinned Supabase services with FastAPI and
Next.js run on the host. Supabase Database is PostgreSQL, so SQLAlchemy and
Alembic remain the application persistence layer.

The supported server targets are Linux and Windows running Linux containers
through Docker Desktop/WSL2. macOS can still be used as a development
workstation; it is not a supported server target. Windows startup, reboot,
persistent-volume recovery, and restore acceptance still need a Windows host.
The production path is not accepted for general client use. A guarded
production Compose rehearsal using Linux containers on Docker Desktop for
macOS exercised readiness, Caddy CA trust, encrypted five-volume restore with
database-only session finalization, authorization and scanned-file access after
restore, and full-stack stop/start. This confirms those paths in the rehearsal
environment; it does not prove native Linux host boot/reboot behavior. Native
Linux host boot/reboot acceptance, Windows acceptance (no test host is
available), and the canonical pre-push gate/final review remain
pending. See the
[implementation plan](infra/supabase/PLAN.md) and
[restore procedure](infra/supabase/RESTORE.md).

## Stack and boundaries

- **Database:** Supabase's pinned PostgreSQL distribution. FastAPI accesses
  application tables through synchronous SQLAlchemy connections; Alembic owns
  only the OpenSlate schema. There is no pgweb service or standalone PostgreSQL
  development stack.
- **Authentication:** Supabase Auth handles email/password verification,
  invitations, and recovery email. FastAPI verifies provider identity, binds a
  provider subject to an OpenSlate profile, maintains revocable application
  sessions, and decides access from OpenSlate roles, groups, and permissions.
  Provider claims and metadata do not grant application permissions.
- **Files:** Supabase Storage holds private quarantine and ready objects. All
  upload and download authorization remains in FastAPI; ClamAV scanning is
  still required before download.
- **Events:** Authenticated SSE remains the browser event stream. PostgreSQL
  `LISTEN`/`NOTIFY` carries opaque invalidations without row snapshots.
  Supabase Realtime is a future feature and is not part of the active stack.
- **Administration:** Supabase Studio replaces pgweb. It is a privileged
  operator surface, so keep its gateway loopback-only in development and
  protected in production.
- **Audit:** Normal application ORM mutations record minimal, redacted diffs in
  the same transaction as the business change. Alembic, direct SQL, provider
  operations, and file-byte operations are outside that audit boundary.

FastAPI remains the authority for application data access, identity binding,
authorization, file access, and SSE delivery. Do not write application data
through provider APIs, Studio, or direct SQL.

## Configuration

The ignored root `.env` is the canonical local development configuration. Start
from `.env.example`, keep the file owner-only, and never pass it to Next.js or
commit it. The checked-in example has blank secrets and database role URLs. The
key generator writes a new owner-only key file and never prints its contents;
it does not assemble a complete installation environment. Copy its generated
entries into the corresponding blank fields in `.env`, then set the remaining
installation values there:

```bash
cp .env.example .env
chmod 600 .env
```

Choose a fresh `OPENSLATE_INSTANCE_ID` and private `OPENSLATE_INSTANCE_ROOT`
for a new Supabase development installation. The migration starts with fresh
application data and does not import old accounts, records, or files. Keep
existing PostgreSQL volumes and configuration until you have separately
reviewed their disposition; do not point the new Compose project at them.

After installing backend dependencies, generate keys at a new private path
whose parent directory already exists:

```bash
# backend/
uv sync --locked
uv run python operations/supabase_keys.py --output /absolute/private/path/provider-keys.env
```

Set `DATABASE_BOOTSTRAP_URL` to the provider's `supabase_admin` connection using
`POSTGRES_PASSWORD`. Set `MIGRATION_DATABASE_URL` to the application owner
login `openslate_owner` and `DATABASE_URL` to the constrained runtime login
`openslate_runtime`; supply separate passwords for those application roles.
The role provisioning command creates and checks the application roles. Never
put the bootstrap URL or `SUPABASE_SECRET_KEY` in frontend configuration or a
browser bundle. Production uses separate owner-only provider and application
environment files; see the [Supabase operator guide](infra/supabase/README.md).

Check local configuration from the repository root:

```bash
uv run --directory backend python ../scripts/environment.py check
```

## Local development

Run the following from the repository root unless a directory is shown. Start
the owned Supabase development stack with its default Compose project derived
from `OPENSLATE_INSTANCE_ID`:

```bash
./scripts/dev.py db
```

The wrapper validates `.env`, resolves the pinned base and development Compose
files, and checks instance ownership before mutating containers. It starts the
provider services, including the loopback gateway and development Mailpit.
PostgreSQL and the gateway bind to loopback; the database port is available for
host-run SQLAlchemy and Alembic. The gateway serves the operator Studio surface
on `SUPABASE_API_PORT` (default `58000`); Mailpit's inbox is on
`SUPABASE_MAIL_PORT` (default `58025`). Use the operator credentials configured
in `.env` for Studio. Studio has broader privileges than the removed read-only
pgweb inspector.

Provision the application roles, apply the fresh-install schema, check for
drift, and create the private Storage buckets:

```bash
# backend/
uv run python operations/provision_database_role.py
uv run alembic upgrade head
uv run alembic check
uv run python operations/provision_storage.py
```

Start FastAPI and Next.js in separate terminals:

```bash
# backend/
uv run python -m app --reload

# frontend/
npm ci
npm run dev
```

Next.js is the daily browser origin and proxies `/api` to the loopback FastAPI
server only in development. The static production export is served by FastAPI;
production does not run a Node.js frontend process. After FastAPI is running,
bootstrap the first administrator. Supabase sends an invitation; complete it
from the development Mailpit inbox and set the password through OpenSlate:

```bash
# backend/
uv run python operations/bootstrap_admin.py
```

`ADMIN_EMAIL` and `ADMIN_USERNAME` must be set in `.env`; usernames are profile
labels and login is by email. Production bootstrap requires the command's
`--confirm` option. Provider invitation and recovery email use the configured
SMTP service; development uses Mailpit.

The supported `./scripts/dev.py` actions are `db`, `studio`, `caddy`,
`containers`, `status`, and `stop`. For example, use `./scripts/dev.py studio`
to start the Studio gateway explicitly, or `./scripts/dev.py stop` to stop the
owned development containers while retaining their named data volumes. There
is no `pgweb` action. Do not use `docker compose down -v` on an installation
whose data should be retained.

`/api/health` remains an API-process response. `/api/ready` returns a bounded,
no-store component snapshot for the application database, Supabase Auth and
Storage health, SMTP configuration, and ClamAV. It returns 200 only when every
required component is ready and 503 otherwise. Database, Auth, Storage, and
SMTP are required; the scanner is required in production and optional in
development and tests. SMTP reports configuration presence, not email delivery.
Scanner readiness requires both an engine probe and the scanner worker's
existing PostgreSQL advisory lock; it does not establish queue progress.
A guarded production Compose rehearsal exercised all-required-component
readiness and bounded Auth, Storage, and scanner failure/recovery responses.
`/api/ready` remains a component signal, not a whole-installation or release
check; it does not establish SMTP delivery or scanner queue progress.

## Production Compose

The production overlay adds the unified FastAPI/static-frontend image, the
scanner worker, ClamAV, and Caddy. Provider services remain on private Compose
networks; the Studio gateway is loopback-bound for operator access, and only
the configured Caddy listener is public. Production needs separate provider and
application environment files, real SMTP, verified immutable ClamAV
definitions and manifest, TLS materials, and release-specific image tags.

Follow [infra/supabase/README.md](infra/supabase/README.md) for the exact
Compose inputs and startup sequence. Apply database roles, Alembic schema, and
private Storage bucket provisioning explicitly before starting the API,
scanner, or Caddy. Container health and `/api/ready` are operational signals,
not substitutes for installation checks or release acceptance. Do not run
unrestricted `up` on a fresh production installation or remove named volumes as
a reset shortcut.

Production is one isolated stack per client, not shared multi-tenant SaaS.
Linux and Windows Docker Compose are the intended server deployment paths;
Windows requires Docker Desktop using WSL2/Linux containers. Windows operational
acceptance is pending, and macOS server deployment is out of scope.

## Application data reset

The guarded reset operation is only for local development or disposable test
instances. Stop FastAPI and the scanner first. Run a dry plan, review the
preserved administrator and impact, then use `--execute` in a TTY and enter the
exact displayed impact digest:

```bash
# backend/
uv run python operations/reset_application_data.py
uv run python operations/reset_application_data.py --execute
```

The operation removes selected OpenSlate application records, associated
Supabase Auth accounts, and private Storage objects while preserving the
configured administrator. It reports partial cleanup failures for operator
recovery. It is not a database-volume reset, backup, rollback, or customer
recovery mechanism. See [RESTORE.md](infra/supabase/RESTORE.md) for the
support-operated restore procedure and its current acceptance gaps.

## Application contracts

User and role administration and audit reads require administrator authority.
The backend applies the existing feature read/write capabilities, group and
workspace rules, Board grants and audiences, Report eligibility, guest expiry,
and lifecycle constraints. Session revocation and current application
eligibility are checked independently of Supabase's authentication result.

File metadata lives in the application schema; object bytes live in private
Supabase Storage buckets. The scanner worker fetches bytes through Storage,
and only a clean, committed verdict permits authorized download. Keep upload,
scan, promotion, reconciliation, and deletion behind the existing FastAPI file
contracts.

## Verification

Use the repository's focused checks during development. The canonical release
gate is run from the repository root against the recorded base revision:

```bash
python3 scripts/prepush.py --base <base-ref>
```

It selects the applicable backend, frontend, and server-image checks. Backend
verification retains the 90% overall and changed-line coverage thresholds.
Integration tests must use the runner-owned disposable Supabase instance and
its ownership manifest; never point tests at a developer's personal or
customer installation. See [Testing Architecture](docs/architecture/16-testing-architecture.md)
for test boundaries and the pre-push gate.

## Repository architecture

- `backend/app/core/` owns configuration, database wiring, provider
  integrations, JWT verification, and middleware.
- `backend/app/common/` contains shared dependencies, exceptions, and
  utilities.
- `backend/app/systems/` groups capabilities under `sandbox`, `access`,
  `manage`, `openview`, `boards`, and `platform`.
- `backend/migrations/` is the Alembic path for the OpenSlate application
  schema. Supabase-owned Auth and Storage schemas stay provider-managed.
- `frontend/src/app/` contains App Router routes; reusable primitives live
  under `frontend/src/components/ui/`.
- `infra/supabase/` contains the pinned self-hosted provider stack and
  development/production overlays. `infra/docker/` contains the unified
  OpenSlate server image; `infra/caddy/` contains gateway artifacts.
