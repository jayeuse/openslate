# Repository Guide

## Scope and Boundaries

Read the nearest `AGENTS.md` before work in a subdirectory. The nearest file takes priority in that scope.

The repository root owns orchestration and documentation. Run Supabase commands at the root. Run Python, uv, and Alembic commands in `backend/`. Run npm and Playwright commands in `frontend/`.

Local development uses Supabase CLI with host-run FastAPI and Next.js. Do not add root Compose orchestration, another database UI, a reverse proxy, or filesystem storage as the supported local path.

FastAPI is the application data API. Do not write application data through the Supabase Data API. Alembic owns application schema changes. Do not add application migrations or seeds under `supabase/`.

`backend/app/core/` owns cross-cutting infrastructure. `backend/app/common/` owns shared application code. `backend/app/systems/<capability>/` owns domain behavior.

Active capabilities are auth, users, roles, departments, modules, fields, records, relationships, lifecycle, and audit. Other system directories remain placeholders until requested.

## Task Rules

Use the smallest sufficient change. The latest user instruction has priority.

Before editing, identify the exact outcome, non-goals, expected files, and narrowest proof. Read the relevant implementation, tests, configuration, and scoped `AGENTS.md` files first.

Use the requested access path. Do not replace CLI, SSH, or API work with UI automation unless the requested path is unavailable or the user requests UI operation.

For troubleshooting, gather evidence first. Change the smallest relevant part. Recheck the original problem. Stop when the requested behavior works.

Do not add speculative abstractions, compatibility layers, future schemas, configuration options, dependencies, services, or unrelated cleanup. Add an abstraction only for a current requirement or a second real caller.

If the work adds a new abstraction layer, a new configuration surface, roughly more than five files, or a speculative option, stop and reduce the design first.

Reuse existing helpers, patterns, and tests. Fix the root cause. Remove replaced code unless compatibility is requested.

VibeGuard U-17/U-29 applies only to real error paths in the requested change. Do not use it to justify extra validators or compatibility layers.

## Approval

Read-only discovery does not need approval.

Get approval before you expand scope, touch unrelated files, add a dependency or service, or change an unrequested public API, schema, storage format, or wire format.

Also get approval before you delete data, drop data, overwrite user work, discard uncommitted changes, or rewrite Git history.

## Verification

Run the narrowest existing check that proves the change.

Extend the nearest existing test before you create a new test file. Add tests only for changed behavior, a known regression risk, or an explicit request.

Before completion, inspect the diff. Remove debug code, dead code, backups, scratch files, and unrelated changes.

A task is complete when the requested behavior works, the acceptance criteria pass, relevant checks pass, and the diff contains only necessary changes.

Report the verification commands and results. Also report assumptions, limitations, and runtime behavior that you did not verify.

Update existing documentation only when the implementation changes documented behavior. Use the smallest existing document with the correct scope.

## Setup

Required runtimes are Python `>=3.12,<3.15` and Node `>=24`. Use `backend/uv.lock` and `frontend/package-lock.json`.

Start local infrastructure from the root:

```bash
supabase start
supabase status -o env
```

Treat the full Supabase status output as secret.

Set up the backend from `backend/`:

```bash
uv sync --locked
uv run alembic upgrade head
uv run alembic check
```

Run the backend with:

```bash
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Use `frontend/.env.local` for frontend environment values. Do not source the root `.env` into npm or Next.js.

Run the frontend from `frontend/`:

```bash
npm ci
npm run dev -- --hostname 127.0.0.1
```

For a destructive local reset:

```bash
supabase start
supabase db reset
cd backend
uv run alembic upgrade head
```

Supabase reset does not restore the Alembic-owned application schema.

## Verification Commands

Run backend verification from `backend/`:

```bash
uv run ruff check .
uv run mypy app scripts
TEST_DATABASE_URL="$DATABASE_URL" uv run pytest
uv run alembic check
```

Run frontend verification from `frontend/`:

```bash
npm run verify
```

Use focused tests when the full suite is not necessary.

## Global Data and Security Rules

`MIGRATION_DATABASE_URL` is the Alembic owner connection. `DATABASE_URL` uses the `openslate_runtime` login. Do not substitute SQLite.

Supabase Auth owns identities, passwords, and invitations. Browser code uses only the publishable key. Keep private Supabase credentials on the backend.

Domain authorization uses ten flat read/write capabilities. Malformed permission documents fail closed. The literal `admin` role has all capabilities.

Application mutations use `AuditSession` and individual ORM changes. Do not use bulk or raw ORM mutation statements. Audit covers application ORM mutations only.

Realtime uses private Broadcast invalidation. Do not send row snapshots in realtime payloads.

Purge is disabled by default with `LIFECYCLE_PURGE_ENABLED=false`.

## Scoped References

Use `backend/AGENTS.md` for backend architecture, API, audit, persistence, and testing rules.

Use `backend/migrations/AGENTS.md` for schema changes and Alembic workflow.

Use `frontend/AGENTS.md` for Next.js, React, auth, data access, styling, and frontend testing rules.

Use `infra/AGENTS.md` for image and deployment artifact rules.

Use `docs/architecture/README.md` for deeper architecture details.

For tasks that require multiple agents, parallel work, or explicit evaluator loops, read `.agents/orchestration/PROTOCOL.md.`