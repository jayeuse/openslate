# CI stability plan

Status: D1, D2 and D3 approved by the owner on 2026-10-30. Base revision: `85bc9bba` on `main`.

## 1. Evidence

All numbers come from `gh run list` and the failed-run logs on 2026-10-30. The window is 2026-10-15 to 2026-10-30, all branches.

| Workflow | Runs | Failed | Cancelled | Cause of the failures |
|---|---|---|---|---|
| Frontend | 69 | 17 | 14 | Browser tests (see below) |
| Backend | 70 | 5 | 13 | Real defects: coverage gate (4, one branch), mypy and sample errors on Dependabot and Comms branches |
| Security, CodeQL, Labeler, Native Manager | 253 | 0 | 0 | — |
| Mutation (optional) | 2 | 2 | 0 | The `NATIVE` step fails every week |

The cancellations come from `cancel-in-progress` when a newer push arrives. They are not failures. Thus 17 of 55 completed Frontend runs failed (31%). On `main`, 4 of the last 5 Frontend runs failed, including the merge of PR #71.

A failed Frontend run almost always has exactly one failed test among about 2,800 browser tests (1,370 isolated, 1,450 HTTP), and the failed test changes from run to run. The flake rate per test run is about 13 / (55 × 2,800) ≈ 8 × 10⁻⁵.

### 1.1 Failure classes in the window

| Class | Tests | Runs | Whose fault |
|---|---|---|---|
| A. Wall-clock limit on a shared runner | `comms-timeline-performance` (300 ms open-to-ready at 4x CPU) | 6 | Ours. It failed 3 times inside HTTP shards, then 3 times in six days on its own runner after it was isolated (`6bae1004`), last at 315.8 ms. |
| B. Byte budget with no headroom | `comms-js-budget` (cold `/comms` gzip below a fixed target) | 2 | Ours. The bundle grew; CI measures about 1 KB more than local. |
| C. Timing races in HTTP specs | `auth-cross-tab-gate:63`, `boards-calendar-views:438`, `boards-live-management`, `comms-attention`, `comms-connections`, `comms-query-loading`, `manage-backup-exports`, `openview-views-api` export journeys, `user-theme-preferences`, `access-security-events` | 1 each | Ours. Each test acts before the page is ready, or measures layout before fonts or scrollbars settle. |
| D. Real breaks | Dependabot TypeScript update (`route-manifest-source.ts`) | 1 | Ours. CI did its job. |
| E. GitHub infrastructure | `actions/checkout` timed out | 1 | GitHub |

Older failures (2026-09-20 to 2026-10-10) came from a missing browser cache, Google Fonts downloads during the build, and requests to an unset API port. Local fonts (`next/font/local`) and the static-export test server removed these causes. This plan does not repeat them.

### 1.2 Workarounds already in the history

| Commit | Change | Effect |
|---|---|---|
| `6bae1004` | Moved the timeline measurement to its own `measure` job | It still failed alone (class A). |
| `9206df25`, `1902b984` | Raised the JS target from 546,979 to 548,000, then to 550,000 bytes | Each raise came after a red run. About 1.2 KB of headroom stays. |
| `3b478af5` | Gave browser-installing jobs 30 minutes for slow apt mirrors | Fixed the cancellations from `playwright install --with-deps`. |
| `ead793ca` | Raised liveness waits in a backend race test from 3 s to 10 s | Correct fix; the assertions did not change. |
| `a79a8923` | Fixed two flaky HTTP specs at the cause | Correct fix. It shows that the flakes are real races in test code. |

### 1.3 Other findings

- The shard weights in `frontend/tests/http/.test-durations.json` date from 2026-10-13. The Boards, OpenView, Sandbox and Manage relayouts added many specs after that date. Shard times now vary from 3.1 to 5.9 minutes.
- CI runs each HTTP shard with `--workers=2`. The comment in `frontend/playwright.config.ts:132-137` says to measure again on the 4-vCPU runners. Nobody has measured it.
- Local runs use macOS overlay scrollbars. CI uses Linux with 15 px scrollbars. A geometry test can therefore pass locally and fail in CI.
- The repository has no flake report, no stress lane, and no quarantine. The assertion guard (`scripts/assertion_guard.py`) refuses new retries, sleeps and skips. This is correct, but it leaves no safety margin for random failures.

## 2. Contract

**Outcome.** A Frontend or Backend run fails only for a real defect or a real regression. A random failure does not block a merge.

**Done when** both conditions hold, checked with `gh run list`:

1. 20 completed Frontend runs in a row on `main` pass.
2. Over two weeks, at least 95% of pull-request runs pass on the first attempt, excluding runs with a real defect. The S0 flake report classifies each failure as flaky (it passes on the same commit) or real.

**Exclusions.**

- No Backend workflow changes. Its 5 failures were real defects.
- No change to the 90% coverage thresholds, the UTC and `en-US` pins, or the release smoke suite.
- No new paid runners or third-party CI services.

**Preserved behavior.**

- Rule zero: one heavy test lane at a time, and `prepush.py --serial`.
- Local runs and `prepush.py` keep `retries: 0`, so a flake still shows on the development machine.
- The assertion guard still refuses sleeps, skips and loose matchers in specs.
- Every workflow change updates `tests/tooling/test_ci_workflows.py` in the same commit. Every assertion change gets a row in `docs/plans/test-ledger.md`.

## 3. Decisions

The owner approved all three recommendations on 2026-10-30. D2 replaces the owner decision of 2026-10-24 for CI only.

### D1. One retry in CI only

**Recommendation:** set `retries: isCI ? 1 : 0` in `frontend/playwright.config.ts`.

With zero retries, about 2,800 × 8 × 10⁻⁵ ≈ 0.22 random failures occur per run. To get below 5% red runs, the flake rate must fall by about 5 times, while the suite grows by hundreds of tests each week. With one retry, a run fails only when the same test fails twice: about 2,800 × (8 × 10⁻⁵)² ≈ 2 × 10⁻⁵ per run.

**What it removes:** the zero-retry rule in CI. It touches `playwright.config.ts`, `docs/architecture/16-testing-architecture.md`, and the guard rule for `_TS_CONFIG_FILES` in `assertion_guard.py`.

**Pain point:** retries can hide real races. `a79a8923` fixed two such races.
**Solution:**

1. A required summary step lists every test that passed only on retry, with a link to its trace.
2. Each flaky test gets an entry in `frontend/tests/flaky.json` with an owner and an expiry date of 14 days.
3. `frontend-verify` fails when a test passed only on retry and has no `flaky.json` entry, or when its entry has expired. A known flake does not block a merge; an unknown or old flake does.
4. A nightly stress job (S7) runs recently changed specs with zero retries and fails on any flake.
5. The guard accepts only the exact form `isCI ? 1 : 0`, so nobody can raise the count.
6. The `measure` project sets `retries: 0`. A second attempt would hide a slow first measurement. The JS budget test needs no exception: it is deterministic and fails on both attempts.

### D2. The timeline measurement reports in CI and blocks in prepush

**Recommendation:** the CI `measure` job records the numbers in the job summary and does not block `frontend-verify`. The 300 ms limit stays blocking in `prepush.py`, which runs on a free machine (rule zero).

The owner decision of 2026-10-24 kept 300 ms blocking in an isolated CI job. That job then failed 3 times in six days (runs 40149335213, 40186009225, 40526169591), last at 315.8 ms. It failed again at 315.4 ms on the merge of PR #71 (run 40985170908). The same build measures 52-80 ms locally. A shared runner at 4x CPU throttling cannot hold a 5% margin.

**What it removes:** the `MEASURE` requirement in `frontend-verify`. It also changes `test_frontend_runs_wall_clock_measurements_alone` and `test_frontend_verify_preserves_the_required_check`.

**Pain point:** a report-only job can stay red and nobody acts on it.
**Solution:** the summary shows the trend against the last 10 `main` runs. Prepush still fails above 300 ms, so a real regression cannot reach a push.

### D3. The JS budget stays blocking, with one number and a warning zone

**Recommendation:** keep `comms-js-budget` blocking, because it is deterministic. Add two rules:

1. The test warns when the cold size comes within 2,000 bytes of the target.
2. A pull request that adds approved shell code records the new target in the same commit, with a ledger row. This already happened twice, but only after a red run.

**Pain point:** a target that moves with each feature stops being a limit.
**Solution:** the report keeps the S04 baseline (546,979 bytes). Each raise must name the feature and the bytes it adds, as `1902b984` did.

## 4. Slices

Each slice is one commit of five files or fewer, in this order. S1 to S3 need the owner decisions above.

| Slice | Change | Files | Proof |
|---|---|---|---|
| S0 | Flake report: read the `frontend-playwright-*` JSON artifacts of `main` runs and list failures per test | `scripts/ci_flake_report.py`, its tooling test | The report reproduces the table in 1.1 |
| S1 | D2: remove `measure` from the `needs` list and the checks of `frontend-verify`; the job writes its numbers to the summary | `frontend.yml`, `test_ci_workflows.py`, testing architecture doc | Workflow contract tests |
| S2 | D3: pin `.node-version` to the exact local version (was `26`, so CI took any 26.x); find the 1 KB difference (see 4.0); add the warning zone | `.node-version`, `comms-js-budget.spec.ts`, ledger | The cause is named and removed, or the budget is measured only in the CI build job |
| S3a | D1: CI-only retry, guard rule for the exact form | `playwright.config.ts`, `assertion_guard.py`, its test, testing architecture doc | Guard tests refuse `retries: 2` and accept `isCI ? 1 : 0` |
| S3b | D1: flaky summary step and `flaky.json` check | `frontend.yml`, `test_ci_workflows.py`, `frontend/tests/flaky.json` | A planted flaky test shows in the summary |
| S4 | Fix each class C spec at its cause, one commit per spec | One spec (and a helper if needed) per commit | 20 of 20 repeats at 4 workers, and the same spec in the Linux image (4.2) |
| S5a | Add an app ready marker in `src/`: the root client shell sets `data-app-ready` on `<html>` after hydration. No marker exists today. | Root layout client component, one isolated test | The marker appears only after hydration |
| S5b | Readiness helpers in `tests/http/helpers/test.ts`: wait for `document.fonts.ready` before geometry checks; wait for `data-app-ready` before events | Helper, two specs that use it | The class C specs that depend on layout or listeners pass 20 of 20 |
| S6 | Refresh the shard weights from the last 14 days of artifacts; compare 1 and 2 workers on the class C specs | `.test-durations.json`, `playwright_shards.py` doc line | Shard times within 20% of each other |
| S7 | Nightly stress job: specs changed in the last 7 days, `--repeat-each=20 --workers=4`, zero retries, 30-minute limit, not required. `a79a8923` needed 20 repeats to show its race. | New workflow, `test_ci_workflows.py` | A planted race fails the job |
| S8 | Mutation job: fix the `NATIVE` step, or remove the schedule | `mutation.yml` or `scripts/mutation.py` | One green manual dispatch |

### 4.0 S2 finding: the 1 KB budget difference

The CI and local builds are byte-identical (100 chunks, 5,136,294 bytes, same names). The difference is in the gzip step of `comms-js-budget.spec.ts`:

| Node build | zlib | `0t6o3jw5ozuec.js` at level 9 | Cold `/comms` total |
|---|---|---|---|
| Homebrew Node 26.8.1 (macOS arm64) | 1.2.12 (system) | 33,634 bytes | 547,836 bytes |
| Official Node 26.8.1 (Docker, amd64 and arm64) | 1.3.2.1-motley (bundled) | 33,759 bytes | — |
| CI, official Node 26.8.1 and 26.13.0 | 1.3.2.1-motley (bundled) | 33,759 bytes | 548,839 bytes |

The Node version and the CPU are not the cause. Homebrew links Node to the system zlib; the official builds bundle Chromium's zlib, which compresses differently. The `.node-version` pin stays for parity, but it does not remove the difference.

**Owner decision (2026-10-30):** keep Homebrew Node on the development machine. The CI number is the reference for the JS budget; a local run reads about 1,000 bytes lower. The spec records `process.versions.zlib` in its report, so a reader can see which zlib measured it.

### 4.1 Known causes in the class C backlog

- `auth-cross-tab-gate:63`: the spec sends a `focus` event before the gate listener can be attached. Fix: wait for a signal that the listener exists before the event.
- `boards-calendar-views:438`: the spec measures line wrapping, which depends on font loading and on the Linux scrollbar width. Fix: wait for fonts, and check the wrap with the Linux image.
- All other class C specs: read the saved traces before the fix. The traces of the last 11 failed runs are saved in `.agent-runtime/ci-traces-2026-10-30/` (ignored by Git), because GitHub keeps them for 7 days only.

### 4.2 Local parity

Add `npm run test:linux -- <spec>`. It runs one spec in the pinned Playwright image (`mcr.microsoft.com/playwright:v<version>-noble`), the same browser and scrollbars as CI. The image has no `uv`, so the static export server (`tests.static_export_server`) runs on the host. The container reaches it through `host.docker.internal` on macOS, with `BASE_URL` set to that host.

**Pain point:** Docker beside a running test lane breaks rule zero.
**Solution:** the command refuses to start when `prepush.py` or another heavy lane runs, using the same check as the gate.

## 5. Risks

| Risk | Solution |
|---|---|
| The retry hides a new race | Nightly stress job (S7) and the `flaky.json` expiry |
| The weights go stale again | S0 report shows shard time spread; refresh when the spread is above 20% |
| `--workers=1` makes shards slower | Measure first (S6). Change it only if the flake rate falls. |
| A Playwright or Next update changes timing | Dependabot pull requests run the full suite; a red Dependabot run is a real break (class D) |
