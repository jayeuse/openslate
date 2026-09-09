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

## Local setup

Run these commands from the repository root unless a `cd` is shown.

1. Start the Supabase local platform:

   ```bash
   supabase start
   ```

2. Create the local backend and migration environment file:

   ```bash
   cp .env.example .env
   ```

3. Retrieve local connection values without committing them:

   ```bash
   supabase status -o env
   ```

    Fill the root `.env` using only these mappings from that output. This file is
    for the backend and migration/operations commands; do not source it into the
    frontend process:

   | `.env` setting | Supabase CLI value |
   | --- | --- |
   | `MIGRATION_DATABASE_URL` | `DB_URL`, with the SQLAlchemy `postgresql+psycopg://` scheme |
   | `SUPABASE_URL` | `API_URL` |
   | `SUPABASE_PUBLISHABLE_KEY` | `ANON_KEY` |
   | `SUPABASE_SECRET_KEY` | `SERVICE_ROLE_KEY` (backend only) |

   `SUPABASE_JWT_ISSUER` is the local API URL plus `/auth/v1`, and
   `SUPABASE_JWKS_URL` is that issuer plus
   `/.well-known/jwks.json`. Keep all values from `supabase status -o env`
   private; do not paste the complete command output into the repository.

4. Apply the application schema with Alembic. Supabase migrations and seeds
   are disabled in `supabase/config.toml`:

   ```bash
   cd backend
   uv sync
   uv run alembic upgrade head
   ```

5. Generate a separate application-database password, set
   `OPENSLATE_DATABASE_PASSWORD`, URL-encode it in `DATABASE_URL`, and provision
   the least-privilege runtime login:

   ```bash
   uv run python scripts/provision_database_role.py
   ```

6. Create the first administrator through the Supabase invitation flow. Open
   the invitation in local Mailpit and set the account password in the app:

   ```bash
   uv run python scripts/bootstrap_admin.py --email <email> --username <username>
   ```

7. Configure and run the host services in separate terminals. The frontend has
   its own environment file. From `frontend/`, copy `.env.example` to
   `.env.local` and fill only `BACKEND_URL`, the two public Supabase values, and,
   if explicitly needed, `NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED`. Do not source the
   root `.env`; `npm ci` does not need backend secrets:

   ```bash
   # terminal: backend/
   uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

    # terminal: frontend/
    cp .env.example .env.local
    npm ci
    npm run dev -- --hostname 127.0.0.1
   ```

The app is at <http://localhost:3000> and the FastAPI docs are at
<http://localhost:8000/docs>. Supabase Studio is at
<http://127.0.0.1:54323>; Mailpit is at
<http://127.0.0.1:54324>. The Supabase API and database use the ports shown by
`supabase status` (normally `54321` and `54322`).

Supabase CLI manages the local service bindings. Verify that the URLs in
`supabase status` and the published ports are loopback-only before using the
stack. Do not add PostgreSQL network restrictions to achieve this: Supabase
service-to-service connections need the local Docker network.

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
set -a
source ../.env
set +a

# Read-only plan: review the preserved administrator and per-table counts.
uv run python scripts/reset_application_data.py

# Rebuild the plan, then enter its impact digest exactly when prompted.
uv run python scripts/reset_application_data.py --execute
```

The utility accepts only the loopback Supabase database at
`127.0.0.1:54322/postgres`, requires `MIGRATION_DATABASE_URL` and
`SAMPLE_EMAIL`, verifies the running Supabase project and Alembic head, and
fails closed on schema drift. Every application profile except `SAMPLE_EMAIL`'s
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
npm run test:e2e
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
