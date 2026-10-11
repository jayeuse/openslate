# Tier 2.5: test suite refactor plan

Status: phase 0 and phase 1 complete on 2026-10-11 (items 14, 15, 18). Phase 2 is in progress.

This plan refactors every test suite in the repository and the CI that runs them: backend pytest, frontend Playwright (`isolated`, `http`, `fullstack`, smoke), the pre-push gate, and the GitHub workflows. The plan has three goals: less bloat, less duplicated setup, and shorter run times. Protection must stay the same or improve.

Item numbers are stable identifiers. Skills and configuration files refer to them (for example "item 1", "item 4", "item 10"). Do not renumber the items. The phases in section 5 give the order of work.

## 1. Non-negotiable rules

These rules apply to every change under this plan. A change that breaks one of them does not merge.

1. Do not weaken an assertion. Do not replace an exact matcher with a loose one (`toBeTruthy`, `toBeDefined`, `in`, a wider regex). Do not remove an expected value, a status check, or a negative check.
2. Do not make a test pass with a proxy solution. Do not raise a timeout, add a retry, add a sleep, add `test.skip`, `test.fixme`, `xfail`, `noqa`, or `eslint-disable`, or update a snapshot with `-u` without reading the diff.
3. Do not bypass an error. A failure is a product bug, a test bug, or an environment difference. Find which one, then fix that cause.
4. Remove a test only with the evidence in `.agents/skills/tdd-workflow/references/consolidation.md` (rules D1 to D6). Keep each removal in its own commit, apart from any fix.
5. Report test lines and test counts, but never treat them as a target.
6. Obey root rule zero: run only one heavy test lane at a time on the development machine.

Correct: "The Dashboard cadence test failed with real timers. It now uses `page.clock`. All assertions stay; 10 of 10 runs pass."
Wrong: "The Dashboard cadence test was slow, so its timeout went from 5 s to 30 s."

Correct: "Removed 9 validation cases from `openview-views-api.spec.ts`. The ledger names `tests/isolated/openview/view-validation.spec.ts` as the owner of each case."
Wrong: "Removed redundant cases; the suite is still green."

Item 14 makes rules 1, 2, and 4 a machine check, not only a written rule.

## 2. Baseline (measured 2026-10-10)

| Item | Value |
|---|---|
| Test code | 246k lines. Product code is 250k lines. |
| Backend | 5,099 tests in 580 files. Summed duration 2,667 s. The lane alone takes 16 min 50 s locally on 3 stack shards. CI runs 5 shards of 7 to 8 min; each shard boots a stack in about 84 s. |
| Frontend | 2,190 tests: 1,503 `http`, 687 `isolated` (5 s). CI runs 12 `http` shards of 4.5 to 6.8 min with 1 worker each. The frontend lane was never measured alone, and no per-test durations exist (item 15). |
| Full stack and smoke | 11 `fullstack` specs, not in the push gate. The release smoke suite takes about 8 min, and seeding Harbor Small takes 6.5 min of that. |
| Backend cost centers | `operations/sample/controls`: 806 s for 931 tests. 53 fault-matrix tests with 10 or more cases: 734 s. Two provider token-expiry tests: 91 s. Tests that need no database: about 47% of backend time (file-level estimate). |
| Frontend duplication | Route mocks are 15.3k lines (19% of `http`). 75 copies of the session mock. About 230 titles with slice IDs. About 70 design-review capture calls. 384 hand-written UUID literals. |
| Open suspects | 5 `test.skip`, 1 `test.fixme`, 5 `test.setTimeout` from 90 s to 360 s, 1 `waitForTimeout`, real sleeps in 6 backend files. |

Two earlier assumptions were wrong:

- The `[large]` and `[standard]` sample sizes cost only 66 s. The cost is setup that each case repeats.
- Public repositories get 4 vCPU runners, not 2. The worker and shard counts stay the same until item 2 measures them.

### Clean baseline (item 15, measured 2026-10-11)

Each lane ran alone on commit `d0f241f9` (the same tests as `main` at `37c404be`). The owned development stack was running (about 850 MiB).

| Lane | Result | Wall time |
|---|---|---|
| Frontend, `next dev`, 3 workers | 2,197 passed, 5 skipped, 0 failed | 20.8 min (3,649 worker-seconds in `http`, 8 s in `isolated`) |
| Backend, 3 stack shards | 5,107 passed, 0 skipped, 0 failed; 93.56% coverage | 13.2 min |
| CI on `37c404be` | Backend run 8.7 min, Frontend run 7.1 min | 116 runner-minutes |

The earlier 47.8 min frontend time and its 7 failures came from a run that overlapped the backend lane. Per-test durations are in `frontend/test-results/baseline/frontend-durations.json` and `backend/test-results/baseline-backend-durations.json` (local evidence, not committed).

The slowest frontend files are `sandbox-relationship-mappings` (432 worker-seconds), `openview-views-api` (408), `openview-dashboards` (249), `boards-live-widgets` (157), and `openview-reports` (142). The slowest test is a Kanban test at 35 s.

## 3. Setup that is already in place

| Area | Change |
|---|---|
| Skills | `tdd-workflow` (admission rules, consolidation rules D1 to D6, case matrix as a menu), `verification-loop` (parity checks, flaky-test classification, rule zero), `playwright-e2e-testing` (shared fixtures and mocks, `page.clock`, ARIA snapshots, behavior titles). These files are in `.agents/`, which Git ignores. |
| Guides | `frontend/AGENTS.md` puts each behavior at the lowest faithful layer. `backend/AGENTS.md` treats 500 lines as a review signal for test files and allows shared test helpers. |
| Backend guards | Ruff `PT` rules are on, including `PT011` and `PT012` since item 10. |
| Frontend guards | `eslint-plugin-playwright` with 15 rules that have no current violations. |
| Mutation testing | `mutmut`, configured in `backend/pyproject.toml`. It is not part of the push gate. |
| Parity | Node 26 from `.node-version` for local, CI, and the server image. uv 0.12.x in CI. Playwright pins `timezoneId` and `locale`, and keeps a trace for each failure on both sides. |

## 4. Items

### Speed and infrastructure

- **1. Browser tests on the static export.** Run the `http` project against the `next build` output (`out/`), not `next dev`.
   - Result (2026-10-11): done; export is the default. Under the export the suite exposed two production bugs that `next dev` hid (the Sandbox canvas styles blocked by the production CSP, and an OpenView refusal that lost its denial during Retry), both fixed, plus test defects (inline `<style>` injection, a shadowed event-stream mock, transient URL reads), fixed without removing assertions. No spec needs `next dev`, so there is no `http-dev` project. Local wall time with 3 workers: 20.8 min (dev) to about 15 min (export).
   - Server: a test-only ASGI entry under `backend/tests/` that mounts `app/core/static_site.py` `StaticSite` and nothing else. It gives the same routing and CSP as production from one source. Fall back to a Node server in `frontend/tooling/` only if the uv setup in each CI shard costs more time than it saves; record the numbers.
   - An unmocked `/api` request must fail the test with a clear message. Add a final catch-all route in the base fixture.
   - Remove `tests/warm-routes.ts` and the dev-overlay workarounds when the move is complete.
   - Keep a small `http-dev` project on `next dev` only for specs that prove Strict Mode behavior. List them by name.
   - Classify each new failure as a product bug, a test bug, or an environment difference (prefetch, single mount, CSP). Fix that cause. Rules 1 to 3 apply: a longer timeout or a looser wait is not a fix.
   - Measure one shard with 1, 2, 3, and 4 workers in both modes. Metric: wall time, failures (must be 0), memory.
- **2. Worker and shard counts.** Use the item 1 results. Choose the last worker count where throughput rises by 20% or more with no failures. Set CI workers per shard and the shard count for 4 vCPU runners. Metric: CI wall time, runner minutes, local wall time.
   - Local result (2026-10-11): 3 workers stay. On the 4 performance cores, 4 workers took 15.6 min and 6 workers 20.9 min for the same suite. CI starts at 6 shards with 2 workers each, to be measured on the first CI run. Four tests fail only under load; they are being fixed at the cause (item 17).
- **3. A backend lane with no stack.** First confirm, from fixture use, which tests need no database (the `_guard_direct_database_tests` hook in `backend/tests/conftest.py` is the selector). Run those tests in a lane with `pytest-xdist` (`-n 4 --dist worksteal`). Run the lane once in random order (`pytest-randomly`) before you trust it. Then reduce the stack shards. Metric: backend wall time and memory.
   - Result (2026-10-11): done. 3,035 of 5,111 tests run without a stack (247 s on 6 local workers, with coverage); the three stack shards run only `integration` tests (about 440 s each). Six tests had random UUIDs in their IDs and 14 needed the stack without the `integration` mark; both are fixed. Local wall time is unchanged (811 s against 793 s), because the lanes run one after the other to keep timing-sensitive integration tests off a saturated machine; the gain is a stack-free loop for most tests and a parallel CI job.
- **6. Cheaper fault matrices.** Profile one case of `test_sandbox_controls_use_ui_shapes_and_recreate_exact_test_vectors` (minimum 2.3 s per case). Build sample datasets once per module and copy them per case. Share the happy-path prefix and inject each fault at its step. Keep every case and every assertion. Metric: `operations/sample/controls` time, from 806 s.
   - Profile (2026-10-11): one case takes about 1.1 s of real work after imports, spread over 458 mocked requests (JSON encoding, wire tree copies, random seeding); there is no single hot spot. Sharing the publish prefix needs a snapshot of a stateful mock wire, which risks the fidelity of 51 cases for about 75 s. Deferred behind item 3, which moves these tests out of the stack shards and runs them in parallel without changing them.
- **7. One token-expiry wait.** Merge the two 45 s provider token-expiry waits into one window, or find the minimum `JWT_EXPIRY` that the provider accepts. Keep a real expiry; do not mock the clock in these acceptance tests. Metric: about 45 s less.
   - Result (2026-10-11): closed without a change. The test stacks set `JWT_EXPIRY=45` on purpose (`backend/tests/supabase_runtime.py`); a shorter lifetime can expire tokens inside other long integration tests and start refresh flows that are not under test. Merging the two waits couples two independent acceptance scenarios. The two waits cost 91 s of 2,667 s and already run on different shards.
- **11. Subprocess coverage.** Do one measuring run with `patch = ["subprocess"]`. The file-validation worker runs in a child process and is possibly not measured. Keep the setting if the numbers are correct. Metric: `validation_worker.py` coverage is real.
   - Result (2026-10-11): closed without a change. `validation_child.py` (16 lines) shows 0% because the worker starts it with a scrubbed environment (`PATH` and `PYTHONNOUSERSITE` only), which is the production isolation for untrusted files. `patch = ["subprocess"]` cannot reach a process that does not inherit the coverage settings; passing them through would loosen that isolation for a metric. The child's behavior is asserted through the worker tests (`tests/files/test_validation.py`).
- **12. Balanced shards.** After item 2, balance Playwright shards by duration (blob reports and `--test-list`, or `@flakiness/playwright`). Commit backend durations from the CI combine step. Metric: slowest shard minus fastest shard.
- **22. Disposable stack startup.** Start only the Supabase services that the tests use (check whether Studio, Meta, and imgproxy are needed). Turn off PostgreSQL durability (`fsync`, `synchronous_commit`, `full_page_writes`) on disposable `openslate-e2e-*` stacks only, never on the development or production stack. Metric: stack boot time (84 s in CI), memory per stack.
   - Result (2026-10-11): closed. Durability is already off on disposable stacks (the test overlay in `backend/tests/supabase_runtime.py` sets `fsync`, `synchronous_commit`, and `full_page_writes` to off). The services cannot be trimmed without changing the stack topology: the API gateway waits on Studio (and Studio on Meta), and Storage waits on REST and imgproxy.

### Evidence and guardrails

- **4. Unique coverage per test.** Add an option to the backend batch runner that records per-test coverage contexts (serial, `COVERAGE_CORE=ctrace`, `--cov-branch`). Add a report that lists, for each test, the lines that only it covers. Metric: tests with zero unique lines, per area.
- **5. Mutation baseline.** Run `mutmut` on one pure module first. Then record the score of each module before its tests change. Metric: score per module; no new surviving mutant after consolidation.
   - Pilot (2026-10-11): `uv run mutmut run "app.systems.sandbox.designs.validation.*"` from `backend/` took about 3 minutes and scored 589 killed, 169 survived, 28 not checked (77.7%). Mutation runs use only tests that need no stack, and leave out `tests/operations` and the email-template route tests, which read files outside the `backend/mutants` copy (`[tool.mutmut]` in `backend/pyproject.toml`). A module whose owner tests need the database has no mutation score; use item 4 for it.
- **14. Assertion ledger and forbidden-pattern check.** Add a script in root `scripts/` with unit tests in `tests/tooling/` (the same pattern as `ci_scope.py`). It compares the base and the head of a change:
    - **Ledger.** It counts removed assertions per file (`assert`, `pytest.raises`, `expect(`, `toHave*`, `toBe*`, `toMatch*`). Each removed assertion must appear in a ledger file in the change, with the test that now owns it. A removed assertion without an owner fails the check.
    - **Forbidden patterns.** It fails on new `test.skip`, `test.fixme`, `xfail`, `skipif`, `retries`, a raised `timeout` or `test.setTimeout`, a new `waitForTimeout` or sleep, a new `noqa` or `eslint-disable`, a matcher that becomes looser, and a snapshot file that changes in the same commit as the test that reads it.
    - Run it in the pre-push gate and in CI for every change that touches test files.
- **18. Behavior map format.** The frontend has no mutation runner, so the behavior map is its proof. Keep one checked-in file for each `http` family: `frontend/tests/behavior-maps/<family>.md`. Each row has the behavior, the owner test (file and title), the layer, and the acceptance source. Write the map before the family changes, and keep it current after.
- **19. Evaluate per-test browser coverage.** Check whether Chromium V8 coverage, collected per Playwright test, can show frontend tests with zero unique lines. This is an evaluation, not a commitment. If it works, it becomes a second frontend proof beside item 18.

### Shared test infrastructure

- **8. Shared browser mocks.** Move the session mock into the base fixture in `tests/http/helpers/test.ts`, with an override option. Move each feature's fake backend (`installViewsApi`, `installDashboardApi`, `installLinksApi`, `installLibrary`, `installReportsApi`, `installDates`, `installKanbanApi`, and others) into `tests/http/helpers/` when a second spec needs it. Add an ID helper to replace the UUID literals. Check each mock body against `contracts/openapi.json`. Metric: route-mock lines, from 15.3k.
- **20. Shared backend builders.** Move `make_*` helpers and fixtures that two or more files repeat into the area's `conftest.py` or support module. Cache sample datasets per pack, profile, seed, and anchor, and copy them per test. Metric: repeated 8-line windows (7.6k lines today), setup time per test.

### Sweeps

- **9. Remove scaffolding.** Rename slice-ID titles to behavior names. Remove design-review capture calls (`captureOpenViewReview`, `S26_CAPTURE_THEME`) from retained tests. Merge the duplicate Access contract spec (`isolated/access/contracts.spec.ts` into `isolated/contracts/access-contract.spec.ts`). Review the tombstone tests ("route is gone", "cutover", "retired") under rule D1. Metric: no behavior loses its owner.
- **10. Turn on the deferred guards.** Fix, then enable, Ruff `PT011` (47 sites) and `PT012` (50 sites). Fix, then enable, the ESLint rules `prefer-web-first-assertions` (7), `no-force-option` (3), `no-wait-for-timeout` (1), `no-useless-not` (23), `valid-title` (4), `expect-expect` (1), `no-standalone-expect` (1), and `no-skipped-test` (5). Add a manual random-order backend run with `pytest-randomly`. Metric: each rule is on with zero violations.
   - Result (2026-10-11): done except `no-wait-for-timeout` (one negative-timing site in `sandbox-relationship-mappings`) and the random-order run. Ruff `PT011` (47 sites) and `PT012` (50 sites) are fixed by meaning (real `match=` messages, narrower exception types, one statement per `raises` block) and enforced. Seven ESLint rules are fixed and enforced.
- **17. Resolve the open suspects.** Each suspect ends fixed at its cause or removed under D1. None stays as it is.
   - Progress (2026-10-11): all five `test.skip` sites and the `test.fixme` are gone (they were screenshot-capture tests; behavior checks that only they ran moved into running tests), and so is the 90 s `person-card` timeout. Open: the other four long timeouts, one `waitForTimeout`, and the backend sleeps.
    - `test.skip`: `auth-email-change.spec.ts:526`, `help-panel.spec.ts:666`, `person-card.spec.ts:557`, `profile.spec.ts:861`, `sandbox-relationship-mappings.spec.ts:3201`.
    - `test.fixme`: `isolated/contracts/openapi-contract.ts:404`.
    - `test.setTimeout`: `person-card.spec.ts:556` (90 s), `openview-kanban-moves.spec.ts:809` (120 s), `fullstack/sandbox-workspace.spec.ts:1459` (360 s), `fullstack/access-controls.spec.ts:614` (90 s), `isolated/runtime/next-launcher-transport.spec.ts:86` (120 s).
    - `waitForTimeout`: `sandbox-relationship-mappings.spec.ts:3049`.
    - Backend sleeps: `relationships_integration/test_lock_wait.py:48`, `auth/test_provider_email_integration.py:71,101`, `workspace/test_workspace_security_proxy.py:158`, `events/test_provider_sse_acceptance.py:386`, `runtime/test_boundaries.py:110`. Polling loops in `operations/runner` that wait for a process to stop may stay if they have a bounded deadline.

### Consolidation, full stack, CI, and documents

- **13. Consolidation, one area at a time.** Apply rules D1 to D6 to each work package in section 6.
   - B1 result (2026-10-11): per-test coverage over `operations/sample/controls` (931 tests) shows 727 tests with zero unique lines. They are fault matrices: each case injects a different corruption and asserts its own refusal through the same checking code, so line coverage cannot separate them and is no evidence of redundancy (rule D1 needs more). No B1 test is removed. Its cost was runtime, which item 3 moved out of the stack shards.
   - F1 (OpenView): behavior map in `frontend/tests/behavior-maps/openview.md`. The analysis found 21 duplicate-ownership groups, 20 matrix candidates (about 430 net lines and 15% of the family's expanded cases), and shared-fake candidates (about 700 lines). Protected tests (401/403/404, reader access, regressions) stay.
- **16. Full stack and smoke.** Split `fullstack/sandbox-workspace.spec.ts` (one 1,593-line test with a 360 s timeout) into journeys behind a shared fixture. Make the smoke seed faster: run independent seeding steps in parallel, or restore a saved database snapshot of the seeded state, then measure. Metric: smoke time, from about 8 min; no 360 s timeout.
- **15. Clean baseline.** On one commit, with nothing else running, measure the frontend lane alone with the `blob` or `json` reporter (per-test durations), the backend lane alone, and the same commit in CI. Store the numbers in this file. Every later "before" value comes from this baseline.
- **21. CI target shape and parity.** See section 7. Prove parity: run one commit three times locally and in CI; the results must be the same each time.
- **23. Documents.** Update `docs/architecture/16-testing-architecture.md`, `frontend/README.md`, and the scoped `AGENTS.md` files to the final shape. Mark the test parts of older plans in `docs/plans/` as replaced.

## 5. Phases

| Phase | Items | Why in this order |
|---|---|---|
| 0. Land and measure | Commit the setup; 15 | Every later measurement needs one clean base. |
| 1. Guardrails | 14, 18 | No test is removed before the ledger check and the behavior-map format exist. |
| 2. Speed | 1, 2, 3, 22, 6, 7, 11, 12 | These items change no test content, and they make every later run cheaper. |
| 3. Evidence tools | 4, 5, 19 | Area work needs unique coverage and mutation scores. |
| 4. Shared setup | 8, 20 | Area work moves tests onto shared fixtures, so the fixtures come first. |
| 5. Sweeps | 9, 10, 17 | Mechanical and low risk; they shrink the areas before review. |
| 6. Areas | 13, 16 | One work package per change, in the order of section 6. |
| 7. Finish | 21, 23 | Final CI shape, the parity proof, and documents. |

## 6. Work packages for item 13

Counts come from the inventory of 2026-10-11. "Routes" counts `.route(` calls. "Slice" counts titles that start with a slice ID. "Style" counts `getComputedStyle`, `toHaveCSS`, and `boundingBox` checks. Do the packages from top to bottom.

### Frontend `http` families

| WP | Scope | Files | Lines | Tests | Routes | Session mocks | Slice | Capture | Style | Main work |
|---|---|---|---|---|---|---|---|---|---|---|
| F1 | OpenView | 9 | 22,081 | 288 | 207 | 14 | 86 | 36 | 31 | Shared fakes for views, dashboards, reports, charts, links, dates, kanban. Move filter, sort, and validation matrices to isolated tests. |
| F2 | Boards | 13 | 15,024 | 216 | 147 | 4 | 40 | 24 | 5 | Shared Board fake. Review `boards-route-cutover` as a tombstone. Widgets, posts, calendar first. |
| F3 | Sandbox | 1 | 6,859 | 92 | 69 | 3 | 21 | 9 | 23 | One file: split by journey, move mapping rules to isolated tests, fix the skip and `waitForTimeout`. |
| F4 | Access | 13 | 9,303 | 161 | 27 | 2 | 38 | 5 | 7 | Merge the four paging specs where they share a branch. Security and security events first. |
| F5 | Platform | 6 | 6,570 | 96 | 77 | 26 | 5 | 0 | 5 | Most session mocks of any family. Library files, report notifications, `platform-refactor-journeys`. |
| F6 | Manage | 5 | 5,142 | 75 | 32 | 4 | 22 | 2 | 0 | Audit and backup exports. |
| F7 | Auth | 6 | 2,756 | 58 | 49 | 14 | 15 | 0 | 0 | Session and MFA mocks into the base fixture. |
| F8 | Shell and settings | 14 | 7,413 | 150 | 80 | 17 | 1 | 3 | 31 | Organization, user theme preferences (20 style checks), profile, help, person card, aggregate calendar, workspace, appearance. Keep a style check only where it is the contract (contrast, 44 px hit area). |
| F9 | Comms | 1 | 594 | 21 | 1 | 1 | 0 | 0 | 0 | OpenComms is deferred and will be rebuilt. Keep it as it is; do not spend work here. |

### Frontend `isolated`, `fullstack`, and helpers

| WP | Scope | Files | Lines | Tests | Main work |
|---|---|---|---|---|---|
| I1 | OpenView, Boards, Sandbox | 50 | 14,393 | 314 | These become the owners of the matrices that leave F1 to F3. Merge same-branch cases into tables. |
| I2 | Contracts and API | 11 | 4,348 | 16 | Fix the `fixme`. Check that the generated contract tests cover each operation once. `route-manifest-source.ts` (1,459 lines) is data; leave it unless it is generated twice. |
| I3 | Access, runtime, security, others | 31 | 5,035 | 160 | Remove the duplicate Access contract. Check the 120 s launcher timeout. |
| I4 | Comms | 8 | 1,109 | 38 | Deferred with OpenComms. |
| S1 | Full stack | 3 | 3,069 | 5 | Item 16. Split long journeys; no timeout above the default without a measured reason. |
| S2 | Smoke | 8 | 478 | 17 | Item 16. Faster seed. |
| H1 | `http/helpers` and `tests/helpers` | 17 | 4,772 | 0 | The target of item 8. Each helper has one owner and one purpose. |

### Backend areas

| WP | Scope | Files | Lines | Tests | Time | Main work |
|---|---|---|---|---|---|---|
| B1 | `operations/sample/controls` | 50 | 16,576 | 931 | 806 s | Item 6. 11 files are near the 500-line cap only because of the old rule; merge parts of one behavior. |
| B2 | Other sample tests (`packs`, `phases`, `verification`, `population`, `sample`) | 61 | 13,587 | 503 | 268 s | Dataset cache (item 20). 80 `monkeypatch` calls in `population`. |
| B3 | Auth | 42 | 11,331 | 463 | 269 s | Item 7. 209 `monkeypatch` calls; check that they are at dependency boundaries. Rule D4 protects the denial tests. |
| B4 | Records and views (`record_queries`, `catalog`, `charts`, `views`, `dashboards`, `reports`, `search`, `listing`) | 70 | 14,930 | 626 | 242 s | Validation and query matrices into tables or properties (Hypothesis). |
| B5 | Boards | 40 | 10,328 | 276 | 175 s | Shared Board builders. |
| B6 | Workspace, audit, security events, events | 41 | 9,131 | 371 | 139 s | SSE acceptance sleep (item 17). |
| B7 | Files, jobs, scheduling | 42 | 8,550 | 293 | 135 s | Item 11. |
| B8 | Sandbox (`sandbox_*`, `relationships_integration`) | 63 | 12,095 | 233 | 129 s | Lock-wait sleep (item 17). Publication concurrency duplicates (35% repeated windows). |
| B9 | Lifecycle (`lifecycle_integration`, `lifecycle`) | 24 | 5,472 | 171 | 128 s | Shared graph builders. |
| B10 | Backups (`backups`, `operations/backups`) | 19 | 5,098 | 223 | 119 s | Merge export admission cases. |
| B11 | Migrations | 18 | 4,296 | 159 | 104 s | Rule D4 protects most of these. Remove only tests for migrations that no supported upgrade path still runs. |
| B12 | Access, users, RBAC, OpenView access | 38 | 8,354 | 381 | 99 s | Policy matrix into one table per rule. |
| B13 | Runner, runtime, reset, contracts, operations root, test support | 72 | 13,928 | 469 | 53 s | Runner guards stay (D4). Bounded polling loops may stay. |

## 7. CI target shape

This shape is a hypothesis. Items 1, 2, 3, and 12 confirm or change it with measurements.

| Workflow | Today | Target |
|---|---|---|
| Frontend | `check`, `build`, `isolated`, and 12 `http` shards. Each `http` shard installs Chromium and starts `next dev`. | `check`; `build` uploads `out/` as an artifact; `isolated`; N `http` shards with W workers each, serving `out/` through the static-site entry and balanced by duration. Use the Playwright container image or no browser cache (the cache misses today). |
| Backend | `quality`, 5 stack shards, `coverage-gate`, `reset-acceptance`, `container`. | `quality`; one job with no stack (`pytest-xdist`); M stack shards for database tests only; `coverage-gate` combines both; `reset-acceptance`; `container`. Durations come from the CI combine step. |
| Both | No check on test diffs. | The item 14 ledger and forbidden-pattern check on every change to test files. |
| Pre-push | `prepush.py --serial` runs the lanes one after another. | The same lanes and commands as CI, with the local worker counts from item 2. A change of shape in CI changes `prepush.py` in the same commit. |

Parity proof (item 21): run the same commit three times through the local gate and through CI. The pass and fail result of every test must be the same.

## 8. Execution model

1. Do one work package per change (rule D6). A change with removals needs a ledger, a behavior map or mutation result, and the area's focused batch.
2. Use `implement` workers for edits. Run workers in parallel only on files that do not overlap.
3. Only one worker runs a heavy lane at a time. The parent session holds the lane and starts each heavy run. Workers run focused tests only.
4. A change that removes or moves tests gets a `review` pass and a `deep_review` pass with the ledger attached. A person merges it. No worker merges its own removal.
5. Stop rule: if the mutation score of an area goes down, or a behavior loses its owner, that change does not merge. "Add it back later" is not accepted.
6. Record the before and after metrics of each area in this file (section 9) in the same change.

## 9. Metrics

Report each metric before and after, on the same base revision.

| Metric | Rule |
|---|---|
| Mutation score (backend modules with isolated tests) | Must not go down. Examine each new surviving mutant. |
| Tests with zero unique lines | Must go down. |
| Behavior map (frontend) | Each behavior has exactly one owner test. |
| Flake rate | 0 in 10 repeated runs, retries off. |
| Wall time per lane, local and CI | Report it. |
| CI runner minutes | Report it. |
| Local and CI result difference on one commit | Must be 0. |
| Test lines and test count | Report them. Do not set them as a target. |

Area results (fill in during phase 6):

| WP | Lines before | Lines after | Tests before | Tests after | Time before | Time after | Mutation or behavior map | Flake rate |
|---|---|---|---|---|---|---|---|---|
| F1 | 26,939 | 26,978 | 369 http + 105 isolated | 339 http + 150 isolated | not measured | 4.7 min http (under load) | 357 rows, one owner each | not measured |
| F2 | 19,553 | 19,304 | 255 http + 113 isolated | 146 http + 234 isolated | not measured | 56 s http | all owners resolve, none duplicated | not measured |

## 10. Exit criteria

The plan is complete when all of these are true:

1. All work packages in section 6 are merged, and section 9 has a row for each.
2. Every deferred guard in item 10 is on, with zero violations.
3. No `test.skip`, `test.fixme`, or `xfail` remains without an owner, an issue, and a review date.
4. No test sets a timeout above the default without a measured reason written next to it.
5. The parity proof in item 21 passes on three commits.
6. Local gate time and CI runner minutes are recorded before and after.
7. The documents in item 23 describe the final shape.

## 11. Risks

- **Breadth invites quiet weakening.** Many agents will touch about 70 areas. Solution: the item 14 check, one area per change, the stop rule, and a person who merges each removal.
- **Speed comes mostly from infrastructure, not from fewer tests.** Phase 2 can reach most of the time goal alone. Solution: judge phase 6 by maintainability (one owner per behavior, shared fixtures), not by time.
- **The static export changes browser behavior.** Prefetch starts automatically, effects run once, and CSP applies. Solution: classify each new failure (item 1) and keep the `http-dev` project for Strict Mode specs.
- **The frontend proof is weaker than mutation testing.** Solution: the behavior map (item 18), then per-test browser coverage (item 19), then Vitest and Stryker if an area still loses a behavior.
- **The skills are outside Git.** `.agents/` is ignored, so another machine does not get the new rules. Solution: decide where `.agents/` is kept before phase 1, or copy the rules that the checks depend on into the tracked `AGENTS.md` files.

## 12. Decision record

- **Static export server: `StaticSite` through a test-only ASGI entry.** It is the one routing source and it applies the production CSP. A Node server is the fallback only if item 1 measures it as faster overall.
- **Behavior maps: checked in, one file per `http` family.** They must survive for the next change in that family.
- **Vitest and Stryker for the frontend: not now.** The isolated tests run in 5 s, so Vitest gives no speed gain; its only value is Stryker. Pain point: the behavior map is weaker proof. Solution: item 19 first, then Vitest and Stryker for an area that loses a behavior that the map did not catch.
- **Playwright test agents (planner, generator, healer): do not use.** They add tests and can mark a test as skipped.
- **Retries stay at 0.** A flaky test is fixed at its cause or removed under rule D1.
- **PostgreSQL durability off: disposable test stacks only.** Never on the development or production stack.
