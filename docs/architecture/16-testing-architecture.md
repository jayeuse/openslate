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

CI splits the backend suite into five parallel jobs. Each job runs `--backend-coverage-shard
N/5` on its own disposable stack. A shard checks that its tests pass and that the source
did not change, but it does not apply the coverage thresholds. The `coverage-gate` job
combines the five coverage data files, sums the test counts, and then applies the same
90% gates to the complete report. A missing shard, a skipped test, or a shard from a
different source tree fails the gate. `pytest-split` balances the shards with
`backend/tests/.test_durations`. Each CI run uploads fresh durations in the
`backend-coverage` artifact; commit that file again when a shard takes much longer than
the others. Local `prepush.py` runs `python -m tests.parallel_coverage`: three shards on
their own disposable stacks at the same time, then the same combine step and gates. Each
shard writes to its own folder under `backend/test-results/coverage-shards/`. Each shard
stack creates six Docker networks, and Docker Desktop's default address pools hold about
30, so three shards fit beside the development stack. A shard that fails at PostgreSQL
startup with "all predefined address pools have been fully subnetted" means networks from
another stack still exist; `docker network ls` shows them. The single
`--backend-coverage-only` run stays available for repair.

The committed Auth/Storage reset acceptance has its own mandatory
`--reset-acceptance-only` invocation in both gates. Local `prepush.py` runs it after
ordinary backend coverage; CI runs it as a parallel job.
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
`npm run check`, `npm run build`, and `npm test` as parallel jobs. The isolated project
runs as one test job. The `http` project runs as six Playwright shards
(`--project=http --shard=N/6`), and each shard starts its own dev server. The `verify` job
keeps one required check for all of them. Browser tests and targeted API route-
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

## Release smoke suite

The release smoke suite runs one main path per screen against seeded Harbor data. It
belongs to the release gate, not to every push. Run it before a release:

1. From the repository root, run `python3 scripts/prepush.py --base <base-ref> --release`.
   The `--release` flag adds the `release-smoke` step after the backend stacks.
2. To run only the smoke suite, run `uv run python -m tests.smoke_runner` from `backend/`.

The runner creates a new disposable stack and builds the static export. FastAPI serves
the export behind the Caddy gateway, as in production; `next dev` is not used. The runner
seeds Harbor Small once through the sample-data seeder (seed 42, anchor date 2026-09-30).
The seeder trusts the gateway's local certificate authority, because the test environment
sends `Secure` session cookies. Two switches exist only for a test stack, and the API refuses
to start with either one outside `ENVIRONMENT=test`:

- `E2E_BACKGROUND_WORKERS=true` runs the automation and scheduling workers, as production
  does. Other test runs drive these workers directly.
- `E2E_SEEDING_WITHOUT_ANONYMOUS_LIMITS=true` turns off the anonymous invitation limit
  (5 completions per 15 minutes from one address) while the seeder completes every invitation.
  The runner then restarts the API without it, so the browser tests run with every limit on. Playwright signs in once per role (administrator,
department lead, service clerk, guest) and saves each session as a `storageState` file.
The tests in `frontend/tests/fullstack/smoke/` read and edit the seeded data and build no
fixtures. Credentials and saved sessions stay in the private run directory.

Each test carries a feature tag (`@records`, `@boards`, `@access`, `@manage`, `@platform`,
`@sandbox`). `frontend/test-results/smoke-summary.json` records the result and the time of
each stage. A full run takes about eight minutes. Seeding Harbor Small through the seeder takes
about 6.5 minutes of sequential API calls, and the browser suite takes under a minute.

## Acceptance boundaries
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
