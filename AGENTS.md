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
- Run the narrowest existing checks proving the change; extend the nearest test before adding files, and add tests only for changed behavior, known regression risk, or explicit requests.
- Backend pre-push checks: `uv run ruff check .`, `uv run mypy app scripts`, and `COVERAGE_BASE_REF=<base-ref> uv run python -m tests.fullstack_runner --backend-coverage-only` (includes disposable PostgreSQL and Alembic checks); frontend: `npm run verify` plus `COVERAGE_BASE_REF=<base-ref> npm run test:coverage`. Record the base revision before implementation.
- Verify rendered UI behavior in a browser when runnable; static checks and worker claims do not prove runtime behavior. Missing services are environment blockers, not application defects.
- Inspect the final diff; remove debug/dead code, backups, scratch files, and unrelated changes. Update the smallest existing document only when documented behavior changes.
- Continue until requested behavior, acceptance criteria, relevant checks, and diff scope pass, or a concrete blocker needs input. Report commands/results, assumptions, limitations, and unverified runtime behavior.

### Non-negotiable test workflow
- Do not manually launch coverage collection or an extra coverage-instrumented test run, including during push preparation. Leave coverage execution to the existing configured pre-push gate and CI; do not duplicate it as an agent-run check. Preserve all existing pre-push requirements, hooks, thresholds, and CI checks. This rule overrides instructions elsewhere to launch coverage separately.
- Do not run unnecessary or duplicate tests. During development, run only the smallest focused check needed to prove the changed behavior. Expand to a feature batch or affected integration only when a concrete failure or changed boundary requires it; do not mechanically run every testing tier after each edit.
- Full suites and coverage belong exclusively to the configured pre-push gate. Do not run extra copies before that gate, after passing evidence, for documentation-only changes, or for routine commits and handoffs. Reuse valid passing evidence; parent review does not require repeating a worker's verified checks.
- An explicit user instruction to skip tests or push without tests overrides local testing requirements for that action. Stop active test runs, do not start replacements, and proceed with the authorized commit/push. Report omitted checks accurately without claiming they passed; do not disable persistent hooks or CI configuration.
- Apply [Testing Architecture](docs/architecture/16-testing-architecture.md) with the scope limits above: focused test → justified feature batch or affected integration → pre-push gate. This is an escalation path, not a mandatory sequence for every change.
- Fix a failing case, rerun that case, then its affected batch. Close a batch only when required cases pass; expected errors must be asserted by passing tests. Never hide failures with skips, weaker assertions, or repeated retries.
- Test at the lowest layer that proves the behavior. Use real PostgreSQL for database guarantees and browsers for rendered interactions; check affected boundaries early for auth, schema, shared configuration, or framework changes.
- Keep coverage collection off routine edit loops. Only when preparing to push, run the affected projects' full suites and required coverage gates after batches stabilize; preserve 90% overall and changed-line thresholds and all required CI checks.
- After a pre-push gate failure, debug narrowly, then rerun the affected gate. Reuse passing evidence only while its source, tests, dependencies, configuration, and relevant shared boundaries remain unchanged.
- Reuse setup only through supported runner isolation; never bypass database guards. Parallel runs require separate ports, outputs, and mutable test data; pre-push disposable-stack gates start fresh.
- Report selected scope, results, and blockers. Missing required services or skipped required tests leave the applicable check unverified; missing required coverage blocks normal push readiness unless the user explicitly directs publication without it. Before push preparation, report full gates as deferred, not passed.

## Codex orchestration
- For implementation, troubleshooting, multi-agent work, or explicit evaluation, read `.agents/orchestration/PROTOCOL.md`; apply refresh-context → act → inspect-evidence → evaluate. If missing, report it and follow this guide without claiming full setup.
- Inherit the global parent `gpt-6-astra` / `medium` and approval settings; default subagent fallback is `gpt-5.6-luna` / `max`. Shared workers live in `~/.codex/agents/`; optional project overrides live in `.codex/agents/`; skills live in `.agents/skills/`. Read only relevant skills; repository rules/commands override mismatched generic examples.
- Handle small tasks directly; automatically delegate substantial bounded work when it improves quality or time. Do not duplicate verified discovery or assign the same investigation without distinct responsibilities.
- Planning-only requests produce investigation and a plan, not implementation. Parent owns decomposition, dependencies, integration, conflict resolution, and final review.
- Choose a shared role by responsibility and complexity; include domain ownership and the applicable skill paths below in each assignment. Difficult escalations, integration, final review, and re-verification remain with the Astra-medium parent.

### Worker routing

| Work | Worker | Model | Effort |
| --- | --- | --- | --- |
| Exact searches, inventories, prescribed checks | `utility` | `gpt-5.6-luna` | `max` |
| Repository exploration and behavior tracing | `explore` | `gpt-5.6-luna` | `max` |
| Assigned live-browser reproduction and acceptance | `browser` | `gpt-5.6-luna` | `max` |
| All implementation and test authoring, routine or substantial | `implement` | `gpt-6-astra` | `medium` |
| Difficult debugging, architecture planning, security first pass (one mode) | `analyst` | `gpt-6-astra` | `medium` |

Use these exact configured role names; `explorer` is not an alias for `explore`. `general` is retired: `implement` owns all delegated editing and test authoring. Preserve named-role model/effort settings unless the user requests an override.

### Project skill routing
Resolve these skill paths from the repository root. Select only the skills relevant to the assignment; workers read and report them themselves.

| Domain / task | Skill paths |
| --- | --- |
| React/Next.js implementation or tracing | `.agents/skills/react-frontend-patterns/SKILL.md` |
| Backend behavior; API contract work when applicable | `.agents/skills/fastapi-backend-patterns/SKILL.md`; `.agents/skills/fastapi-api-design/SKILL.md` |
| Schema, persistence, database evidence | `.agents/skills/postgres-patterns/SKILL.md`; `.agents/skills/supabase-postgres-best-practices/SKILL.md` |
| Supabase products or integration | `.agents/skills/supabase/SKILL.md` |
| Infrastructure/tooling setup | `.agents/skills/project-tooling/SKILL.md` |
| Live browser checks (browser); test authoring (implement) | `.agents/skills/playwright-e2e-testing/SKILL.md` |
| Security decisions and review | `.agents/skills/webapp-security-review/SKILL.md` |
| Behavior changes and regression-test design | `.agents/skills/tdd-workflow/SKILL.md` |
| Meaningful completion verification | `.agents/skills/verification-loop/SKILL.md` |

- For assigned UI visual-quality/accessibility review, add the available personal `frontend-design-review` skill. Plugin/personal skills complement project guidance only when relevant; do not load artifact skills for unrelated coding.
- A prescribed-check utility assignment does not authorize test-strategy selection. Browser assignments specify target, workflow, expected results, permitted interactions, and required evidence; unknown causes return to the parent.
- MCPs/plugins are inherited capabilities, not authorization. Use Context7 for unresolved library facts, project PostgreSQL for authorized evidence, and available browser tools for assigned live checks. If a skill expects an unavailable Supabase MCP, report it and use the configured CLI or database path only when sufficient and authorized; do not install a substitute automatically.

- Give workers objective, ownership, constraints, dependencies, acceptance criteria, expected evidence, skill paths, and stopping condition; require reading/reporting applicable skills.
- Workers share the checkout: preserve others' edits, parallelize only independent disjoint writes, serialize conflicts, and return to parent without further delegation (`[agents] enabled = false`).
- Inspect every worker diff/result, reconcile findings, and retest fixes. Continue incomplete workers with the precise remaining objective; do not restart discovery or equate unfinished work with a defect.
- Keep small task state in conversation; substantial multi-step work/handoffs use the protocol's Markdown run record in ignored `.agent-runtime/`. Record evidence as work happens and checkpoint before pausing; no runtime JSON schema required.
- Change persistent memory, create goals, or schedule continuations only when requested. OpenCode goal/VibeGuard hooks and turn limits are not migrated Codex enforcement.
- Context7/Playwright inherit global MCP settings (manage through Desktop Settings when available); PostgreSQL stays in project `.codex/config.toml`. Add no filesystem/sequential-thinking/memory MCP without demonstrated need.
- After local agent setup changes, run backend `uv run python ../scripts/agent-task.py doctor`; it checks workflow assets/configuration, not application acceptance or approval enforcement.
- Do not claim background scheduling, automatic retries, per-worker cost tracing, or isolated worktrees unless actually used and verified; follow the protocol for manual maintenance reviews.
