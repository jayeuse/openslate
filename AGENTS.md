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

Do not add speculative abstractions, compatibility layers, future schemas, configuration options, services, or unrelated cleanup. Add an abstraction only for a current requirement or a second real caller.

Prefer suitable existing libraries and components over rebuilding functionality they already provide. You may install dependencies needed for the requested work without separate approval. Reuse the current stack where practical, keep additions relevant to the task, and verify the integration.

If the work adds a new abstraction layer, a new configuration surface, roughly more than five files, or a speculative option, stop and reduce the design first.

Reuse existing helpers, patterns, and tests. Fix the root cause. Remove replaced code unless compatibility is requested.

VibeGuard U-17/U-29 applies only to real error paths in the requested change. Do not use it to justify extra validators or compatibility layers.

## Approval

Read-only discovery does not need approval.

Get approval before you expand scope, touch unrelated files, add a service, or change an unrequested public API, schema, storage format, or wire format.

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

For implementation, troubleshooting, multi-agent work, or explicit evaluation, read `.agents/orchestration/PROTOCOL.md`. Apply its refresh-context -> act -> inspect-evidence -> evaluate loop; keep small tasks in the conversation. If the local protocol is missing, report the missing setup and use the rules here without claiming the full workflow is installed.

## Codex Orchestration

Use the current primary model and approval settings from the user's global Codex configuration. Project workers live in `.codex/agents/`; project skills live in `.agents/skills/`. Keep the existing worker model overrides. Load only skills relevant to the assigned task. Repository instructions and installed project commands take precedence over generic skill examples (including pnpm, Pyright, Compose, or async SQLAlchemy examples that do not match this repository).

Handle small, focused tasks directly. Delegate only when a bounded task benefits from separate work; do not duplicate verified discovery or use multiple workers for the same investigation without evidence of distinct responsibilities.

For planning-only requests, gather evidence and return a plan without implementation. Use `explore` for narrow repository questions and `architect` or `security` for relevant decisions. Split plans by the domains actually affected.

For implementation, the parent owns task decomposition, dependency ordering, integration, conflict resolution, and final review. Route work using the existing project workers:

| Work | Worker |
| --- | --- |
| Repository discovery and cross-domain tracing | `explore` |
| FastAPI, Python services, schemas, authorization, ORM mappings | `backend-general` |
| React/Next.js pages, state, forms, API integration | `frontend-general` |
| Alembic migrations, PostgreSQL schema, indexes, privileges | `db-general` |
| Existing local runtime, environment, deployment configuration | `infra-general` |
| Backend, frontend, or database code-level verification | `backend-test`, `frontend-test`, `db-test` |
| Live browser acceptance checks once the app is running | `playwright-tester` |
| Confirmed defects with unclear causes | `backend-debug`, `frontend-debug`, `db-debug`, `infra-debug` |
| Architecture and security review | `architect`, `security` |

Give each worker a precise objective, owned files or module boundaries, constraints, dependencies, acceptance criteria, expected evidence, and stopping condition. Tell workers they share the checkout: preserve others' edits, do not revert unrelated changes, and adapt to completed work. Parallelize only independent tasks with disjoint write ownership. Workers return to the parent instead of delegating further; their `[agents] enabled = false` enforces this.

Call the first-pass reviewer before `architect-deep`, `security-deep`, or `debug-deep`. Escalate only after reported low confidence or an explicit escalation recommendation, carrying forward findings, evidence, uncertainties, and file references. Continue an incomplete worker with the exact remaining objective; do not restart completed investigation or treat unfinished implementation as a defect.

Inspect every worker result. Run the narrowest relevant verification, resolve conflicting findings, and retest the original failing behavior after fixes. A missing running service is an environment blocker, not proof of an application defect. Browser acceptance checks complement code-level tests.

Continue authorized work until acceptance criteria and relevant checks pass or a concrete blocker requires user input. Do not create goals or scheduled continuations unless requested. OpenCode's goal and VibeGuard plugins are not Codex plugins; do not claim their hooks, automatic turn limits, or enforcement were migrated.

Context7 and Playwright are inherited from global Codex MCP settings; manage them through Desktop Settings when available. PostgreSQL remains project-scoped in `.codex/config.toml`. Do not add filesystem, sequential-thinking, or memory MCPs without a demonstrated need. Keep connection credentials out of tracked files and reports.

For multi-worker task coordination, use `.agents/orchestration/PROTOCOL.md`. Keep simple task state in the conversation. For substantial multi-step work or a handoff, use its Markdown run record in the already-ignored `.agent-runtime/` directory. Record evidence as work happens and checkpoint before pausing; no runtime JSON schema is required. Promote cross-run lessons into memory only when the user explicitly requests it.

After changing local agent setup, run `uv run python ../scripts/agent-task.py doctor` from `backend/`. This read-only check validates local workflow assets and worker configuration; it does not run application acceptance tests or enforce approvals. The protocol defines the evidence required for task completion and the manual multi-run maintenance review. Do not claim background scheduling, automatic retries, per-worker cost tracing, or isolated worker worktrees unless those capabilities were actually used and verified.
