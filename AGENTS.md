# Repository Guide

## Boundaries

- Read subdirectory AGENTS.md files before doing anything within those
  subdirectories — for example `backend/migrations/AGENTS.md` before any
  migration work. Their rules take precedence within their scope.
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

## Scope Guard

Complete each task with the minimum sufficient change. The latest user
instruction is authoritative; do not widen its scope without approval.

### Frame the Task First

- Before using tools, identify the exact target, requested behavior or failure
  direction, and requested access path. Apply the user's latest correction
  immediately rather than carrying forward an earlier assumption.
- Use the requested SSH, CLI, API, or other access path. Do not substitute UI
  automation, screen control, or synthetic input unless the user explicitly
  requests UI operation for this task or the requested path is unavailable. An
  open or authenticated desktop application is not authorization to operate it.
- Diagnose the named system before adjacent systems. For troubleshooting,
  gather evidence, make one minimal change, recheck the original symptom, and
  stop when the requested behavior works. Ask one short question before
  operating an external system only when the target or direction is ambiguous.

### Read and Plan

- Read the relevant implementation, tests, and configuration directly and in
  sufficient context; do not build from search excerpts, summaries, guesses, or
  unverified premises when the source is available.
- Before editing, state one minimal path with its exact **Outcome**,
  **Non-goals**, smallest expected **Files** set, and narrowest **Proof**. Split
  work only when it has genuinely independent parts.

### Prefer the Simple Design

- Implement only the current requirement. Treat “perfect” and “long-term” as
  quality goals, not permission for a platform redesign. Mention possible
  extensions briefly at the end rather than implementing them now.
- Do not add compatibility shims, legacy fallbacks, data backfills, future
  schemas, tiers, modes, options, or configuration surfaces unless explicitly
  requested. Breaking compatibility is acceptable by default, but public API,
  schema, storage, and wire-format changes still require approval when the task
  does not already authorize them.
- Do not mechanize review judgment with hardcoded validators, closed error-code
  sets, alias tables, or rule engines. Validate once at the trusted boundary;
  avoid duplicate checks, double probes, and parallel bookkeeping.
- Stop before coding if the path introduces a new abstraction layer or config
  surface, roughly more than five new files, or any speculative option. Present
  the minimal design separately from the larger alternative and default to the
  minimal one.
- VibeGuard U-17/U-29 error strictness applies only to real error paths within
  the requested change; it does not justify new validators, compatibility
  layers, or checks. If the user calls a design over-engineered, remove the
  excess rather than defending it.

### Edit Narrowly

- Reuse existing helpers, patterns, and test setup. Fix the root cause rather
  than stacking workarounds on an incorrect premise.
- Add an abstraction, adapter, or configuration layer only for a stated
  requirement or a second real caller in this task. Preserve unrelated behavior
  and do not design for unrequested rare or future cases.
- Remove replaced code unless compatibility was explicitly requested. Every
  touched file must serve the requested outcome; do not mix in cleanup.

### Approval Boundaries

- Read-only discovery is allowed. Unless already authorized, obtain approval
  before expanding scope, touching unrelated files, adding a dependency,
  framework, service, or test infrastructure, changing a public API/schema/
  storage/wire format, or keeping two implementations active.
- Also obtain approval before deleting or overwriting user data, dropping data,
  discarding uncommitted work, or rewriting history.

### Verify and Finish

- Run the narrowest existing check that exercises the change, using the command
  locations and caveats below. Extend the closest test before creating a test
  file; add tests only for uncovered changed behavior, an identified regression
  risk, or an explicit request. Do not backfill unrelated coverage or create
  task-specific test infrastructure.
- If work begins accumulating future-use layers, compatibility paths,
  workarounds, speculative options, unrelated cleanup, or tests for unstated
  behavior, stop, rewrite a smaller plan, and confirm it before continuing.
- Done means the requested behavior and acceptance criteria are met, relevant
  checks pass, and the diff contains only necessary files. Inspect it for debug
  code, backups, dead paths, scratch files, and unrelated changes. Report exact
  commands and results plus assumptions, limitations, and unverified runtime
  behavior; passing tests never justify extra scope.
  - After the implementation and verification are complete, check whether the task
  changed documented core behavior. This includes architecture, setup, commands,
  data flow, security boundaries, lifecycle rules, public interfaces, or other
  behavior that developers rely on. If it did, update the smallest set of
  existing related documents so they describe the implemented system accurately.
  Do not create new documentation files when an existing document has the correct
  scope. Do not update documentation for internal refactors that leave documented
  behavior unchanged. Treat documentation updates as part of the task only when
  the implementation makes the existing documentation inaccurate.

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
- Run the frontend from `frontend/` with a frontend-only `.env.local` copied
  from `frontend/.env.example`; never source the root `.env` into npm or Next.
  Then run `npm ci && npm run dev -- --hostname 127.0.0.1`.
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
- Domain authorization evaluates ten flat read/write capabilities stored in
  role permission JSON; malformed documents fail closed. The literal `admin`
  role implicitly has all capabilities, while users/roles/invitations/audit and
  purge remain administrator-only.
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
