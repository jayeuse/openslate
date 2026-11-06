# CI speed plan

Status: approved by the owner on 2026-11-06; steps 1 to 3 are built in PR #92. Base revision: `ec8fcede` on `main`. This plan follows `docs/plans/ci-stability.md`. All rules of that plan stay: one retry in CI, the flaky ledger, the nightly stress job.

## 1. Evidence

All numbers come from the GitHub Actions job data and artifacts of 2026-11-02 to 2026-11-05: 16 full Backend runs and 15 full Frontend runs. A full run is a run in which the test lanes were not scoped down by `changes`.

| Measure (green runs) | Median | Range |
|---|---|---|
| Backend wall time | 15.1 min | 11.4–15.7 |
| `unit` job | 14.0 min | 10.2–14.9 |
| Slowest coverage shard | 10.2 min | 9.8–11.0 |
| Frontend wall time | 8.3 min | 7.8–12.1 |
| Slowest http shard | 6.4 min | 6.1–10.3 |

### 1.1 Runners have two speeds

- In 5 of 16 runs the `unit` job took 9.8 to 10.4 min. In the other 11 it took 13.1 to 15.3 min.
- The same tests ran in both groups. Run 41949745200 summed 2,185 s for 4,950 unit tests. Run 42061255580 summed 2,965 s for 4,961 unit tests, 1.36× slower.
- Integration tests change less: 1,780 s against 1,944 s, 1.09× slower.
- The cause is runner hardware. Unit parts of equal size took 5.9 to 6.05 min on an EPYC 7763 and 3.3 min on an EPYC 9V45.

This plan sizes every job for the slow runner.

### 1.2 Backend unit lane

- One job runs 4,961 tests on 4 workers. The summed test time is 2,965 s on a slow runner.
- The sample-organization tests (`tests/operations/sample/**`) take 2,726 s, 92% of that time.
- The slowest single test takes 121.7 s.
- The limit of 15 min cancelled the job twice with every test passing (runs 41456921849 and 42055275478). `816ddead` raised the limit to 20 min. That stops the cancels, but the job still takes 14 min.

### 1.3 Backend coverage shards

- 5 shards run 2,682 tests with a summed time of 1,944 s.
- Each shard has about 170 s of fixed cost: the stack start (73 to 94 s), the pytest start (about 70 s) and the job setup.
- Each shard runs its tests on one worker.
- `backend/tests/.test_durations` has 1,923 entries, so at least 759 tests have no stored time. pytest-split gives each of them the average time.

### 1.4 Frontend

- 6 http shards run 113 spec files with a summed time of 2,960 s, on 2 workers per shard.
- The test step of a shard takes 183 to 323 s. The spread comes from old weights. `manage-system-health.spec.ts` has no weight yet.
- `playwright install --with-deps chromium` normally takes 12 s. In 3 of 90 jobs it took 134 to 264 s, all on 2026-11-04. Then 6 of the next 16 installs took 492 to 676 s. The cause is `apt-get` downloading 21 MB at 28 to 182 kB/s. One such job sets the wall time of the whole run: the first run of this plan's branch took about 18 min.
- On this runner image `--with-deps` installs 9 packages, and all of them are fonts. No shared library is in the list. The specs have no screenshot baselines, and the app ships its own fonts through `next/font`, so nothing depends on these packages.

### 1.5 Stability

**Pull requests and `main` are quiet.** `ci_flake_report.py` read 14 Frontend runs on `main` and four branches. It found no failed test and no flaky test.

**The nightly stress job is not.** It repeats recently changed specs 20 times at 4 workers with zero retries.
- All 6 runs failed. Each one ended at the 30-min step limit, with 40% to 80% of its tests done. No run has finished.
- The first three nights had 16 real test failures. 13 were in three `access-security-events` tests (13 of 180 executions, about 7%). 2 were in `platform-library-files`, and 1 was in `account-settings`.
- The last three nights had no test failure, but they did not finish.

`frontend/tests/flaky.json` still lists two tests from PR #84. An entry that expires fails CI only when its test repeats (`playwright_flaky.py`).

| Test | Cause | Confidence |
|---|---|---|
| `access-people` › the access panel names the level… | Spec race. The test clicks the Access tab while the person sheet slides in (360 ms). The pointer-down lands on the tab, and the pointer-up lands after the tab moves away, so the tab does not change. | High |
| `access-security-events` › Events a policy refusal conceals a cached feed… | Unknown. The page stays on `/manage?view=audit…`, and no navigation guard refused. The stress job fails two other tests in this spec in the same way, and they do not use `page.clock`, so the clock is not the cause. | Low |

CI uploads traces only when a job fails (`frontend.yml`, `if: failure()`). A test that passes on its retry and is in the ledger keeps no trace.

**Backend failures on pull requests and `main`.** These are the Backend failures in the window:

| Run | Failure | Class | State |
|---|---|---|---|
| 41456921849 (`main`), 42055275478 | `unit` cancelled at 15 min | Time limit on a slow runner | Limit raised; the job time is step 2 |
| 41535874900 (`main`) | `test_search_over_one_hundred_thousand_messages…`: p95 above 300 ms | Timing limit on a shared runner | **Open** (B1) |
| 41888068927 | `test_a_second_upgrade_waits…` | Test tied to one revision | Fixed in `567fa68c` |
| 41883648597 | Many tests in 5 shards | Defect in the pull request | Fixed in `01737a24` |
| 41449497841 | Coverage gate | Missing coverage in the pull request | Fixed in PR #84 |

The search test failed on samples near 240 ms with spikes above 320 ms. Its p95 is the second-worst of 30 samples, so two runner spikes fail it. This is the same class as the timeline limit in `ci-stability.md` D2. It failed in 1 of 16 full runs. That is about 6%, so this test alone can defeat the 95% first-try goal.

### 1.6 Concurrency

- A pull request starts up to 17 jobs at the same time.
- On 2026-11-02 the repository reached exactly 40 jobs at the same time, and jobs waited 35 to 68 s in that same minute. It ran more than 20 jobs for 1,371 s in total. The median job wait is 2 s.
- This matches the 40-job limit of the Pro plan. The 20-job limit of the Free plan does not apply. The peak since 2026-11-03 is 18.
- The repository belongs to a personal account. Merge queue, GitHub larger runners and Blacksmith need an organization.

## 2. Contract

**Outcome.**
- Backend and Frontend each finish in 8.0 min or less on a pull request, on the slow runner.
- A pull request is green on its first try at least 95% of the time.
- The flaky ledger is empty.

**Not in scope.**
- Paid runners.
- Moving the repository to an organization.
- A merge queue.
- Test selection that skips checks on a pull request.

**Preserved behavior.**
- CI runs every check of `scripts/prepush.py` on every pull request.
- The coverage thresholds stay.
- The retry and ledger rules stay.

**Done when all of these are true:**
1. 10 full pull-request runs in a row finish with Backend ≤ 8.0 min and Frontend ≤ 8.0 min.
2. At least 95% of runs are green on the first try over two weeks. Runs that fail on a real defect of the pull request do not count. Use `ci_flake_report.py` for Frontend and `gh run list` for Backend.
3. `flaky.json` has no entries.
4. Every job finishes in less than 70% of its timeout.
5. The nightly stress job finishes inside its limit, and it is green on 3 nights in a row.

## 3. Slices

All slices go on one branch and in one pull request. Each push gives one CI measurement. CI runs only on a pull request, so the pull request opens as a draft after step 1.

`assertion_guard.py` runs in the `changes` job. A test file that it refuses fails `changes`, and that push's measurement is lost. So run the guard before each push.

| Step | Slice | Change | Owner | Files | Expected effect |
|---|---|---|---|---|---|
| 1 | F1 | Add a shared `openedSheet()` helper. It waits until the sheet has no `data-starting-style` and no running animation. Use it in `access-people.spec.ts`, then check the other specs that click inside a sheet. Remove the ledger entry. | Frontend Engineer | `frontend/tests/http/helpers/`, `frontend/tests/http/access-*.spec.ts`, `boards-card-sheets.spec.ts`, `boards-live-management.spec.ts`, `flaky.json` | One flake removed |
| 1 | F2 | Find the cause of the three `access-security-events` failures from the stress traces, then fix it. Repeat all three tests at 4 workers with zero retries. Read the `platform-library-files` and `account-settings` stress failures too, and fix them if the cause is clear. Remove the ledger entry. | Frontend Engineer | `access-security-events.spec.ts`, the two other specs; app code only if the evidence points there | The stress failures removed |
| 1 | F3 | Upload the trace folder when a test passes only on its retry, not only on failure. | Infrastructure Engineer | `.github/workflows/frontend.yml`, `tests/tooling/test_ci_workflows.py` | Evidence for every flake |
| 1 | F4 | Remove `--with-deps` from every Chromium install, so CI never uses `apt-get`. If the runner image ever loses a library, Chromium fails at launch with a clear error. | Infrastructure Engineer | `frontend.yml`, `stress.yml`, `tests/tooling/test_ci_workflows.py` | No install stall |
| 1 | F5 | Raise the stress step limit so that a run finishes. The worst run did 40% in 30 min, so a full run takes about 75 min. The step limit becomes 110 min and the job limit 120 min, which keeps the run under 70% of its limit. Keep the 240 s selection budget, because a lower budget stresses fewer specs. The job is not on a critical path. | Infrastructure Engineer | `stress.yml`, `tests/tooling/test_ci_workflows.py` | Every nightly run gives a result |
| 1 | F6 | Fix the OpenView race that the ledger gate found on this branch: a discarded draft landed on the next view. Add a failing-first test. | Frontend Engineer | `server-backed-views-workspace.tsx`, `openview-views-api.spec.ts` | One app defect removed |
| 1 | F7 | Make the cold Boards test hold the list read until the stream is live. A stream that connects later reads the list again on purpose; a new test owns that read. | Frontend Engineer | `boards-navigation.spec.ts` | One flake removed |
| 1 | B2 | Warm the new app before the readiness test starts its 2 s hold. The first request built the routes inside the hold, and the test ran at up to 2.0 s on slow runners. | Backend Engineer | `backend/tests/runtime/test_readiness_timeouts.py` | One flake removed |
| 1 | B1 | Apply owner decision 2 to the search test. `fullstack_runner.py` gives the tests a clean environment with no `CI` value, so the runner must pass one on. | Backend Engineer | `backend/tests/comms/routes/search/test_search_performance.py`, `backend/tests/fullstack_runner.py` | One timing failure removed |
| 1 | F8 | Move the macOS development build to `macos-15`. GitHub retired the macOS 14 images, so that job cancelled within 1 second on every push. | Infrastructure Engineer | `native-manager.yml`, `tests/tooling/test_native_manager.py` | The macOS build runs again |
| 2 | S1 | Split the unit lane into 3 jobs with pytest-split, `-n 4` in each job. Keep the unit durations in their own compact file, taken from the unit lane's `pytest.xml`, because the shards keep integration tests only. Let `combine` take the expected number of unit parts (default 1, for the local gate), so a lost part still fails. Give each job a unique artifact name. Print the runner's CPU model in the job, to confirm §1.1. | Infrastructure Engineer | `backend.yml`, `backend/tests/backend_coverage.py`, `backend/tests/parallel_coverage.py`, `test_backend_coverage_shards.py`, `tests/tooling/` | `unit` 14.9 → about 5.5 min |
| 2 | S2 | Commit the integration durations from the `test-durations.json` in a CI run's `backend-coverage` artifact. Raise the coverage shards from 5 to 10. Add a refresh rule: refresh the durations file when the shard test times spread more than 20%, as `ci-stability.md` §5 does for the http shards. | Infrastructure Engineer | `backend.yml`, `backend/tests/.test_durations`, `tests/tooling/` | Coverage 11.0 → 6.2 to 6.9 min |
| 2 | S3 | Raise the http shards from 6 to 8, and refresh `tests/http/.test-durations.json`. Keep 2 workers per shard. | Infrastructure Engineer | `frontend.yml`, `frontend/tests/http/.test-durations.json`, `scripts/playwright_shards.py`, `tests/tooling/`, `docs/architecture/16-testing-architecture.md` | Frontend 8.3 → about 6.8 min |
| 3 | S4 | After 3 full CI runs of the new layout, set each changed job timeout to about 2× its measured time, so the limit stays a real hang guard. | Infrastructure Engineer | `backend.yml`, `frontend.yml`, `tests/tooling/test_ci_workflows.py` | No timeout cancels; hangs still stop early |

The Frontend, Backend and Infrastructure work in step 1 uses different files and can run at the same time. F1 and F2 share files, F3, F4 and F5 share files, and S1, S2 and S3 share files, so each group runs one after another. Each role stages only its own paths. S2 and S3 take their durations from the last full CI run.

After each step, the Software Architect reviews the code. After F1 and F2, the QA Engineer retests the specs with repeat runs.

**Not on the path:**
- **Building each sample dataset once.** It saves about 712 s of summed time (estimate), but after S1 the unit lane is no longer the long pole. Do it if a unit job passes 7 min.
- **Moving the `[large]` sample tests to the nightly job.** It is not needed, and it would reverse the rule that CI runs every check.
- **4 Playwright workers per shard.** 8 shards reach the target with the same load on each runner, and Playwright recommends fewer workers in CI.
- **xdist inside the integration shards.** Auth, Storage and Realtime share one database, so the risk is high.
- **Template databases for the migration tests.** The saving is less than 0.1 min per shard.
- **`COVERAGE_CORE=sysmon`.** It is already the default.
- **`--only-changed` as a gate.** The http specs do not import `src/`, so it would miss most impact.

## 4. Model

These models reproduce the measured jobs within 0.1 min. All inputs are slow-runner numbers.

- **Unit job** ≈ 43 s + 1.06 × 1.1 × 2,965 s ÷ (4 × 3) = 331 s.
- **Coverage shard** ≈ 170 s + 1.05 × 1,944 s ÷ 10 = 374 s. A shard on a runner 1.2× slower takes 415 s.
- **Backend wall** ≈ slowest job + 0.75 min (`changes`, the gate, `verify`).
- **Frontend wall** ≈ 1.8 min (`changes`, build) + 1.0 min (shard setup) + the slowest test step + 0.1 min. A balanced 8-shard test step takes 186 s. The plan allows 233 s, the same 1.25× margin that 6 shards show today.

| Layout | Backend | Frontend | Peak jobs |
|---|---|---|---|
| Today (median) | 15.1 min | 8.3 min | 17 |
| After steps 1 to 3 (model) | 7.0 to 7.7 min | about 6.8 min | 26 |
| After steps 1 to 3 (3 measured runs) | 7.1 to 7.6 min | 6.6 to 6.8 min | not measured |

The coverage shards set the Backend time. More shards help little, because 170 s of each shard is fixed cost.

## 5. Owner decisions

1. **Go-ahead** for steps 1 to 3.
2. **The search timing limit (B1).** Recommendation: treat it as D2 treats the timeline limit. In CI the test reports the 300 ms number. The SELECT-count and row-bound assertions keep blocking in every run, and a local gate run still enforces 300 ms. This changes a blocking check, so it needs your approval.

**B1 and the assertion guard.** `assertion_guard.py` pairs unchanged assertion expressions and asks for a row in `docs/plans/test-ledger.md` for each unpaired removal. Keep the same `assert` line and run it only outside CI, so that the guard pairs it. Run the guard before the push. If it refuses, add a ledger row that names an existing owner test.

**Pain point of B1.** `prepush.py` no longer runs before a push, so the two timing limits block only when someone runs the local gate. A real slowdown would show as a number and not as a red run. Solution: keep the numbers in the job summary, and run the local gate before a release.

**Pain point of one pull request.** The ledger entries expire on 2026-11-16. An expired entry fails CI only when its test repeats, and neither test has repeated since PR #84. If the pull request will miss that date, F1 and F2 can land first. Solution: finish step 1 first, and check the date when step 1 ends.

## 6. Risks

| Risk | Solution |
|---|---|
| Ten stack starts per run instead of five double the exposure to image-pull failures. | 80 stack starts in the window had no failure. Measure how the stack start splits between image pulls and health checks during S2. Cache the images if the pulls dominate. |
| Two pull requests at the same moment use 52 jobs, above the 40-job limit. | Some jobs wait 1 to 2 min. `cancel-in-progress` already drops out-of-date runs. The 8-min target is for one pull request at a time. |
| The suites grow: 99 unit and 76 integration tests in four days. | The 20% rule in S2 keeps the shards balanced. Review the shard counts when a job passes 7 min. |
| pytest-split and xdist may not work together at full size. | A check on `tests/rbac` passed: 3 groups of 8 tests gave the 24 tests of the whole folder. Confirm at full size on the first push of S1. |
| Other sessions share this checkout and machine. | The parent grants one local test lane at a time (rule zero). Keep other sessions' uncommitted files out of each commit. |

## 7. What teams with many AI pull requests do

The Software Architect collected these sources on 2026-11-02.

| Finding | Source | This repository |
|---|---|---|
| CI volume grows fast with coding agents. A secondhand report says Anthropic's CI job volume grew 25× in six months. Blacksmith reports weekly jobs from 5.4M to 90.5M during 2026. | [Tech Funding News, Oct 2026](https://techfundingnews.com/blacksmiths-valuation-jumps-17x-in-13-months-as-66m-series-c-backs-ai-code-testing/) | Each pull request uses 17 jobs, and 26 after this plan. |
| Plan concurrency for bursts of pull requests, not for the average. Measure queue time. | [Megaport, 2026-08-06](https://www.megaport.com/blog/are-ai-coding-agents-the-new-ci-bottleneck/) | Measured in §1.6: median wait 2 s, longest 68 s at a peak of 40 jobs. |
| Agent pull requests get the same required checks as human ones. The agent runs the smallest useful check before it pushes. Rerun only failed jobs, cancel old runs, stop an agent after 3 to 5 failed attempts, and shard by measured time. | [Depot guide](https://depot.dev/resources/guides/how-do-i-test-ai-generated-pull-requests-in-ci) (undated) | Done: fast checks before push, `cancel-in-progress`, measured shards. Missing: up-to-date durations (S2, S3). |
| False agent claims that the whole suite passed fell from 8.7% to 0.3% over 644 pull requests. The remaining gap is scope: a claim about one part while another part failed. | [testreceipt, Jun–Sep 2026](https://github.com/amos689/testreceipt) | Supports the current rule: focused tests before the push, and the full suite in CI. |
| Selective CI on pull requests, with full runs at night or in a merge queue. | No sourced field report found. | Not in scope (§2). Merge queue needs an organization. |

## 8. Root-cause work

Status: requested by the owner on 2026-11-06, after PR #92. It replaces workarounds in that PR with fixes. It runs on its own branch, because PR #92 is reviewed and green, and this work is larger and riskier. Each fix is one commit, so each gives its own CI measurement.

| Item | Outcome | Removes | Preserved |
|---|---|---|---|
| R1 Sample datasets | Each duplicate dataset in the realism, consistency and core tests builds once per test process | The repeated builds, about 712 s of summed time (estimate) | The same tests and assertions. Every cached dataset goes through `private_copy` and the `MUTANT_UNDER_TEST` bypass, so a test cannot hide its own change to shared data. Two consistency tests skip both today, and R1 closes that gap |
| R2 Shard start-up | The fixed cost of about 170 s per coverage shard falls, from a measured split | Whichever cost the measurement names | All services that the ownership guard needs |
| R3 Search check | A deterministic check blocks in CI, so a slowdown in database work fails a run again | Nothing. The 300 ms number stays as a report in CI and a limit in the local gate, because only it sees CPU time | The SELECT-count and row-bound assertions. A non-deterministic check is not acceptable, because it brings the flake back |
| R4 Stress budget | The selection budget predicts real run time, from the finished run | The 2× to 4× underestimate, and the skip of specs above the old budget | The repeat count, the workers, and zero retries |
| R5 Sidebar panel | The opening panel cannot scroll, so the click race ends for every spec | The scroll hazard in the app | The look, the motion, and keyboard reach. `openedPanel` stays unless it is proven dead. It hides this fix, so the proof is a new test without the helper |
| R6 Boards late stream | A measured answer for a cold load where the stream connects late | The unknown cost of that order | The read after a late stream connects, because a change in that gap has no event |

**Order.** Measure first, then build, then one retune. No slice changes limits or durations: after all fixes land, 3 full runs set them once (TASK-0029). Push one commit at a time, because `cancel-in-progress` drops a run in flight.

**Not in this work:**
- Sheet clicks: the app needs no fix.
- Runner speed: free runners cannot change it.
- The CI retry: it stays until first-try green reaches the goal. Removal is an owner decision.
- REQ-0004: a separate defect, with its own card.

**Risk of R1.** It changes the structure of 92% of unit time. The speed gain is secondary, and the risk is that a shared dataset hides a failure. So the proof is the same tests and the same assertions, with a count that shows each dataset built once. A faster job alone is not proof.

