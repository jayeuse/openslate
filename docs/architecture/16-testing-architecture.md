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

Focused pytest cases support repair; the owning backend gate combines the complete
stack-free unit and disposable integration coverage. Separate runner modes include `--backend-coverage-only`,
`--acceptance-only`, and `--browser-only`. From `backend/`, `uv run
python -m tests.fullstack_runner --acceptance-only` exercises the isolated provider,
FastAPI, Caddy gateway, and browser flow under `ENVIRONMENT=test`; that is
local gateway evidence, not public TLS or customer-host acceptance. The root
[`prepush.py`](../../scripts/prepush.py) plan and [backend
workflow](../../.github/workflows/backend.yml) retain Ruff, mypy, backup contract tests,
tooling tests, and backend coverage as separate checks. Backend coverage must be at
least 90% overall and at least 90% on changed executable lines, with coverage for the
complete application source inventory. Do not lower thresholds or omit source files to
accommodate a change.

The actual client-address [integration proof](../../backend/tests/workspace/test_workspace_security_proxy.py)
requires a native Caddy executable on `PATH`, available IPv6 loopback, and its
owned test listen ports. [`caddy_runtime.py`](../../backend/tests/caddy_runtime.py)
refuses Docker fallback for that IPv6 peer proof. The backend CI coverage shards
are configured to extract the executable from the pinned test Caddy image and add
it to `PATH`; configuration does not establish hosted CI execution or native
deployment acceptance.

CI runs the stack-free tests (`not integration`) in a separate unit job with four
workers. Five integration-only jobs each run `--backend-coverage-shard N/5` on their
own disposable stack. Neither the unit lane nor an individual shard applies the
coverage thresholds. The `coverage-gate` job combines the unit lane and all five
shards, sums their test counts, and applies the 90% overall and changed-line gates
to the complete report. A missing or duplicate lane/shard, a skipped test, or
evidence from a different source tree fails the gate. The commands and combine
guards live in [`backend_coverage.py`](../../backend/tests/backend_coverage.py).
`pytest-split` balances the integration shards with
`backend/tests/.test_durations`. Each CI run uploads fresh durations in the
`backend-coverage` artifact; commit that file again when a shard takes much longer than
the others. Locally, a shard uses the last combined run's durations
(`backend/test-results/coverage/test-durations.json`) when they are newer than the
committed file, so new tests stop falling back to the average. Local `prepush.py`
runs [`tests.parallel_coverage`](../../backend/tests/parallel_coverage.py): first
the stack-free unit lane with six workers, then three integration-only shards on
their own disposable stacks at the same time, then the same combine step and gates. Each
shard writes to its own folder under `backend/test-results/coverage-shards/`. Each test
stack gets its own `/24` in `10.199.0.0/16`, outside Docker's default address pools, under
a short cross-process allocation lock, so parallel stacks never exhaust those pools. Test
stacks run PostgreSQL without crash durability (`fsync`, `synchronous_commit`, and
`full_page_writes` off) and memoize repeated `docker inspect` answers inside one pytest
process; the per-test guard still checks the connected database identity every time.
That check and the rolled-back test session use one pooled engine per database URL per
pytest process (`backend/tests/database_pool.py`) instead of three new connections per
test. Each connection runs `DISCARD ALL` when it returns to the pool, so the next test
starts from a clean session; a test that must be the database's only consumer disposes
the pools first. Alembic heads are read once per process.
Backend-only stacks (coverage, its shards, and batches) point Auth's email templates at
their own host port, `29000` plus the stack's network block, which is unique per live
stack and below the ephemeral and Kubernetes NodePort ranges. Full-stack and smoke runs
keep port `8008`, where the runner's API serves the templates. The local default
is three integration stacks; do not reduce stack or worker counts without a
measured resource failure. The runner's lower-concurrency controls retain the
same coverage gates.

The committed Auth/Storage reset acceptance has its own mandatory
`--reset-acceptance-only` invocation in both gates. Local `prepush.py` runs it after
ordinary backend coverage; CI runs it as a separate job. This is provider-reset
acceptance, not the full-stack/browser `--acceptance-only` mode. Local pre-push
must use `python3 scripts/prepush.py --base <base-ref> --serial`: frontend and
backend resource lanes run one after another, while each lane keeps its own
parallelism. Never start another heavy suite or build beside an active lane.
When selected, the server image builds after the frontend tests in the frontend
lane. Run the gate only right before a push, not after each edit or handoff.
Ctrl-C, SIGTERM, or SIGHUP stops every
running lane so its runner tears down its stacks; `tests.parallel_coverage` passes the
stop to each shard once and waits for its teardown (bounded, then killed). A lane that
breaks, or a planned step that never ran, fails the gate.
This mode creates a new disposable stack and selects one fixed, noninteractive
acceptance target. The target is outside ordinary pytest filename discovery because
the reset CLI commits installation-wide cleanup. Public batch target validation and
the application's coverage thresholds remain unchanged; a missing, empty, skipped,
or failing reset acceptance cannot pass the dedicated gate.

Provider acceptance should cover identity binding, revoked-session rejection, invitation
and recovery links, application authorization, denied provider-key access to application
tables, private Storage transfers, file-type validation, integrity checks, and
cleanup/reconciliation. These journeys use only an isolated disposable stack and test
identities. Provider container health alone does not establish application readiness or
prove a user journey. Database-backed tests require the runner-owned target and its
ownership manifest; direct persistent-database fixtures and SQLite substitutions are
outside the supported test boundary.

## Frontend and integrated checks

The frontend uses Playwright Test for both `isolated` rules/adapters/state tests
and `http` browser journeys with a mocked `/api`. The isolated project starts no
shared HTTP server; its development-ingress spec exercises an owned Next fixture.
Default HTTP journeys use `frontend/out/` through the test-only ASGI entry over
production `StaticSite`
([`static_export_server.py`](../../backend/tests/static_export_server.py)), not
the FastAPI application or a live Supabase stack. This entry serves production
static routing, cache policy and CSP, but deliberately answers unmocked `/api`
requests with 500; it is not application API or full middleware acceptance.
[`playwright.config.ts`](../../frontend/playwright.config.ts) refuses missing or
stale exports, so build with `npm run build` before HTTP tests. For local debugging,
`PLAYWRIGHT_HTTP_SERVER=dev` opts the same HTTP project into `next dev`; it is not
a separate project or the daily development workflow. Daily `npm run dev` remains
the Next origin proxying `/api` to the local FastAPI process.

The frontend CI workflow ([`frontend.yml`](../../.github/workflows/frontend.yml))
runs `npm run check`, `npm run build`, and the isolated job independently. Six
duration-balanced, whole-file HTTP shards wait for and download that one static
export. [`playwright_shards.py`](../../scripts/playwright_shards.py) uses current
native collection for membership and committed duration weights for assignment;
the shards run `--project=http --workers=2 --test-list=<selected-file>` with the
lockfile-pinned Chromium browser. The isolated CI job uses the configured default
of one worker; local Playwright uses up to three workers. UTC, `en-US` and zero
retries are pinned in the config. Failure contexts/traces and native JSON reports
have their own artifact paths; the `verify` job preserves one required check
(`frontend-verify`; the backend workflow has `backend-verify`).
[`package.json`](../../frontend/package.json) declares `check` (formatting, lint,
types, contrast), `build`, `test`, and `verify` (`check` → `build` → `test`), plus
the existing section/affected/full selectors for scoped work. Full verification
belongs to the pre-push gate, not routine edits.

FastAPI HTTP coverage remains the proof for application static-site delivery,
API/static path separation and response security headers. Mocked HTTP browser
journeys do not establish live API authorization or provider behavior. The unified
server-image build verifies packaging, not deployment or production operation.
The canonical change-selected local gate is `python3 scripts/prepush.py --base
<base-ref> --serial` from the repository root. CI configuration declares checks;
it is not evidence of current-tip local/CI parity, hosted execution or deployment.

The backend runner may build the static frontend for integrated journeys. Browser
workflows use dedicated runner-created identities and isolated services. Preserve
traceable procedures and artifacts for executed E2E acceptance, including command,
working directory, revision, prerequisites, outcome, and report/trace locations;
architecture docs do not record task-run counts or results.

## Release smoke suite

The release smoke suite runs one main path per screen against seeded Harbor data. It
belongs to the release gate, not to every push. Run it before a release:

1. From the repository root, run `python3 scripts/prepush.py --base <base-ref> --serial --release`.
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
  The runner then restarts the API without it, so the browser tests run with every limit on.

Playwright signs in once per role (administrator, department lead, service clerk, guest)
and saves each session as a `storageState` file.
The tests in `frontend/tests/fullstack/smoke/` read and edit the seeded data and build no
fixtures. Credentials and saved sessions stay in the private run directory.

Each test carries a feature tag (`@records`, `@boards`, `@access`, `@manage`, `@platform`,
`@sandbox`). `frontend/test-results/smoke-summary.json` records the result, the time of
each stage, the revision, and each test's status, place, title, and duration. It keeps no
credentials; the private run directory is removed after a passing run. A full run takes about eight minutes. Seeding Harbor Small through the seeder takes
about 6.5 minutes of sequential API calls, and the browser suite takes under a minute.

## Test output

Test runs are quiet by default. Drawing a line for each of about 3,000 tests in the
desktop app's terminal slowed the whole machine, so speed comes first:

- The backend runners (`tests.fullstack_runner`, `tests.parallel_coverage`,
  `tests.smoke_runner`) show stage names and the final result. Set
  `OPENSLATE_TEST_PROGRESS=1` to also show one line per finished test (progress, outcome,
  test ID). Parallel coverage puts the shard name in front of each line, for example
  `[2/3]`. The full output stays in the private run log, because it can contain stack
  credentials.
- The frontend suite uses the Playwright `line` reporter.
- The full-stack acceptance and smoke suites run headless. Set `OPENSLATE_E2E_HEADED=1` to
  watch them in a visible browser; CI always runs them headless. Add `--headed` to
  `npm test` to watch the `http` project.

The runners turn SIGTERM and SIGHUP into an interrupt, and they stop each command's whole
process group before they remove the disposable stack, so a stopped run leaves
nothing behind.

## Acceptance boundaries

Compose validation, unit tests, and migrations alone do not establish clean-host
installation, reboot persistence, physical restore, TLS/ingress, or Windows behavior.
A guarded isolated production Compose rehearsal exercised a real five-volume encrypted
backup and restore, TLS trust, authorization and file access, and service restart using
Linux containers on macOS Docker Desktop. Native Linux host installation and post-reboot
recovery remain unaccepted. Windows Docker Desktop/WSL2 startup, reboot, persistent-volume
recovery, and restore checks remain pending because no Windows acceptance host is
available. macOS is a development workstation only, not a supported server target.

`/api/ready` reports Database, Auth, Storage, and SMTP configuration states.
Acceptance must exercise provider outages, missing mail configuration, and caller
deadlines without spawning replacement work. Production readiness still requires live acceptance; its response
does not establish mail delivery, schema compatibility, or backup integrity. Supabase
Realtime is not started; its future use needs its own authorization and acceptance design.
Documentation-only edits require diff and link review, not application test execution.
See [Deployment Architecture](12-deployment-architecture.md) for the current release and
restore limits.
