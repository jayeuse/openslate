# Testing Architecture

> **Scope:** Automated verification layers, fixtures, CI execution, and evidenced coverage gaps.
> **Audience:** Developers deciding where and how to verify a change.
> **Related documents:** [Backend architecture](04-backend-architecture.md), [Frontend architecture](05-frontend-architecture.md), [Deployment](12-deployment-architecture.md), [Architecture risks](20-architecture-risks.md), [Dynamic-field validation test plan](../dynamic-field-validation-test-plan.md)

## Test layers

| Layer                           | State                                      | What it verifies                                                                                                                                  |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend unit/API tests          | **Implemented**                            | Schemas, request context, auth seams, list behavior, domain routes/services, audit snapshots/listeners, lifecycle and relationships, plus expanded dynamic field/record validation. |
| PostgreSQL integration tests    | **Implemented but environment-gated**      | Real constraints, transactions, JSONB persistence, audit behavior, list behavior, relationships, lifecycle, deterministic NOWAIT races, runtime-role trust boundaries, and migration contracts when `TEST_DATABASE_URL` is set. |
| Migration drift/contract tests  | **Implemented**                            | Alembic head, revision SQL/contracts—including decimal migration 0015—and model-to-schema drift in CI.                                           |
| Frontend browser tests          | **Implemented, mostly mocked integration** | Public pages plus dynamic-field schema/record, relationship, and lifecycle UI behavior through mocked session/BFF routes; these tests are not backend/DB integration. |
| Frontend unit/component tests   | **Absent**                                 | No Vitest/Jest/component-test framework is configured.                                                                                            |
| Live full-stack browser tests   | **Implemented, opt-in/local-only**         | Separate live Playwright specs exercise the browser→Next/BFF→FastAPI→PostgreSQL path with real local Auth and manifest-scoped cleanup; excluded from the default suite and CI, and not a Realtime-delivery test. |
| Security/performance/load tests | **Absent**                                 | No dedicated automated suites are checked in.                                                                                                     |

## Backend verification

`backend/pyproject.toml` configures pytest with coverage over `app`, an 80% failure threshold, and an `integration` marker. `backend/tests/conftest.py` supplies shared seams and guards PostgreSQL integration use.

Test modules cover:

- health and request context;
- Supabase JWT and admin adapters;
- auth/user invitation and user routes;
- departments/modules, fields/records, relationships;
- expanded field/record unit and API validation, with the shared
  `contracts/record-field-validation-cases.json` fixture consumed by the
  split field/record suites (`backend/tests/test_fields.py`,
  `backend/tests/test_records.py`, `backend/tests/test_fields_api_contract.py`,
  and `backend/tests/test_record_validation.py`) and
  `frontend/tests/field-schema.spec.ts`;
- real PostgreSQL dynamic-field validation in
  `backend/tests/test_dynamic_field_database_integration.py`,
  `backend/tests/test_dynamic_field_persistence_integration.py`, and
  `backend/tests/test_dynamic_field_concurrency_integration.py`, including
  JSONB normalization, runtime-role direct-SQL trust characterization, schema
  acceptance, and deterministic field uniqueness contention;
- relationship PostgreSQL coverage in
  `backend/tests/test_relationships_api.py`,
  `backend/tests/test_relationships_http_integration.py`,
  `backend/tests/test_relationships_races_integration.py`, and
  `backend/tests/relationships_integration/test_concurrency.py`,
  `backend/tests/relationships_integration/test_lifecycle.py`,
  `backend/tests/relationships_integration/test_migration.py`, and
  `backend/tests/relationships_integration/test_mutations.py`,
  including deterministic contention (`503` then committed-state `409`);
- standard list schemas/query/API/integration;
- audit context, snapshots, listeners, service, API, integration;
- lifecycle security, routes, service, integration, and registered API expiry checks in
  `backend/tests/test_lifecycle_expiry_api_integration.py` (including pending and
  already-`expired` stored challenge states, with no password-provider call);
- migration contracts for Supabase cutover, relationships, schema acceptance,
  decimal migration 0015, and lifecycle revisions.
- registered RBAC route tests in `backend/tests/rbac/`, including the role,
  user, invitation, lifecycle-capability, and authentication seams;
- migration 0015/0016 contracts in `backend/tests/migration_0015/` and
  `backend/tests/migration_0016/`, plus security-event API/model tests in
  `backend/tests/security_events/`;
- reset utility contracts in `backend/tests/reset_application_data/` and
  API seeding contracts in `backend/tests/test_seed_sample_data.py`. The
  seeding tests verify contiguous zero-based field positions and acceptance
  of each populated module before records are created;
- field-impact API integration in `backend/tests/test_field_impact_integration.py`
  exercises 1,001 records across the fixed 250-row streaming boundary.

The dynamic-field and relationship integration fixtures track their committed
departments, modules, fields, records, relationships, and audit entities by
UUID. Cleanup releases the test transaction and deletes only those UUIDs
through a guarded owner-capable connection, preferring
`MIGRATION_DATABASE_URL` and falling back to an owner-capable
`TEST_DATABASE_URL`; it does not perform a table-wide reset. Reset utility
tests use dry-run and rollback-protected execution paths and do not authorize
a committed database reset.

The backend CI workflow starts local Supabase, verifies public signup is blocked, applies Alembic, runs `alembic check`, provisions a disposable runtime role, and sets `TEST_DATABASE_URL` before Ruff, mypy, and pytest. This is the authoritative integration path.

The following dynamic-field validation results are a historical baseline recorded on 2026-08-31, before the current backend refactor:

| Check | Result |
| --- | --- |
| Focused field/record/module/relationship tests | **116 passed** |
| Runtime-role PostgreSQL integration tests | **33 passed** |
| Owner-role PostgreSQL integration tests | **27 passed** |
| Full backend pytest | **382 passed, 2 skipped, 82.08% coverage** |
| Ruff | **Passed** |
| mypy | **Passed** |
| Alembic | **Passed**; no new upgrade operations |

The exact commands, PostgreSQL role split, and environment-isolation note are recorded in the [dynamic-field validation test plan](../dynamic-field-validation-test-plan.md).

### Current backend-refactor verification status

The final evidence below was completed on 2026-09-09. The default runtime suite skips the two owner-only reset checks because they require the owner connection and baseline fixture; those checks were run separately with rollback protection.

| Evidence | Status |
| --- | --- |
| User-account PostgreSQL verification | **14 passed** |
| Invitation transaction PostgreSQL verification | **11 passed** |
| Field PostgreSQL verification | **16 passed** |
| Registered relationship HTTP/PostgreSQL verification | **7 passed** |
| Independent relationship/lifecycle race verification | **4 passed** |
| Registered seed/lifecycle/expired-challenge API scenarios | **9 passed**; includes one seed scenario, six lifecycle scenarios, and pending/`expired` challenge cases with no password-provider call |
| Existing focused PostgreSQL domain regression | **30 passed; focused existing regression only, not the final registered-route/API gate** |
| Loopback API smoke test against an owned FastAPI process with real local Auth and cleanup | **1 passed** |
| Architecture and security static reviews | **Closed; no additional finding** |
| Handwritten Python size guard | **207 files scanned; zero over 500 lines; largest file 499 lines** |
| Final test collection | **673 collected; baseline 573** |
| Final full backend pytest suite | **671 passed, 2 owner-reset skips; separate owner rollback run passed 2/2, covering all 673 collected cases** |
| Python 3.12, 3.13, and 3.14 compatibility checks | **Each 565 passed, 1 skipped; the existing database-dependent skip remains separately identified** |
| Owner rollback-only reset verification | **2 passed; teardown verified baseline counts, admin/role/Auth snapshots, plan digest, and fixture-ID absence after physical rollback; PostgreSQL rollback itself restores the data, and no reset was committed** |
| Ruff and strict mypy | **Passed; mypy checked 103 source files** |
| Combined application and six changed-script coverage | **87.41%** |
| Changed executable coverage | **83.29% (1,775/2,131 lines; threshold at least 80%)** |
| Alembic drift check | **Passed; no new upgrade operations** |

Frontend pagination and stale-request findings remain deferred pending separate
approval. The provider resend-contract concern remains unverified and is not a
confirmed defect; no provider redesign is included in this verification.

### Isolated Python compatibility checks

Run the non-integration backend suite in a disposable uv environment for each supported interpreter. Run this snippet from the repository root in Bash or Zsh; it uses shell arrays and is not a POSIX `sh` script. This is a local verification command only; it does not change CI configuration or the shared project environment.

```sh
temp_envs=()
cleanup() {
  for env_dir in "${temp_envs[@]}"; do
    rm -rf "$env_dir"
  done
}
trap cleanup EXIT

for py in 3.12 3.13 3.14; do
  env_dir="$(mktemp -d "/tmp/openslate-python-${py}-XXXXXX")"
  temp_envs+=("$env_dir")
  UV_PROJECT_ENVIRONMENT="$env_dir" \
    UV_CACHE_DIR=/tmp/openslate-workflow-uv-cache \
    uv sync --locked --project backend --python "$py"
  UV_PROJECT_ENVIRONMENT="$env_dir" \
    UV_CACHE_DIR=/tmp/openslate-workflow-uv-cache \
    uv run --project backend pytest -m "not integration" --no-cov
done
```

An interpreter or dependency-resolution failure is a blocked compatibility check and must be recorded as such; it must not be reported as a passing test run.

### Handwritten Python size guard

`backend/tests/test_python_file_size.py` scans handwritten `*.py` files under
`backend/app`, `backend/scripts`, and `backend/tests`, excluding generated
environments, caches, and migrations, and fails any file over 500 lines. Run
the focused guard from `backend/` with:

```sh
UV_CACHE_DIR=/tmp/openslate-workflow-uv-cache uv run pytest --no-cov tests/test_python_file_size.py
```

The focused size guard passes; final suite, rollback-only reset, coverage, and
Alembic evidence are recorded above.

## Frontend verification

Playwright configuration runs against a development server locally and a standalone production server in CI. Local projects include Chromium/mobile; CI installs and runs Chromium, Firefox, and WebKit. Failure artifacts and the HTML report are uploaded by `.github/workflows/frontend.yml`.

Current default specs include:

- `home.spec.ts`: landing/setup/login/invited-account password setup and one home-page axe scan;
- `field-schema.spec.ts`, `date-time.spec.ts`, and `record-form-invalidation.spec.ts`: dynamic schema parity, date/time behavior, record serialization, and invalidation handling;
- `request-security.spec.ts`: BFF/request security behavior;
- `relationships.spec.ts`: schema acceptance, field/cardinality behavior, record editing, linking/unlinking, and hidden/incoming relationships;
- `lifecycle.spec.ts`: closed-entity presentation, ordering, close/reopen confirmation UI, and hidden relationship behavior.

Opt-in specifications under `frontend/tests/live/` cover local platform foundation, schema seeding, relationship integrity, and teardown/support behavior.

Default domain tests mock `/session/status`, `/session/realtime-token`, and `/bff/**`. They verify frontend behavior against fixtures, not the deployed cross-system contract. The separate local-only live suite uses real local Auth and backend calls; it is deliberately excluded from `npm run verify` and CI.

## CI gates

```mermaid
flowchart LR
    PR[Pull request or main push] --> B[Backend workflow]
    PR --> F[Frontend workflow]
    B --> BI[Supabase + Alembic + role]
    BI --> BC[Ruff + mypy + pytest]
    F --> FC[format + lint + typecheck + build]
    FC --> FE[Playwright production server]
```

Backend and frontend workflows use path filters and cancel superseded runs. They verify changes but do not publish images or deploy.

## Known coverage gaps

- Real invitation email through callback/password setup and cookie persistence; session-handler, cookie, same-origin, BFF refresh, AppPage redirect, and successful Realtime paths lack code-level tests.
- BFF refresh/retry against actual Supabase Auth and backend JWT validation.
- Browser-to-Realtime authorization and invalidation delivery.
- Administration users/roles/audit UI, workspace/onboarding correctness, appearance persistence, pagination, and protected-page accessibility.
- Concurrent last-administrator mutations and additional multi-connection scenarios beyond the covered field/relationship races.
- Request-size/rate-limit behavior, hosted TLS/network policy, backup/restore, and disaster recovery.
- Storage, reports, views, and file workflows because those capabilities are not implemented.

## Choosing a test location

- Put pure schema/service/listener behavior in backend unit tests.
- Use PostgreSQL integration tests for constraints, locks, RLS, migrations, concurrency, rollback, and audit transaction guarantees.
- Use Playwright fixture tests for isolated UI state and rendering.
- Run the opt-in live Playwright suite only when the complete local platform, backend, and frontend are running; it complements rather than replaces code-level tests.

Sources: `backend/pyproject.toml`, `backend/tests/`, `frontend/playwright.config.ts`, `frontend/tests/`, `.github/workflows/`.
