# Repository Guide

## Highest-priority testing rule

- **Batch by work unit, never by edit or handoff.** Use focused tests for TDD or debugging; run one relevant batch when the work stabilizes. Reuse passing evidence, including worker results, until the relevant code or setup changes.
- **Run each full suite once at its owning gate.** Frontend uses static checks, 181 isolated tests, three HTTP tests, and one production build; it has no browser or numerical coverage gate. Backend preserves its 90% overall/changed-line coverage thresholds. Documentation-only edits need no tests.
- **Fix failures narrowly.** Rerun the failing case and affected batch, then only the failed gate. Never weaken assertions or use blind retries. Use isolated PostgreSQL for database guarantees and preserve runner guards.
- **Honor explicit test skips:** stop active runs, start no replacements, and report omitted checks. These rules override conflicting testing instructions in scoped guides, skills, and worker plans.

## Scope and architecture

- Read the nearest `AGENTS.md` before subdirectory work; it takes priority in its scope. Latest user instructions take priority. Read other scoped guides only when crossing their boundaries; use `docs/architecture/README.md` for architecture details.
- Root owns orchestration/documentation and Supabase CLI commands; run Python/uv/Alembic in `backend/`, npm/Playwright in `frontend/`.
- Local development is Supabase CLI plus host-run FastAPI and Next.js. Do not add root Compose, another database UI, a reverse proxy, or filesystem storage as the supported local path.
- FastAPI owns application data access; never write application data through Supabase Data API. Alembic owns application schema; no application migrations/seeds under `supabase/`.
- Backend `app/core/` owns infrastructure, `app/common/` shared application code, and `app/systems/<capability>/` domain behavior. Active capabilities: auth, users, roles, departments, modules, fields, records, relationships, lifecycle, audit. Other systems remain placeholders until requested.

## Task scope and approval

- Before editing, define outcome, non-goals, expected files, and narrowest proof; inspect relevant implementation, tests, configuration, and instructions.
- Use the requested CLI/SSH/API access path; use UI automation only when that path is unavailable or UI operation is requested.
- Fix the root cause, reuse helpers/patterns/tests, remove replaced code unless compatibility is requested, and recheck the problem. Avoid speculative abstractions, compatibility layers, future schemas/options/services, and unrelated cleanup; abstract only for a current requirement or second real caller.
- Prefer existing libraries/components; needed dependencies may be installed without separate approval, but keep them relevant and verify integration.
- If adding an abstraction layer, configuration surface, roughly more than five files, or a speculative option, stop and reduce the design first.
- Read-only discovery needs no approval. Obtain approval for scope expansion, unrelated files, new services, unrequested public API/schema/storage/wire-format changes, data deletion, overwriting user work, discarding uncommitted changes, or rewriting Git history; preserve unrelated edits.
- VibeGuard U-17/U-29 applies only to real error paths in scope, never as justification for extra validators or compatibility layers.

## Setup and security

- Require Python `>=3.12,<3.15`, Node `>=24`; use `backend/uv.lock` and `frontend/package-lock.json`.
- Root setup: create `.env` from `.env.example` for a new checkout before `supabase start`; `supabase/config.toml` reads the canonical ports/URLs. Treat full `supabase status -o env` output as secret.
- Backend setup: `uv sync --locked`, `uv run alembic upgrade head`, `uv run alembic check`; serve with `uv run python -m app --reload`, which reads configured bind/port/limits.
- Frontend: local npm launchers generate an allowlisted `frontend/.env.local` from root `.env`; never source root `.env` into npm/Next.js. Run `npm ci`, then `npm run dev`.
- Approved destructive reset: root `supabase start`, `supabase db reset`, then backend `uv run alembic upgrade head`; Supabase reset does not restore application schema.
- `MIGRATION_DATABASE_URL` is Alembic's owner connection; `DATABASE_URL` uses `openslate_runtime`. Never substitute SQLite.
- Supabase Auth owns identities/passwords/invitations. Browser code uses only the publishable key; private credentials stay on the backend and out of tracked files/reports.
- Authorization uses ten flat read/write capabilities; malformed permission documents fail closed; literal `admin` has all capabilities.
- Mutations use `AuditSession` and individual ORM changes, never bulk/raw ORM mutations. Audit covers application ORM mutations only.
- Realtime is private Broadcast invalidation without row snapshots. Purge defaults to `LIFECYCLE_PURGE_ENABLED=false`.

## Verification and completion

- Review the final diff for correctness and scope; preserve unrelated work and remove task-created scratch code. Report actual results and blockers; deferred, skipped, or unavailable checks are unverified, never passed.
- Run the canonical pre-push gate from the root with `python3 scripts/prepush.py --base <base-ref>`; use `--list` to inspect its fail-closed change classification without running checks. It selects applicable backend, frontend, and container commands. Frontend-only changes never start backend, Supabase, scanner, or full-stack work.
- Lower-level repair commands remain available: backend uses `uv run ruff check .`, `uv run mypy app scripts`, and `COVERAGE_BASE_REF=<base-ref> uv run python -m tests.fullstack_runner --backend-coverage-only`; frontend uses `npm run verify`. Do not run these again after the canonical gate unless a failure invalidates that specific evidence.
- Record the base revision before implementation. Missing required evidence blocks normal push readiness unless the user explicitly overrides it. These scope limits take precedence over broader testing instructions; see [Testing Architecture](docs/architecture/16-testing-architecture.md) for runner details.

## Codex orchestration

- For implementation, troubleshooting, multi-agent work, or explicit evaluation, read `.agents/orchestration/PROTOCOL.md`; apply refresh-context → act → inspect-evidence → evaluate. If missing, report it and follow this guide without claiming full setup.
- Inherit parent model, effort, fallback, and approval settings from the active configuration; do not override them from this guide. Shared workers live in `~/.codex/agents/`; optional project overrides live in `.codex/agents/`; skills live in `.agents/skills/`. Read only relevant skills; repository rules/commands override mismatched generic examples.
- Handle small tasks directly; automatically delegate substantial bounded work when it improves quality or time. Do not duplicate verified discovery or assign the same investigation without distinct responsibilities.
- Planning-only requests produce investigation and a plan, not implementation. Parent owns decomposition, dependencies, difficult escalations, integration, conflict resolution, final review, and re-verification; choose workers by responsibility/complexity with domain ownership and applicable skills.
- Worker routing: `utility` = exact searches/inventories/prescribed checks; `explore` = repository tracing; `browser` = assigned live acceptance; `implement` = all delegated editing/test authoring; `analyst` = one difficult debugging, architecture, or security first pass. Use these exact roles: `explorer` is not `explore`; `general` is retired. Preserve role model/effort unless the user requests changes.
- Skill paths are `.agents/skills/<name>/SKILL.md`, resolved from root. Select by assignment; workers must read and report the paths themselves. React/Next.js: `react-frontend-patterns`; backend: `fastapi-backend-patterns`, plus `fastapi-api-design` for API contracts; database: `postgres-patterns` and `supabase-postgres-best-practices`.
- Other skills: Supabase integration → `supabase`; tooling → `project-tooling`; browser checks/test authoring → `playwright-e2e-testing`; security → `webapp-security-review`; behavior/regression tests → `tdd-workflow`; meaningful verification → `verification-loop`.
- For assigned UI visual-quality/accessibility review, add the available personal `frontend-design-review` skill. Plugin/personal skills complement project guidance only when relevant; do not load artifact skills for unrelated coding.
- A prescribed-check utility assignment does not authorize test-strategy selection. Browser assignments specify target, workflow, expected results, permitted interactions, and required evidence; unknown causes return to the parent.
- MCPs/plugins are inherited capabilities, not authorization. Use Context7 for unresolved library facts, project PostgreSQL for authorized evidence, and available browser tools for assigned live checks. If a skill expects an unavailable Supabase MCP, report it and use the configured CLI or database path only when sufficient and authorized; do not install a substitute automatically.
- Follow the protocol assignment contract: objective, ownership, constraints, dependencies, acceptance criteria, evidence, skills read/reported, and stopping condition. Workers share the checkout: preserve others' edits, parallelize only disjoint writes, serialize conflicts, and do not delegate (`[agents] enabled = false`).
- Inspect worker diffs/results, reconcile findings, and retest fixes under the root testing rule. Continue incomplete workers with the precise remaining objective; do not restart discovery or equate unfinished work with a defect.
- Keep small task state in conversation; substantial multi-step work/handoffs use the protocol's Markdown run record in ignored `.agent-runtime/`. Record evidence as work happens and checkpoint before pausing; no runtime JSON schema required.
- Change persistent memory, create goals, or schedule continuations only when requested. OpenCode goal/VibeGuard hooks and turn limits are not migrated Codex enforcement.
- Context7/Playwright inherit global MCP settings (manage through Desktop Settings when available); PostgreSQL stays in project `.codex/config.toml`. Add no filesystem/sequential-thinking/memory MCP without demonstrated need.
- After local agent setup changes, run backend `uv run python ../scripts/agent-task.py doctor`; it checks workflow assets/configuration, not application acceptance or approval enforcement.
- Do not claim background scheduling, automatic retries, per-worker cost tracing, or isolated worktrees unless actually used and verified; follow the protocol for manual maintenance reviews.
