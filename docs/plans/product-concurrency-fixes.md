# Product concurrency fixes

Status: draft for approval (2026-10-29). Branch: `sample-pack-realism-p1`; all phases land on this branch as one pull request. Nothing in this plan is implemented.

Target: a mid-size installation, one server with 8 cores and 16 GB, up to about 300 people active at the same time across all organizations. Every capacity default and every load test uses this target.

## Purpose

Seven sample packs that populated one installation at the same time showed product defects. This plan fixes the causes of those defects in the product. It does not tune the product or the tests to make a sample run pass.

## Rules for every item

1. Find the cause in the code before you write a fix. If the cause is not visible, add the logging first and reproduce the failure.
2. Write the real-world trigger: who does what, and when, for the defect to occur in production.
3. Write a failing-first test that reproduces that trigger at the lowest faithful layer. Use real PostgreSQL for lock and transaction behavior.
4. Fix the cause. Do not add retries, longer waits or higher limits that only hide the cause.
5. Record each item in `docs/specs/sample-pack-realism.md` with its trigger, cause, fix and test.
6. Run database tests alone. Never run them beside a sample run, a full suite or the gate (rule zero).

Correct: `Two previews by one administrator deadlock on the user row; the test reproduces the two previews; the fix removes the lock upgrade.`
Wrong: `The purge preview failed in a sample run, so the seeder now retries it.`

## What was found

| ID | Defect | Real-world trigger | Cause | Cause status |
|---|---|---|---|---|
| C1 | Purge confirmation deadlocks (503) | One administrator starts two purge or close confirmations at the same time (double-click, two tabs) | `require_fresh_exact_admin` locks the user row `FOR SHARE`. Then `challenge_store._lock_actor` locks the same row `FOR UPDATE`. Two such transactions wait for each other. | Known (code). Seen twice in sample runs. |
| C2 | A short Auth outage signs users out | Auth restarts, times out or answers 5xx while a browser refreshes its session | `refresh_provider_session` revokes the session on `SupabaseAuthUnavailable` and on a fresh token that fails local checks (`provider_sessions.py:409-416`). Auth allows the same refresh token again for 10 s (`GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL`), so a retry can succeed. | Known (code). |
| C3 | File transfers fail when three overlap | Three people upload or download files at the same time on normal networks | Two transfer slots for the whole process (`providers.py`). A slot is held while the client sends the body and while a slow client receives the download (`CapacityResponse`). The count limits requests, not memory. The 5 s wait (F15) only helps on localhost. | Known (code). |
| C4 | Automations run late under load | Many organizations write records at once, a bulk import, or a batch edit | One thread (`openslate-triggers`) runs every trigger event of every organization, one after another (`record_triggers/worker.py`). Each event takes about 10 locks. One organization's burst delays all others. | Known (code). Delay seen (16-21 s); not measured, because the worker logs no queue depth or event time. |
| C5 | Scheduled Reports retry 5 times and fail with no cause | A Report's module or field is archived or purged while its scheduled run is in flight, or the database is under load | `execute_report_claim` catches every exception, logs no detail (`scheduling/execution.py:187-188`), and retries a lost source like a temporary error. | Partly known. The retry of a lost source is a defect in the code. The run 6 exception is not logged. |
| C6 | Comms background jobs fail with no cause | Unknown until logged | `_each_organization` (`platform/scheduling/worker.py:27-44`) and `poll_comms` (`comms/jobs/worker.py:23-42`) drop the exception group with no detail. | Not known. Logging comes first. |
| C7 | Live updates can be lost under load | Many commits at once exhaust database connections | `publish_invalidations` opens a new connection for each commit, outside the pool (`events/publisher.py:37`). On failure it logs no detail and the update is lost with no retry. | Known (code). Effect on the browser is not traced yet. |
| C8 | Throughput limit | A busy installation | One API process; 332 of 346 handlers are synchronous; about one CPU core. Run 6: about 38 requests a second. Record writes cost 46-65 ms (F1, F2). | Known (measured). |
| C9 | Operator session end reaches other organizations | The operator ends all sessions in one organization | For the operator, `revoke_admin_session_collection` skips no shared accounts (`sessions_router.py:296`), so sessions of people in other organizations end too. | Known (code). Decided: the operator acts like an organization administrator. |

Tooling defects, not product defects:

| ID | Defect | Fix |
|---|---|---|
| T1 | The smoke runner commits in its own process with the development `DATABASE_URL`, so its invalidation publish fails (the `publish_failed` lines at the start of each run). | Run those commits with the disposable stack settings. |
| T2 | The 5 s file slot wait (`579e5eb6`, F15) is a workaround. | C3 replaces it. |

Fixes on this branch that stay: F6, F13, the per-organization quota lock (`e161ef14`), the clock allowance (`59b44076`), and the reason-code logging.

## Phases

Phase 1 makes the hidden causes visible. Phase 2 fixes correctness. Phase 3 fixes capacity. Phase 4 measures throughput. Phase 5 checks the whole branch.

### Phase 1: make causes visible

| Step | Change | Files | Test |
|---|---|---|---|
| 1.1 | Log the exception class, SQLSTATE, work ID, report ID and attempt for each failed Report attempt. | `platform/scheduling/execution.py` | Unit: a failed attempt logs these fields and no message text. |
| 1.2 | Log the organization, operation and exception class or SQLSTATE for each failed Comms job and each failed organization pass. | `platform/scheduling/worker.py`, `comms/jobs/worker.py` | Unit: each member of an exception group is logged. |
| 1.3 | Log the exception class, SQLSTATE and phase (connect or statement) of a failed invalidation publish. | `events/publisher.py`, `core/observability.py` allowlist | Unit. |
| 1.4 | Log trigger queue depth, the age of the oldest pending event, and the time per event, once each interval. | `record_triggers/worker.py` | Unit. |
| 1.5 | Fix T1. | `tests/smoke_runner.py` | Unit: runner commits use the disposable settings. |

Exit: one seven-pack Small run with the new logging, as a diagnostic probe. The run is evidence only, not acceptance, and no fix is sized to it. Record the causes of C5 and C6 and the trigger queue numbers for C4. Then update this plan with the causes before Phase 2 starts on C5 and C6.

### Phase 2: correctness

| Step | Item | Fix | Test (real trigger) |
|---|---|---|---|
| 2.1 | C1 | Serialize the confirmation attempt counter with a per-administrator transaction advisory lock, and check that the actor exists with a plain read. The user row is then never upgraded. Check every caller of `_lock_actor` and `begin_verification` for lock order first. Why not take the exclusive row lock first: photo reads lock the same row `FOR SHARE NOWAIT` (PD67) and would start to fail during every confirmation. | PostgreSQL: two confirmations by one administrator at the same time. Before the fix, one fails with SQLSTATE 40P01. After the fix, both succeed in turn. Keep the existing rate-limit tests green. |
| 2.2 | C2 | On `SupabaseAuthUnavailable`, keep the session and answer 503 with `Retry-After`. On a fresh token that fails local checks, keep the session and answer 503; the next refresh inside the 10 s reuse window gets a new pair. Revoke only on a definite refusal (`provider_refused`, identity mismatch, missing or unreadable tokens). Check the frontend: if the auth adapter treats any failed refresh as signed out, the server fix changes nothing for the user. Make it retry a 503 after `Retry-After`. Show nothing for the first 5 s; after that, show a small "Reconnecting…" banner until the refresh works. | Unit: Auth unavailable, then available: the session survives and the second refresh succeeds. Unit: a definite refusal still revokes. Frontend test: a 503 refresh retries and keeps the user signed in. |
| 2.3 | C5 | Treat a lost source (404, 409, 422 from capture) as final and cancel the work as `source_unavailable`. The run shows "Canceled: source removed" in the Report's history, and the Report's owner gets one notification. Retry only database and infrastructure errors. Fix the Phase 1 cause if it is a different one. | PostgreSQL: archive the module while a scheduled run is claimed; the work is canceled once, not retried; the history row and one owner notification exist. |
| 2.4 | C6 | Fix the cause that Phase 1 shows. | Test for that cause. |
| 2.5 | C9 | The operator acts like an organization administrator: "end all sessions" skips accounts that belong to other organizations and reports the count. | Integration: the operator ends sessions in one organization; a shared account keeps its session. |
| 2.6 | Operator review | List every place where the operator differs from an organization administrator (for example account restore and organization listing), with the file and the reason. Bring the list to you. Change nothing else until you decide each one. | None until decided. |

Security (SEC-R6): 2.1 keeps the confirmation attempt limits, their keys and their windows. 2.2 keeps every check on a refresh, and changes only when a session is revoked. Each commit states this.

### Phase 3: capacity

Design first. Each design comes back for approval before code.

| Step | Item | Design | Test (real trigger) |
|---|---|---|---|
| 3.1 | C3 | Two limits instead of one. (a) A memory budget in bytes for request bodies and download bodies in memory, reserved from `Content-Length` or the file size before the bytes are read. (b) Processing slots only for file validation and Storage I/O, taken after the body is in memory and released before a slow client receives the response. Remove the F15 wait. If `Content-Length` is absent (chunked body), reserve the route maximum; if the body grows past the declared size, refuse it with 413. The upload and download UI retries a 503 `files_busy` after `Retry-After`. While it retries, the file row shows "Waiting for the server…"; after about 30 s it shows an error. The budget and the slot counts are settings; the defaults need your approval. | ASGI tests with a client that sends 10 MiB at a slow rate: a slow sender holds only its budget, and other transfers proceed. Budget full: 503 `files_busy` with `Retry-After`. Memory never goes above the budget. A missing or false `Content-Length` cannot exceed the budget. Frontend test: an upload that gets 503 retries. |
| 3.2 | C4 | Target: an automation runs within 2 s of the record change at the mid-size target. Use the Phase 1 numbers to size the work. Option: several trigger threads that claim with the existing `FOR UPDATE SKIP LOCKED`, while events for one record stay in order. Option: lower the cost per event (fewer locks when no trigger matches). Pick from the measurements. | PostgreSQL: several organizations enqueue events at once; the oldest event age stays under 2 s; events for one record stay in order. |
| 3.3 | C7 | Publish through a small bounded connection pool instead of one new connection per commit. Trace what the browser does when an update is lost (resync on reconnect, or none) and close the gap if there is one. | Unit: no new connection for each commit. A failed publish is logged with its SQLSTATE. Browser test if the resync gap is real. |

### Phase 4: throughput

| Step | Item | Work |
|---|---|---|
| 4.1 | C8 | Measure 1, 2 and 3 API worker processes. First check what changes per process: transfer budget (C3), trigger threads (C4), SSE hub and `LISTEN`, and the database pool times processes against PostgreSQL `max_connections`. |
| 4.2 | C8 | Profile `POST /api/records`, `PATCH /api/records/{id}` and `POST /api/relationships` at Large volume (F2). |

Exit: recorded numbers. Production uses the measured best worker count for 8 cores and 16 GB, set in the production Compose file. Record the memory and database connections per worker.

### Phase 5: check the branch

1. Run the focused batches for each changed area once, one lane at a time.
2. Run the seven Small packs once as a regression check, with no fix sized to the run.
3. Run a hands-on pass for the changed user flows: purge confirmation, session refresh, file upload and download.
4. Run the pre-push gate (`prepush.py --serial`) on a freed machine when you decide to push.

## Decisions

| Item | Decision |
|---|---|
| Target | Mid-size: 8 cores, 16 GB, about 300 people active at once. |
| Delivery | All phases on `sample-pack-realism-p1`, one pull request. |
| C2 | Users stay signed in through a short Auth outage. Quiet for 5 s, then a "Reconnecting…" banner. |
| C3 | When the budget is full, the file row shows "Waiting for the server…", then an error after about 30 s. Budget and slot defaults come with the design for approval. |
| C4 | An automation runs within 2 s at the target. |
| C5 | A lost source shows "Canceled: source removed" in history, and the owner gets one notification. |
| C8 | Production runs the measured best number of API workers. |
| C9 | The operator acts like an organization administrator when it ends sessions. |
| Operator | List every other operator exception for your decision (step 2.6). |

Still open: the C3 defaults and the C4 design, after measurement.

## Out of scope

- Rate-limit numbers and new limits. The rate-limit plan (`docs/plans/api-rate-limits.md`) owns them.
- Large and permanent sample runs. They wait for your word.
- Push and pull request. They wait for your word.
