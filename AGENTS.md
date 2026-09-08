# Repository Guide

## Scope and architecture
- Read the nearest `AGENTS.md` before subdirectory work; it takes priority in its scope. Latest user instructions take priority.
- Root owns orchestration/documentation and Supabase CLI commands; run Python/uv/Alembic in `backend/`, npm/Playwright in `frontend/`.
- Local development is Supabase CLI plus host-run FastAPI and Next.js. Do not add root Compose, another database UI, a reverse proxy, or filesystem storage as the supported local path.
- FastAPI owns application data access; never write application data through Supabase Data API. Alembic owns application schema; no application migrations/seeds under `supabase/`.
- Backend `app/core/` owns infrastructure, `app/common/` shared application code, and `app/systems/<capability>/` domain behavior.
- Active capabilities: auth, users, roles, departments, modules, fields, records, relationships, lifecycle, audit. Other systems remain placeholders until requested.
- Read scoped guides in `backend/`, `backend/migrations/`, `frontend/`, `infra/`, `supabase/`, and `docs/`; deeper architecture starts at `docs/architecture/README.md`.

## Task scope and approval
- Before editing, define outcome, non-goals, expected files, and narrowest proof; inspect relevant implementation, tests, configuration, and instructions.
- Use the requested CLI/SSH/API access path; use UI automation only when that path is unavailable or UI operation is requested.
- Make the smallest sufficient change: gather evidence, fix the root cause, reuse helpers/patterns/tests, remove replaced code unless compatibility is requested, and recheck the original problem.
- Avoid speculative abstractions, compatibility layers, future schemas/options/services, and unrelated cleanup. Abstract only for a current requirement or a second real caller.
- Prefer existing libraries/components; needed dependencies may be installed without separate approval, but keep them relevant and verify integration.
- If adding an abstraction layer, configuration surface, roughly more than five files, or a speculative option, stop and reduce the design first.
- Read-only discovery needs no approval. Obtain approval for scope expansion, unrelated files, new services, or unrequested public API/schema/storage/wire-format changes.
- Obtain approval before deleting/dropping data, overwriting user work, discarding uncommitted changes, or rewriting Git history; preserve unrelated edits.
- VibeGuard U-17/U-29 applies only to real error paths in scope, never as justification for extra validators or compatibility layers.

## Setup and security
- Require Python `>=3.12,<3.15`, Node `>=24`; use `backend/uv.lock` and `frontend/package-lock.json`.
- Root startup: `supabase start`, then `supabase status -o env`; treat the full status output as secret.
- Backend setup: `uv sync --locked`, `uv run alembic upgrade head`, `uv run alembic check`; serve with `uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`.
- Frontend: use `frontend/.env.local`, never source root `.env` into npm/Next.js; run `npm ci`, then `npm run dev -- --hostname 127.0.0.1`.
- Approved destructive reset: root `supabase start`, `supabase db reset`, then backend `uv run alembic upgrade head`; Supabase reset does not restore application schema.
- `MIGRATION_DATABASE_URL` is Alembic's owner connection; `DATABASE_URL` uses `openslate_runtime`. Never substitute SQLite.
- Supabase Auth owns identities/passwords/invitations. Browser code uses only the publishable key; private credentials stay on the backend and out of tracked files/reports.
- Authorization uses ten flat read/write capabilities; malformed permission documents fail closed; literal `admin` has all capabilities.
- Mutations use `AuditSession` and individual ORM changes, never bulk/raw ORM mutations. Audit covers application ORM mutations only.
- Realtime is private Broadcast invalidation without row snapshots. Purge defaults to `LIFECYCLE_PURGE_ENABLED=false`.

## Verification and completion
- Run the narrowest existing checks proving the change; extend the nearest test before adding files, and add tests only for changed behavior, known regression risk, or explicit requests.
- Backend checks: `uv run ruff check .`, `uv run mypy app scripts`, `TEST_DATABASE_URL="$DATABASE_URL" uv run pytest`, `uv run alembic check`; frontend: `npm run verify`. Focus runs when sufficient.
- Verify rendered UI behavior in a browser when runnable; static checks and worker claims do not prove runtime behavior. Missing services are environment blockers, not application defects.
- Inspect the final diff; remove debug/dead code, backups, scratch files, and unrelated changes. Update the smallest existing document only when documented behavior changes.
- Continue until requested behavior, acceptance criteria, relevant checks, and diff scope pass, or a concrete blocker needs input. Report commands/results, assumptions, limitations, and unverified runtime behavior.

## Codex orchestration
- For implementation, troubleshooting, multi-agent work, or explicit evaluation, read `.agents/orchestration/PROTOCOL.md`; apply refresh-context → act → inspect-evidence → evaluate. If missing, report it and follow this guide without claiming full setup.
- Preserve global primary model/approval settings and existing worker model overrides. Workers: `.codex/agents/`; skills: `.agents/skills/`. Read only relevant skills; repository rules/commands override mismatched generic examples.
- Handle small tasks directly; automatically delegate substantial bounded work when it improves quality or time. Do not duplicate verified discovery or assign the same investigation without distinct responsibilities.
- Planning-only requests produce investigation and a plan, not implementation. Parent owns decomposition, dependencies, integration, conflict resolution, and final review.
- Route discovery to `explore`; application work to `backend-general`/`frontend-general`; schema to `db-general`; runtime/deployment to `infra-general`.
- Route code verification to `backend-test`/`frontend-test`/`db-test`, live browser acceptance to `playwright-tester`, and unclear confirmed defects to the matching `backend-debug`/`frontend-debug`/`db-debug`/`infra-debug`.
- Use `architect`/`security` for relevant reviews; call `architect-deep`/`security-deep`/`debug-deep` only after first-pass low confidence or explicit escalation, carrying findings, evidence, uncertainties, and references.
- Give workers objective, ownership, constraints, dependencies, acceptance criteria, expected evidence, skill paths, and stopping condition; require reading/reporting applicable skills.
- Workers share the checkout: preserve others' edits, parallelize only independent disjoint writes, serialize conflicts, and return to parent without further delegation (`[agents] enabled = false`).
- Inspect every worker diff/result, reconcile findings, and retest fixes. Continue incomplete workers with the precise remaining objective; do not restart discovery or equate unfinished work with a defect.
- Keep small task state in conversation; substantial multi-step work/handoffs use the protocol's Markdown run record in ignored `.agent-runtime/`. Record evidence as work happens and checkpoint before pausing; no runtime JSON schema required.
- Change persistent memory, create goals, or schedule continuations only when requested. OpenCode goal/VibeGuard hooks and turn limits are not migrated Codex enforcement.
- Context7/Playwright inherit global MCP settings (manage through Desktop Settings when available); PostgreSQL stays in project `.codex/config.toml`. Add no filesystem/sequential-thinking/memory MCP without demonstrated need.
- After local agent setup changes, run backend `uv run python ../scripts/agent-task.py doctor`; it checks workflow assets/configuration, not application acceptance or approval enforcement.
- Do not claim background scheduling, automatic retries, per-worker cost tracing, or isolated worktrees unless actually used and verified; follow the protocol for manual maintenance reviews.
