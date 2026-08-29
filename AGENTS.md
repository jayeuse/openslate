# Repository Guide

## Boundaries

- The root is orchestration/documentation, not a package. Run Supabase commands
  at root, Python/uv/Alembic commands in `backend/`, and npm/Playwright commands
  in `frontend/`.
- Local infrastructure is Supabase CLI plus host-run FastAPI and Next.js. Do
  not add root Compose orchestration, another database/UI, a reverse proxy, or
  a filesystem storage mount as the supported development path.
- `backend/app/core/` owns cross-cutting infrastructure, `app/common/` shared
  application code, and `app/systems/<capability>/` domain behavior. Active
  capabilities are auth/users/roles, departments, modules, fields, records,
  relationships, lifecycle, and audit; `files`, `reports`, `views`,
  `businesses`, and `admin` are placeholders.
- Users and roles are aggregated by `app/systems/auth/router.py`; they are not
  registered separately in `app/main.py`. Lifecycle owns hierarchical
  close/reopen/purge rather than ordinary CRUD.
- FastAPI is the application data API. The Supabase Data API excludes the
  application schema; never add direct browser/Data API writes.
- Alembic exclusively owns application schema changes. Never add application
  migrations or seeds under `supabase/`.

## Setup and Commands

- Required runtimes: Python `>=3.12,<3.15` and Node `>=24`; use `backend/uv.lock`
  and `frontend/package-lock.json`.
- Start locally: `supabase start` at root, then use
  `supabase status -o env` to populate `.env`. Treat the complete status output
  as secret and never commit or report it.
- From `backend/`: `uv sync --locked && uv run alembic upgrade head && uv run alembic check`.
- `scripts/provision_database_role.py` does not load `.env`; export it first:
  `set -a; source ../.env; set +a`, then run
  `uv run python scripts/provision_database_role.py`.
- Bootstrap once from `backend/` with
  `uv run python scripts/bootstrap_admin.py --email <email> --username <username>`;
  the password is set from the Supabase invitation delivered to local Mailpit.
- Run the backend from `backend/` with
  `uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`.
- Run the frontend from `frontend/` after sourcing `../.env` with
  `npm ci && npm run dev -- --hostname 127.0.0.1`; Next does not automatically
  load the root environment.
- Destructive reset order is `supabase start`, `supabase db reset`, then
  `cd backend && uv run alembic upgrade head`. Supabase reset does not restore
  the Alembic-owned application schema.

## Verification

- Backend CI-equivalent checks from `backend/`:
  `uv run ruff check . && uv run mypy app scripts && TEST_DATABASE_URL="$DATABASE_URL" uv run pytest`.
- PostgreSQL integration tests skip unless `TEST_DATABASE_URL` targets the
  migrated loopback Supabase database on port `54322`, database `postgres`.
- Focused pytest runs inherit the repository-wide 80% coverage gate; use
  `uv run pytest --no-cov tests/test_health.py` or add `-k <name>` when testing
  one behavior intentionally.
- Frontend verification from `frontend/` is `npm run verify`; it runs format,
  lint, typecheck, build, and production-server Playwright tests.
- Focus one browser spec with
  `npm run test:e2e -- tests/home.spec.ts --project=chromium`. Domain Playwright
  tests mock session/BFF/API traffic; they are not live Supabase/FastAPI/DB
  integration tests.

## Data, Auth, and Audit

- `MIGRATION_DATABASE_URL` is the owner connection used by Alembic;
  `DATABASE_URL` should use the provisioned `openslate_runtime` login. Do not
  substitute SQLite: models and migrations depend on PostgreSQL JSONB, partial
  indexes, RLS, checks, and locking.
- Migration `20260819_0010_supabase_cutover.py` requires Supabase Auth/Realtime
  objects, owner-capable DDL, and an empty legacy `public.users` table.
- Supabase Auth owns identities, passwords, and invitations. Browser code uses
  only the publishable key; the Supabase secret stays backend-only. Public and
  anonymous signup are disabled; passwords require at least 12 characters.
- Current authorization checks the literal role name `admin`; stored role
  permission JSON is not evaluated.
- Domain models inherit `BaseModel` (UUIDv7, timestamps, soft-delete state,
  nullable actor). `AuditLog` and lifecycle support tables are exceptions.
- Keep mutations as individual ORM changes through `AuditSession`; bulk/raw ORM
  mutation statements are rejected. Audit covers application ORM mutations
  only—Auth, Studio, Alembic, direct SQL, Data API, and external clients are
  outside its capture boundary.
- Audit diffs are minimal and redaction is key-name based. Dynamic record data
  is keyed by field UUID, so do not assume a sensitive field label guarantees
  audit redaction.
- Realtime is private Broadcast invalidation only; payloads contain no row
  snapshots. Storage currently has a private bucket foundation but no file API.
- Purge exists but defaults off (`LIFECYCLE_PURGE_ENABLED=false`); its frontend
  visibility flag is separate and absent from `.env.example`.

## Frontend and Deployment Quirks

- Browser data calls use `/bff/*`; the BFF forwards to `BACKEND_URL/api/*` and
  retries one backend `401` after refreshing the Supabase session. `/api/*`
  rewrites also expose direct API/docs paths but do not provide cookie-to-token
  conversion.
- Before changing Next.js conventions/config, read the relevant local guide in
  `frontend/node_modules/next/dist/docs/`. Preserve the generated block at the
  top of `frontend/AGENTS.md`; `next dev` recreates it.
- `infra/docker/*.Dockerfile` are standalone image artifacts only. They do not
  start Supabase, migrate, provision roles, bootstrap users, or define a hosted
  deployment.
- `frontend/src/app/setup/page.tsx` is stale (Compose/legacy bootstrap guidance);
  use root `README.md`, executable scripts, and `docs/architecture/README.md` as
  the verified operational and architecture references.
