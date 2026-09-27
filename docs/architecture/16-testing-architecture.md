# Testing Architecture

> **Scope:** Test boundaries, repository gates, and acceptance evidence that must remain distinct.

## Backend and provider tests

The [`fullstack_runner.py`](../../backend/tests/fullstack_runner.py) starts a runner-
owned, isolated Supabase Compose stack with fresh per-run database and provider
credentials, private ports, Auth/Storage fixtures, and Mailpit. The runner provisions
application roles, applies and checks Alembic migrations, creates private Storage
buckets, and tears down only the resources it owns. `backend/tests/postgres_runtime.py`
retains a compatibility import surface; the disposable provider implementation is in
`backend/tests/supabase_runtime.py`. Database guarantees are not replaced by SQLite or
by a developer's persistent Supabase project.

Focused pytest cases support repair; the owning backend gate runs the complete
disposable backend suite. Separate runner modes include `--backend-coverage-only`,
`--scanner-only`, `--acceptance-only`, and `--browser-only`. From `backend/`, `uv run
python -m tests.fullstack_runner --acceptance-only` exercises the isolated provider,
scanner, FastAPI, Caddy gateway, and browser flow under `ENVIRONMENT=test`; that is
local gateway evidence, not public TLS or customer-host acceptance. The root
[`prepush.py`](../../scripts/prepush.py) plan and [backend
workflow](../../.github/workflows/backend.yml) retain Ruff, mypy, backup contract tests,
tooling tests, and backend coverage as separate checks. Backend coverage must be at
least 90% overall and at least 90% on changed executable lines, with coverage for the
complete application source inventory. Do not lower thresholds or omit source files to
accommodate a change.

The committed Auth/Storage reset acceptance has its own mandatory
`--reset-acceptance-only` invocation after ordinary backend coverage in both gates.
This mode creates a new disposable stack and selects one fixed, noninteractive
acceptance target. The target is outside ordinary pytest filename discovery because
the reset CLI commits installation-wide cleanup. Public batch target validation and
the application's coverage thresholds remain unchanged; a missing, empty, skipped,
or failing reset acceptance cannot pass the dedicated gate.

Provider acceptance should cover identity binding, revoked-session rejection, invitation
and recovery links, application authorization, denied provider-key access to application
tables, private Storage transfers, integrity checks, scanner failure, and
cleanup/reconciliation. These journeys use only an isolated disposable stack and test
identities. Provider container health alone does not establish application readiness or
prove a user journey. Database-backed tests require the runner-owned target and its
ownership manifest; direct persistent-database fixtures and SQLite substitutions are
outside the supported test boundary.

## Frontend and integrated checks

The frontend CI workflow ([`frontend.yml`](../../.github/workflows/frontend.yml)) runs
`npm run check`, `npm test`, and `npm run build`. Browser tests and targeted API route-
contract tests have their configured ownership and setup. FastAPI HTTP coverage remains
the proof for static-site delivery, API/static path separation, cache policy, and
response security headers; a static export is not browser-interaction evidence. The
unified server-image build verifies packaging, not deployment or production operation.
The canonical change-selected local gate is `python3 scripts/prepush.py --base <base-
ref>` from the repository root. CI verifies and builds; it does not publish or deploy a
customer installation.

The backend runner may build the static frontend for integrated journeys. Browser
workflows use dedicated runner-created identities and isolated services. Preserve
traceable procedures and artifacts for executed E2E acceptance, including command,
working directory, revision, prerequisites, outcome, and report/trace locations;
architecture docs do not record task-run counts or results.

## Acceptance boundaries

Compose validation, unit tests, and migrations alone do not establish clean-host
installation, reboot persistence, physical restore, TLS/ingress, or Windows behavior.
A guarded isolated production Compose rehearsal exercised a real five-volume encrypted
backup and restore, TLS trust, authorization and file access, and service restart using
Linux containers on macOS Docker Desktop. Native Linux host installation and post-reboot
recovery remain unaccepted. Windows Docker Desktop/WSL2 startup, reboot, persistent-volume
recovery, scanner, and restore checks remain pending because no Windows acceptance host is
available. macOS is a development workstation only, not a supported server target.

`/api/ready` reports Database, Auth, Storage, SMTP configuration, and scanner states.
Acceptance must exercise provider outages, missing mail configuration, required versus
optional scanners, engine and worker absence, and caller deadlines without spawning
replacement work. Production readiness still requires live acceptance; its response
does not establish mail delivery, schema compatibility, or backup integrity. Supabase
Realtime is not started; its future use needs its own authorization and acceptance design.
Documentation-only edits require diff and link review, not application test execution.
See [Deployment Architecture](12-deployment-architecture.md) for the current release and
restore limits.
