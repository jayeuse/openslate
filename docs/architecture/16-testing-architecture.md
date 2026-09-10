# Testing Architecture

> **Scope:** Test ownership, execution layers, section selection, and CI gates.
> **Audience:** Developers deciding where and how to verify a change.
> **Related documents:** [Backend architecture](04-backend-architecture.md), [Frontend architecture](05-frontend-architecture.md), [Security](14-security-architecture.md), [Deployment](12-deployment-architecture.md)

## Sections and ownership

Tests are grouped by the behavior they protect. Each case has one home;
changes spanning multiple sections select those sections together.

| Backend section | Responsibility |
| --- | --- |
| `security` | JWT verification, eligibility, capabilities, users, invitations, and Supabase adapters |
| `audit` | Request attribution, snapshots, listeners, listing, and SecurityEvent behavior |
| `api` | Domain validation, lifecycle, relationships, HTTP contracts, and shared listing |
| `runtime` | Health, readiness, request/database bounds, diagnostics, and recovery |
| `database` | Migration transitions, catalog privileges, and disposable-database guards |
| `scripts` | Bootstrap, provisioning, seeding, reset safety, and test-harness checks |

Backend runtime tests live in `backend/tests/runtime/`; audit/request-context
checks live in `backend/tests/audit/`. Existing capability suites and descriptive
filenames remain selectable through the section mapping in `scripts/test.py`.
Section membership does not determine whether a test needs PostgreSQL: the
`integration` marker supplies that boundary across all sections.

Frontend sections are `public`, `security`, `shell`, `administration`, `audit`,
`catalog`, `records`, `sandbox`, and `runtime`. Files live under
`frontend/tests/<layer>/<section>/`. Shared transport/data fixtures belong under
`tests/helpers/` or `tests/browser/helpers/`; helpers are not separate journeys.

## Execution layers

| Layer | What runs | Requirements |
| --- | --- | --- |
| Backend `isolated` | Schemas, services, mocked dependencies, and in-process HTTP contracts; excludes `integration` | Python dependencies |
| Backend `integration` | Actual database constraints, transactions, locks, RLS, migrations, and recovery | Guarded disposable PostgreSQL at current Alembic head |
| Frontend `isolated` | Pure rules and handlers with replaced I/O | Node dependencies; no Next.js server or live credentials |
| Frontend `http` | Requests to actual Next.js session/BFF routes | Next.js server; runs once per case |
| Frontend `browser` | User interactions, rendering, accessibility, and failure states | Next.js plus browser; Chromium/mobile locally, additional Firefox/WebKit in CI |
| Disposable full stack | Browser sessions through Next.js, FastAPI, Supabase Auth, and PostgreSQL | Dedicated temporary Supabase stack and generated identities |

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
python3 scripts/test.py backend affected --layer isolated
python3 scripts/test.py backend full
```

From `frontend/`:

```sh
npm run test:section -- security --layer isolated
npm run test:section -- audit --layer browser
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

Section/affected backend runs disable the whole-application coverage threshold,
which is unsuitable for a narrow slice. The full backend `all` run retains the
configured 80% gate. `--layer integration` selects database tests; `all` includes
both layers. Without `TEST_DATABASE_URL`, database cases are skipped and the run
does not establish database correctness.

Frontend `all` includes isolated, HTTP, and browser checks. It excludes real
full-stack journeys. Use `npm run test:e2e:fullstack` for the disposable
release path. `npm run verify` retains formatting, lint, type checking, build, and
ordinary production-server tests.

## Fixtures and maintenance

Generate credential values at runtime and reuse each generated value within its
assertions. Keep actual local environment files, test artifacts, logs, and
coverage reports outside version control. Real full-stack identities are created
only in the disposable stack. Auth-flow traces, screenshots, and video are
disabled in the full-stack configuration.

PostgreSQL fixtures validate the destination and Alembic head before use. Tests
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

The backend workflow starts disposable Supabase, checks blocked public signup,
applies migrations, runs Alembic drift detection, provisions the runtime role,
and executes tooling checks plus pytest with PostgreSQL and coverage. The
frontend workflow runs static/build checks and the ordinary test layers. The
separate full-stack workflow starts its own stack and production applications;
only sanitized acceptance diagnostics are retained.

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
