# Repository Guide

## Priority

When two rules conflict, the first match in this list wins:

1. The latest user message.
2. Rule zero, the testing rules, and the security rules in this file. They override scoped guides, skills, and worker plans. `SECURITY.md` wins over its restatement here.
3. The nearest `AGENTS.md`, inside its folder. Read it before subdirectory work. Read other scoped guides only when you cross their boundaries.
4. The rest of this file.
5. Skills and their generic examples.

Correct: "A scoped guide says to run the gate before a push; the root testing rules say CI owns it; followed the root rule."
Wrong: "The nearest guide takes priority, so ran the 45-minute gate before the push."

## Rule zero: never run backend and frontend tests at the same time

Read and apply this before any other instruction, every time a task runs tests.

- **One heavy test side at a time.** Never run backend tests (pytest batches, coverage, shards, fullstack, smoke) while frontend tests (Playwright isolated or HTTP, the frontend build) run, or the reverse. Together they run 2–3 times slower on the 4-performance-core development machine and fail timing-sensitive tests at random.
- **Keep parallelism inside each side.** Backend coverage runs `tests.parallel_coverage --shards 3`; the frontend suite keeps its Playwright workers. Do not drop to `--coverage-stacks 1` or a single worker without a measured failure.
- **The full local gate always runs with `--serial`:** `python3 scripts/prepush.py --base <base-ref> --serial`. It runs the lanes one after the other and keeps each lane's parallelism.
- **Start nothing else beside a running heavy lane:** no focused tests, batches, or sample runs "to use the time".
- **Free the machine before the gate or a full suite:**
  1. Stop dev servers and processes you started (`npm run dev`, `uv run python -m app`, preview servers, sample runs, idle agent clients).
  2. Stop the owned development Supabase stack with `python3 scripts/dev.py stop` (never `docker compose down -v`; its volumes hold the data).
  3. Stop other running development containers (other projects' Compose stacks) with `docker stop`; tell the user which ones. Never remove them or their volumes.
  4. Check headroom (`uptime` load near or below the core count); report a busy machine instead of starting the gate.
  5. After the gate, restart the owned development stack (`python3 scripts/dev.py db`) and anything the user was using.

Correct: "Stopped the dev Supabase stack, the Next dev server and `four-week-microservice-dev-*`; load 4; ran the gate with `--serial`; restarted the dev stack."
Wrong: "Started the gate with the dev stack and two dev servers running; the Playwright lane took 40 minutes at load 110."
Wrong: "While backend coverage ran, repeated three Playwright tests to check flakes."

## Testing rules

These rules are the one source for when tests run. Scoped guides own only their runners and thresholds. See [Testing Architecture](docs/architecture/16-testing-architecture.md) for runner details.

- **Batch by work unit, never by edit or handoff.** Use focused tests for TDD or debugging; run one relevant batch when the work stabilizes. Reuse passing evidence, including worker results, until the relevant code or setup changes.
- **Push with fast checks; CI runs the heavy suites.** CI on the pull request (`backend.yml`, `frontend.yml`) runs every check of `scripts/prepush.py`. Before a push, run only:
  - the fast checks for the changed side: frontend `npm run check`; backend `uv run ruff check . ../scripts ../tests/tooling ../packaging/backup` and `uv run mypy app operations`; `python3 scripts/assertion_guard.py --base <base-ref>` when tests changed;
  - the focused tests and one batch for the changed files and their direct callers (`scripts/run_tests.py ... --match`, or the frontend specs that the change touches).
- **Keep full suites off the local machine.** Do not run `scripts/prepush.py`, the full backend coverage gate, the full Playwright suite, fullstack or reset acceptance, or the smoke suite locally, unless the user asks or CI is unavailable.
- **CI decides completion.** After the push, read the CI result. Reproduce a CI failure with the focused test, fix it, and push again. Work is done and a pull request is ready to merge only when CI is green.
- **When the local gate runs,** it runs each full suite once, under rule zero. Use `--list` to inspect its change classification without running checks. Choose worker and stack counts from measurements and record actual runtimes; elapsed time alone does not reject a complete passing run. Preserve hang and deadline protections, required scenarios, isolation, and cleanup guards.
- **Fix failures narrowly.** Rerun the failing case and affected batch, then only the failed gate. Never weaken assertions or use blind retries. Use isolated PostgreSQL for database guarantees and preserve runner guards.
- **Repair commands:** backend `uv run ruff check .`, `uv run mypy app operations`, and `COVERAGE_BASE_REF=<base-ref> uv run python -m tests.fullstack_runner --backend-coverage-only`; frontend `npm run verify`. Do not rerun them after a passing gate unless a failure invalidates that evidence.
- **Honor explicit test skips:** stop active runs, start no replacements, and report omitted checks.
- **Documentation-only edits need no tests.**
- **Clean up disposables after a successful push.** Remove only what this work created: runner-owned stacks (Compose projects `slateops-e2e-*` with their containers, volumes, and networks), test processes and dev servers you started, and scratch files. Check ownership by Compose label and creation time.
- **Keep what future work uses:** the owned development stack (`slateops-supabase-local-*`) and its volumes, `.env`, installed dependencies, browsers, Docker images, `.agent-runtime/` records, and the summaries under `backend/test-results/` and `frontend/test-results/`.

Correct: "Changed `files/service.py`; ruff, mypy and the `tests/files` integration batch pass; pushed; CI coverage green."
Wrong: "Finished a review fix; ran the 45-minute prepush to be safe before pushing."
Correct: "Push succeeded; removed three `slateops-e2e-<run>` stacks created by this gate; kept the dev stack and test summaries."
Wrong: "Push succeeded; ran `docker system prune -a --volumes`."

## Task scope and approval

- Before editing, define outcome, non-goals, expected files, and narrowest proof; inspect relevant implementation, tests, configuration, and instructions. Record the base revision.
- Use the requested CLI/SSH/API access path; use UI automation only when that path is unavailable or UI operation is requested.
- Fix the root cause, reuse helpers/patterns/tests, remove replaced code unless compatibility is requested, and recheck the problem. Avoid speculative abstractions, compatibility layers, future schemas/options/services, and unrelated cleanup; abstract only for a current requirement or second real caller.
- Prefer existing libraries/components; needed dependencies may be installed without separate approval, but keep them relevant and verify integration.
- If adding an abstraction layer, configuration surface, roughly more than five files, or a speculative option, stop and reduce the design first.
- Read-only discovery needs no approval. Obtain approval for scope expansion, unrelated files, new services, unrequested public API/schema/storage/wire-format changes, data deletion, overwriting user work, discarding uncommitted changes, or rewriting Git history; preserve unrelated edits.
- Review the final diff for correctness and scope, and remove task-created scratch code. Report actual results and blockers; deferred, skipped, or unavailable checks are unverified, never passed.

## Security reporting and review rules

`SECURITY.md` is the security policy. Its section [Reference for automated tools](SECURITY.md#reference-for-automated-tools) holds rules SEC-R1 to SEC-R8 and the controls that reviews protect. Read that section before you report, review, or test anything security-related. The rules below restate the blocking ones; `SECURITY.md` wins if they differ.

- SEC-R1: Never put details of an unfixed vulnerability in code on `main` in a public issue, PR title/body/comment, commit message, branch name, code comment, or discussion. A problem only in a pull request's unmerged changes may be described in that pull request's review.
- SEC-R2: Submit a vulnerability report only when the user tells you to, and only through GitHub private vulnerability reporting.
- SEC-R3: Never read, print, copy, or send secret values (`.env`, `.env*.local`, provider and application env files, backup repositories and their passwords, export passphrases, `docker compose config` output without `--quiet`). Variable names are fine.
- SEC-R5: Check the Out of scope table and the design decisions in `docs/architecture/` before you report. A finding that needs `ENVIRONMENT=development` with a loopback bind host is not a vulnerability.
- SEC-R6: In code review, mark as P1 any change that weakens a control in the "Controls that reviews protect" table, unless the change states why.
- SEC-R8: Never send traffic to an installation other than a local stack that the user runs.

Correct: "Possible authorization bypass in `<path>:<line>` at `<commit SHA>`; drafted private advisory text for the user to submit."
Wrong: "Opened issue #<n>: '<route> skips the access check, here is the exploit.'"

## Setup and commands

- Require Python `>=3.12,<3.15` and Node `>=24`; `.node-version` pins the version for development and CI. Use `backend/uv.lock` and `frontend/package-lock.json`.
- Run Python/uv/Alembic in `backend/` and npm/Playwright in `frontend/`. Root owns orchestration and documentation.
- Command ownership: root `scripts/` is repository automation, `backend/operations/` is operator commands, and `frontend/tooling/` is npm-owned launch plumbing. Add no other product directory named `scripts`.
- Setup and daily commands: read the Local development section of `README.md`. Operator contracts and release gaps: read `infra/supabase/README.md` and `infra/supabase/PLAN.md`.
- Never reset provider volumes with `docker compose down -v`; they hold the installation database, Auth state, and Storage bytes. Application-data reset is a separate guarded operation. Backup and restore follow `infra/supabase/RESTORE.md`.

## System boundaries

These boundaries hold across the repository. Read `docs/architecture/README.md` for the detail, and cite the numbered document when you explain architecture.

- **Runtime:** local development uses one owned Supabase Compose instance per worktree, with FastAPI and Next.js on the host. Next proxies `/api` to loopback FastAPI in development only. Production has one FastAPI upstream serving the static Next export, with no Node.js process; Caddy is for production and explicit production-level acceptance.
- **Transport:** `ENVIRONMENT=development` with a loopback bind relaxes local transport controls. `ENVIRONMENT=test` and production-level runs keep strict origin, host, header, body, concurrency, and rate-limit checks (`docs/architecture/14-security-architecture.md`).
- **Deployment:** one Docker Compose stack per client on Linux or Windows Docker Desktop with WSL2/Linux containers. macOS is for development only (`infra/AGENTS.md`).
- **Database:** Supabase Database is PostgreSQL. `DATABASE_BOOTSTRAP_URL` is the operator-only `supabase_admin` connection, `MIGRATION_DATABASE_URL` is Alembic's `slateops_owner`, and `DATABASE_URL` is the constrained `slateops_runtime`. Never substitute SQLite or expose bootstrap credentials to application processes. Alembic owns only the application schema; Supabase owns its Auth and Storage schemas.
- **Identity:** Supabase Auth authenticates email identities and handles invitations and recovery. FastAPI binds provider subjects to local profiles and owns authorization and revocable sessions. Browsers use HttpOnly cookies plus CSRF protection; CLI clients use bearer tokens (`docs/architecture/08-authentication-authorization.md`).
- **Authorization:** one installation holds several organizations, and a request binds one. Every decision goes through `backend/app/systems/access/policy/scope.py`; RLS on `slateops.org_id` is a backstop. An admin manages only their organization, a guest is capped at `read`, no access row means no access, and an unreadable module is hidden (404).
- **Files:** private bytes live in Supabase Storage and pass through FastAPI, which validates type and enforces access on download. There is no antivirus scan and no local filesystem storage adapter (`docs/architecture/06-data-architecture.md`).
- **Events:** Supabase Realtime carries private Comms events. Other pages use authenticated SSE with opaque PostgreSQL `LISTEN`/`NOTIFY` invalidations, never row snapshots.
- **Mutations:** use `AuditSession` and individual ORM changes, never bulk or raw ORM mutations. Audit covers application ORM mutations only.
- **Secrets:** treat connection strings and credentials as secrets. Provider keys and connection strings stay out of browser code, tracked files, and reports.

## Skills

Selection is by area: read the repository-wide skills that fit the work and the skills of each scope you work in. Do not wait for anyone to name them. Skill paths are `.agents/skills/<name>/SKILL.md`, resolved from root; workers must read and report the paths themselves. Documentation- and formatting-only work does not need SDD or TDD.

Repository-wide:

- Scope and acceptance criteria: `sdd-workflow`. Use it at the start of every feature, bug fix, refactor, behavior change, or architecture decision, then hand the criteria to `tdd-workflow`.
- Test design: `tdd-workflow`. Use it before you create or change tests, change behavior, fix a bug, or refactor.
- Verification: `verification-loop`. Use it after a meaningful change and before a push or pull request.
- Security: `webapp-security-review`. Use it when a change touches authentication, sessions, authorization, user input, uploads, file access, SSE, secrets, rate limits, logging, webhooks, or dependencies, and for a threat model or security review.
- Repository tooling: `project-tooling`. Use it for manifests, lockfiles, tool configuration, environment examples, and setup steps, and for changes under `scripts/`, `tests/tooling/`, and `.github/workflows/`.

Areas (each scoped guide lists the skills its folder adds):

- Frontend: `frontend/AGENTS.md`. UI/UX: read `DESIGN-RULES.md` for the skills and their order.
- Backend: `backend/AGENTS.md`.
- Schema and migrations: `backend/migrations/AGENTS.md`.
- Infrastructure: `infra/AGENTS.md`.
- Documentation: `docs/AGENTS.md`.

Correct: "Changed a form under `frontend/src/components/`; read `react-frontend-patterns` from `frontend/AGENTS.md` and reported its path."
Wrong: "The assignment named no skill, so read none."

## Orchestration

- For implementation, troubleshooting, multi-agent work, or explicit evaluation, read `.agents/orchestration/PROTOCOL.md`. It owns the work loop, the assignment contract, ownership, and run records. If it is missing, report that and follow this guide without claiming full setup.
- The active delegation policy sets the workers and roles. Inherit model, effort, fallback, and approval settings from the active configuration.
- Handle small tasks directly; delegate substantial bounded work when it improves quality or time. Planning-only requests produce investigation and a plan, not implementation.
- MCPs and plugins are inherited capabilities, not authorization. Use Context7 for unresolved library facts. If a skill expects an unavailable database MCP, report it and use the configured CLI path only when sufficient and authorized. Add no MCP without demonstrated need.
- Change persistent memory, create goals, or schedule continuations only when requested. Do not claim background scheduling, automatic retries, per-worker cost tracing, or isolated worktrees unless actually used and verified.
- After local agent setup changes, run `uv run python ../scripts/agent-task.py doctor` from `backend/`. It checks workflow assets and configuration, not application acceptance.
