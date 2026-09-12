# Testing Architecture

> **Scope:** Test ownership, execution layers, section selection, and CI gates.
> **Audience:** Developers deciding where and how to verify a change.
> **Related documents:** [Backend architecture](04-backend-architecture.md), [Frontend architecture](05-frontend-architecture.md), [Security](14-security-architecture.md), [Deployment](12-deployment-architecture.md)

## Mandatory execution order

1. Define the changed behavior, affected sections, and smallest proving layer.
   For behavior changes, follow the TDD skill's focused red/green rules.
2. Run focused tests without coverage during edits. On failure, fix and rerun
   the failing cases, then their feature batch. Finish each batch before moving
   to the next; expected rejection/error paths must be passing assertions.
3. Run affected integration checks as batches stabilize. Bring these forward
   for auth, schema, shared configuration, or framework changes; do not defer
   boundary failures until push preparation.
4. Only when preparing to push, after all affected batches pass, run the
   affected projects' full static, build, test, and coverage gates below,
   plus required infrastructure/full-stack
   checks. Local selection never waives CI or release gates.
5. If a pre-push gate fails, return to focused debugging, then rerun that gate.
   Retain other passing results only when their source, tests, dependencies,
   configuration, and relevant shared boundaries remain unchanged.

| Area           | Smallest required proof during iteration                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backend        | Isolated behavior/API tests; guarded real PostgreSQL for persistence, privileges, transactions, migrations, or concurrency                             |
| Frontend       | Isolated rules, HTTP routes, or browser interactions according to the changed behavior; mobile/browser variants when relevant                          |
| Infrastructure | Affected configuration validation, image/build checks, startup/readiness, and service contracts; real full stack when the changed boundary requires it |

No unexpected failures, skipped required tests, weakened assertions, or retries
used to conceal flakes are acceptable. Missing required services block acceptance.
Full suites are not edit, commit, or routine-handoff requirements. Report them
as deferred until push preparation, never as passed. Keep coverage off routine
edit loops; pre-push overall and changed-line gates remain
90%. Never combine stale captures from different code or environment states.

Reuse warm setup only when the runner supports isolation and per-test cleanup;
never bypass disposable-database guards. Parallel runs need separate ports,
outputs, and mutable data; choose concurrency from measured resource use.
Pre-push disposable-stack gates use fresh environments. Local batch commands
below support owned backend setup reuse and explicit frontend browser selection.

## Sections and ownership

Tests are grouped by the behavior they protect. Each case has one home;
changes spanning multiple sections select those sections together.

| Backend section | Responsibility                                                                         |
| --------------- | -------------------------------------------------------------------------------------- |
| `security`      | JWT verification, eligibility, capabilities, users, invitations, and Supabase adapters |
| `audit`         | Request attribution, snapshots, listeners, listing, and SecurityEvent behavior         |
| `api`           | Domain validation, lifecycle, relationships, HTTP contracts, and shared listing        |
| `runtime`       | Health, readiness, request/database bounds, diagnostics, and recovery                  |
| `database`      | Migration transitions, catalog privileges, and disposable-database guards              |
| `scripts`       | Bootstrap, provisioning, seeding, reset safety, and test-harness checks                |

Backend tests live in capability folders under `backend/tests/`:

| Behavior                    | Folders                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| Authentication and accounts | `auth/`, `users/`, `rbac/`                                                     |
| Catalog and records         | `catalog/`, `listing/`, `record_queries/`, `views/`                            |
| Lifecycle and relationships | `lifecycle/`, `lifecycle_integration/`, `relationships_integration/`           |
| Audit and diagnostics       | `audit/`, `security_events/`, `runtime/`                                       |
| Workspace and files         | `workspace/`, `files/`                                                         |
| Setup and database safety   | `operations/`, `reset_application_data/`, `migration_0015/`, `migration_0016/` |

Feature-specific helpers live beside their tests. Shared configuration and API
helpers, root `conftest.py`, and runner entry points stay at the test root.
Descriptive filenames remain selectable through the section mapping in `scripts/test.py`.
Section membership does not determine whether a test needs PostgreSQL: the
`integration` marker supplies that boundary across all sections.

Frontend sections are `public`, `security`, `shell`, `administration`, `audit`,
`catalog`, `files`, `records`, `sandbox`, and `runtime`. Files live under
`frontend/tests/<layer>/<section>/`. Shared transport/data fixtures belong under
`tests/helpers/` or `tests/browser/helpers/`; helpers are not separate journeys.
Upload-library rules live in `isolated/files/`, and record-query rules in
`isolated/records/`; `isolated/catalog/` owns field-schema rules.

## Execution layers

| Layer                 | What runs                                                                                     | Requirements                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Backend `isolated`    | Schemas, services, mocked dependencies, and in-process HTTP contracts; excludes `integration` | Python dependencies                                                            |
| Backend `integration` | Actual database constraints, transactions, locks, RLS, migrations, and recovery               | Guarded disposable PostgreSQL at current Alembic head                          |
| Frontend `isolated`   | Pure rules and handlers with replaced I/O                                                     | Node dependencies; no Next.js server or live credentials                       |
| Frontend `http`       | Requests to actual Next.js session/BFF routes                                                 | Next.js server; runs once per case                                             |
| Frontend `browser`    | User interactions, rendering, accessibility, and failure states                               | Next.js plus browser; Chromium/mobile locally, additional Firefox/WebKit in CI |
| Disposable full stack | Browser sessions through Next.js, FastAPI, Supabase Auth, and PostgreSQL                      | Dedicated temporary Supabase stack and generated identities                    |

Playwright runs the frontend layers; no additional unit-test runner is needed.
`TEST_LAYER=isolated` omits application startup. Ordinary domain browser tests
mock session/BFF responses, so their results establish UI behavior rather than
backend or database correctness. HTTP tests have an actual HTTP boundary but
need not invoke a provider. Real domain persistence is checked by a concise
disposable browser journey covering schema creation, acceptance, record editing,
and relationship linking/unlinking. Detailed rules stay in the backend/API and
focused UI suites.

Scanner UI coverage has a dedicated `npm run test:scanner:coverage` command.
It runs the focused Chromium file journeys with Next development source maps,
collects V8 coverage and enforces 90% across the five scanner UI files. The
converter rejects absent/stale maps, incomplete navigation fragments and empty
measurements, and counts emitted source lines. An optional baseline directory
produces a changed-line report. This measurement is separate from production
build/browser acceptance; it does not enable production source maps.

`backend/tests/scanner_runtime.py` supports the disposable full-stack runner's
real ClamAV engine and serial worker. Official definition updates, clean and
harmless antivirus detection fixtures, private container settings and exact-byte
download are distinct evidence from mocked scanner unit tests. PostgreSQL tests
exercise durable claims, requester revocation, retries, quota locks and operator
acknowledgement. None of these tests provisions a hosted deployment.

Backend tests use pytest. Direct router-function tests verify function behavior;
registered-route tests additionally verify dependency wiring, serialization,
and HTTP error contracts. PostgreSQL tests remain necessary where mocks cannot
prove privileges, rollback, migration transitions, or concurrency.

## Section, affected, and full commands

From the repository root:

```sh
python3 scripts/test.py backend section security --layer isolated
python3 scripts/test.py backend section audit runtime --layer isolated
python3 scripts/test.py backend section runtime --layer integration --interactive
python3 scripts/test.py backend affected --layer isolated
python3 scripts/test.py backend full
```

From `frontend/`:

```sh
npm run test:section -- security --layer isolated
npm run test:section -- audit --layer browser
npm run test:section -- public --layer browser --browser mobile-chromium --match "entry point"
npm run test:affected -- --layer isolated
npm run test:full
```

`--list` previews selected files without executing tests or starting services.
`affected` includes staged, unstaged, deleted, and untracked files. Add
`--base <git-ref>` to also include committed branch changes since the merge
base with that ref. With no base and a clean working tree, no tests are selected.

Affected selection uses a small explicit dependency map: for example, field
validation selects catalog/record consumers, and backend account changes select
security, audit, and API checks. Shared helpers, configuration, migrations, and
unrecognized application code select the broader project suite. This is a
local iteration aid, not exhaustive import-graph analysis or a replacement for
CI. No matching tests in a requested section/layer is reported explicitly.

Section/affected runs stop at the first failure and accept `--match` (pytest
name expression or Playwright title regex). Backend isolated batches disable
coverage. Backend `integration` and `all` batches start their own guarded
disposable stack, apply migrations, and run only selected tests without coverage;
required skips fail. Add `--interactive` to keep that stack between batches:
Enter reruns the selection, test paths/node IDs select another batch, and `quit`
or EOF cleans up. The layer and name filter remain fixed for the session.
Failed selections must pass a rerun before the session can exit successfully.
Schema, runtime configuration, or dependency edits require a fresh session.
Per-test cleanup remains mandatory; this never reuses the developer database.

For one exact backend file or case, run from `backend/`:

```sh
uv run python -m tests.fullstack_runner --backend-batch --interactive tests/runtime/test_database_integration.py
```

Batch timing/results live in `backend/test-results/batches/`; batches neither
collect coverage nor overwrite existing coverage reports. Earlier coverage is
not fresh evidence after code changes. The full backend `all` command retains
its configured 90% gate but needs the documented disposable environment;
use the pre-push coverage command below for complete PostgreSQL acceptance.

Frontend section/affected batches run Chromium once by default, with isolated
and HTTP projects included when their layers are selected. Use
`--browser mobile-chromium` for mobile checks or `--browser all` for the configured
matrix. `full` rejects local name/browser/interactive filters and preserves the
full matrix; coverage and CI commands retain their existing gates.

Frontend `all` includes isolated, HTTP, and browser checks. It excludes real
full-stack journeys. Use `npm run test:e2e:fullstack` for the disposable
release path. `npm run verify` retains formatting, lint, type checking, build, and
ordinary production-server tests.

## Pre-push coverage gates

Run the full gate only when preparing to push. Record the comparison revision
before implementation, then run `python3 scripts/prepush.py --base <revision>`
from the repository root. The fail-closed classifier selects the applicable
backend, frontend, container, and full-stack lanes. `--list` prints the plan
without starting a service. Lower-level project commands remain available for
focused repair but are not repeated after the canonical gate passes.
Both projects require 90% overall executable production-line coverage and 90%
changed executable-line coverage. No changed executable production lines is
reported as N/A, never as a measured 100%.

Backend coverage includes all `app/` source, with operational-script coverage
reported separately. Frontend coverage combines Chromium, isolated Node tests,
and Next server execution using development source maps. Local coverage uses a
bounded worker count. CI creates one revision/source/test plan, runs three
deterministic shards, rejects an incomplete or mixed union, and enforces coverage
once after merging compact line reports. A fixed source-line
inventory includes never-loaded `src/` modules with zero hits; type-only and
non-executable lines do not count. Static import/re-export declarations and Next
boundary directives have no independent runtime statement; executable expressions
sharing their source line remain counted. Dependency side effects are measured
in the in-scope dependency source. This does not enable production source maps or replace
production browser acceptance. The scanner subset retains its gate.

`scripts/check_coverage.py` applies both thresholds to source-mapped reports and
the recorded Git comparison, including new untracked production files. Missing
source, invalid comparison references, stale captures, and required runtime
omissions fail measurement. CI uses the pull request merge base or previous push
revision. Reports and source/run metadata live in ignored test-result folders.
The backend and frontend coverage lanes receive the verified comparison base.
A manual full-stack workflow dispatch retains its `coverage_base` input for
explicit change classification rather than guessing a base.

## Fixtures and maintenance

Generate credential values at runtime and reuse each generated value within its
assertions. Keep actual local environment files, test artifacts, logs, and
coverage reports outside version control. Real full-stack identities are created
only in the disposable stack. Auth-flow traces, screenshots, and video are
disabled in the full-stack configuration.

PostgreSQL fixtures require the generated run identity, explicit mutation flag,
private credential manifest, and exact disposable database destination before
connecting, then validate Alembic head. Required coverage runs reject skips. Tests
that commit track owned entities and clean up only those entities. Migration
fixtures exercise transitions with rollback; they do not authorize resetting a
shared developer database. The disposable runner uses separate ports and a
fresh project rather than personal identities or the existing local stack.

Consolidate duplicate cases at the lowest layer that proves the behavior. Keep
representative HTTP/browser checks for wiring across boundaries. A source-text
assertion can be removed when an executable test covers its guarantee; final
catalog state alone does not prove safe migration transitions or downgrade
behavior. Backend handwritten files remain limited to 500 lines by
`backend/AGENTS.md`.

## CI and remaining boundaries

Backend quality, disposable coverage, and container builds run as independent
jobs behind one stable aggregator. Frontend quality and production-image browser
acceptance run independently from the three-shard coverage plan/merge pipeline.
Successful frontend coverage keeps compact reports instead of raw V8 captures.
The separate full-stack workflow starts its own stack and production applications
with `--acceptance-only`; it retains five real-stack scenarios but does not repeat
the backend regression suite. Only sanitized acceptance diagnostics are retained.

The full-stack workflow uses internal relevant-change detection and a stable
check name. Repository branch protection must require that check separately;
it is not controlled by these source files. Local affected selection does not
weaken any CI gate.

These checks do not establish hosted network/TLS controls, aggregate ingress
limits, alert delivery, backup/restore readiness, or provider-wide session
revocation. Realtime Broadcast delivery and missing Next.js SecurityEvent
producers remain separate coverage boundaries. Unimplemented report workflows
have no implemented acceptance contract yet.

Sources: `scripts/test.py`, `backend/pyproject.toml`, `backend/tests/`,
`frontend/playwright*.config.ts`, `frontend/tests/`, `.github/workflows/`.
