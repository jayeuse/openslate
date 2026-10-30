# Product concurrency fixes

Status: Phases 1 and 2 implemented (2026-10-29), not pushed. Phase 3 designs approved. Branch: `sample-pack-realism-p1`, one pull request.

Done means every phase below is complete in order, and the seven Small packs pass and are populated in the development database in Phase 5. Pack runs use two organizations at a time.

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
| C3 | File transfers fail when three overlap | Three people upload or download files at the same time on normal networks | Two transfer slots for the whole process (`providers.py`). A slot is held while the client sends the body and while a slow client receives the download (`CapacityResponse`). The count limits requests, not memory. The workspace logo save takes a slot with no wait and failed with 503 in the probe (FMCG distributor). | Known (code). |
| C4 | Automations run late under load | Many organizations write records at once, a bulk import, or a batch edit | One thread (`openslate-triggers`) runs every trigger event of every organization, one after another (`record_triggers/worker.py`). One organization's burst delays all others. | Known and measured (probe, 2026-10-29): 35 ms per event, about 22 events a second, median wait 5.6 s, worst 36 s; target 2 s. School failed on it. |
| C5 | Not a defect | An administrator archives a module or field, restores it, and retries the failed job from Jobs | Five retries, then "failed" with a retry action, is the designed Jobs flow. The probe's 30 `http_409` attempts were the sample Jobs control. | Withdrawn: a cancel change broke the retry and was dropped. |
| C6 | Comms exports fail under load | Exports run while file transfers are busy | The export job took a transfer slot with no wait. The refused slot (503) marked the export FAILED. Two minutes later the cleanup of its never-uploaded artifact could not confirm absence, and `export_worker.py:308` raised the `ProviderUnavailable` that the probe logged as `exports:ProviderUnavailable`. Storage did not fail. | Known (code). C3 makes the export wait for a slot. |
| C7 | Live updates can be lost under load | Many commits at once exhaust database connections | `publish_invalidations` opens a new connection for each commit, outside the pool (`events/publisher.py:37`). On failure it logs no detail and the update is lost with no retry. | Known (code). Fixed: one publisher thread per API process; a lost publish becomes one `resync`. The browser trace found a follower tab that missed the refetch after a leader handoff; fixed. |
| C8 | Throughput limit | A busy installation | One API process; 332 of 346 handlers are synchronous; about one CPU core. Run 6: about 38 requests a second. Record writes cost 46-65 ms (F1, F2). | Known (measured). |
| C9 | Operator session end reaches other organizations | The operator ends all sessions in one organization | For the operator, `revoke_admin_session_collection` skips no shared accounts (`sessions_router.py:296`), so sessions of people in other organizations end too. | Known (code). Decided: the operator acts like an organization administrator. |
| C10 | Comms restore confirmation fails (503) | Many people sign in or confirm with a password at the same time while old rate-limit buckets expire (a busy morning) | The password check runs `cleanup_expired_buckets`, which locked expired identity rate-limit buckets `FOR UPDATE` in window order on its own connection, while sign-in, MFA and recovery lock their account and source buckets in key order. Opposite orders deadlock; PostgreSQL ends one side after `deadlock_timeout` (1 s), and the password check turns the database error into 503. Probe: the restore failed after 1,043 ms with no database 503 logged. | Known (code and test). Fixed: cleanup skips buckets another transaction holds (`SKIP LOCKED`). |
| C11 | Installation security save fails (503) | The installation owner changes the session timeout while any administrator publishes the Sandbox, or while the owner's other tab refreshes the session | The save locked every unrevoked session in the installation with `NOWAIT`, and the caller's own session, after the organization row. A Sandbox publication holds its actor's session row for the whole publication; a refresh, a sign-in and an MFA step hold theirs while they run. The 503 logged no cause. School run: 503 after 310 ms while three publications of other packs ran. | Known (code, log and test). Fixed: the save takes the session locks with a normal wait, before the organization row, and logs the cause of every 503. |
| C12 | A request can fail with no response on a reused connection | A client or proxy reuses an idle keep-alive connection at the moment the API closes it | uvicorn closes an idle connection after `SERVER_KEEP_ALIVE_SECONDS` (5 s). Caddy kept idle upstream connections for its 2-minute default and replays only idempotent requests, so a POST or PATCH on a just-closed connection fails with 502; the sample client used httpx's 5 s default, the same as the server. Seen as a transport error on a board file read with four packs at once. | Fixed: Caddy's FastAPI upstreams use `keepalive 3s`, and the sample client expires idle connections after 2 s. |
| C13 | Deleting or purging records with relationships is slow at volume | A reset, a purge, or a lifecycle delete of many records whose module has relationship fields | `relationship_edges` had only partial indexes led by `field_id`, so each record's source and target foreign-key checks scanned every edge. Large Harbor and School: deleting 44,736 records took 53.7 s and broke the guarded reset's 30 s statement limit (`QueryCanceled`). | Fixed: plain `(org_id, source_record_id)` and `(org_id, target_record_id)` indexes (migration `48e05d7138d7`); the same delete takes 1.1 s. Test: `test_every_foreign_key_into_records_has_a_usable_index`. |

Tooling defects, not product defects:

| ID | Defect | Fix |
|---|---|---|
| T1 | The smoke runner commits in its own process with the development `DATABASE_URL`, so its invalidation publish fails (the `publish_failed` lines at the start of each run). | Run those commits with the disposable stack settings. |
| T3 | Harbor's readback of security events raced the other packs: the operator's sign-ins in other organizations grew the list between pages. | Read the closed window up to the end of population (`occurred_before`). The MFA and host-export readbacks had the same open-ended read (Clinic, seven packs at once, 2026-10-30) and now use the shared `list_security_events` closed window. |
| T4 | The Chart control's final check failed when the reorganization phase, picked at random by seed, archived and restored the same department Dashboard after the control had certified it (Local government, FMCG distributor, School). | The check allows only that planned archive and restore: every field must still match, and the revision may only move forward. |
| T5 | Sample populate runs logged `realtime_invalidation_failure` (`publish_failed`, `OperationalError`) on every commit the seeder makes in its own process. Its owner engine had an empty URL (`operations/sample/organization.py`), so the audit listener's post-commit publish (the T1 rule) connected to no database. | The engine carries the owner database URL; the verified creator still opens each connection. Test: `test_pack_organization_writes_publish_to_the_database_they_commit_to`. |
| T7 | Harbor stopped at its baseline with "No authored record exercises trigger urgent-request-created" for 39 of 200 seeds. The rule needs an Open, Urgent service request, and status and priority were drawn separately; seeds 62 and 101 had no Open request at all. | Service request 2 is pinned Open and Urgent in every seed (`URGENT_REQUEST`). Test: `test_every_seed_authors_a_record_for_each_created_trigger` (every pack, 43 seeds). |
| T8 | Large Harbor and School stopped at `restore_guest` with 401 `refresh_session_expired`. The operator's client sat idle for 79 minutes, past the 60-minute session timeout; Small runs finish sooner. | The sample client keeps its sign-in in memory and, when a refresh is refused after at least 15 idle minutes (the shortest allowed timeout), signs in again once, as a person does. A refusal after recent use still stops the step. Test: `test_a_session_that_expired_while_idle_signs_in_again_once`. |
| T6 | Clinic's admin phase disabled a person whom the account and Comms partner controls had added to the partner organization, so the disable changed only the membership and kept the sessions (picked by seed; Harbor and School can meet it too). | The phase plan excludes the partner members from its disable and session-end targets; the checks are unchanged. |

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

Result (2026-10-29, 18.8 min): 3 of 7 packs passed (Clinic, Harbor, Nonprofit). School stopped on C4, FMCG distributor on C3, Manufacturer on C6, and Local government on C10. The causes are recorded in the table above.

### Phase 2: correctness

| Step | Item | Fix | Test (real trigger) |
|---|---|---|---|
| 2.1 | C1 | Serialize the confirmation attempt counter with a per-administrator transaction advisory lock, and check that the actor exists with a plain read. The user row is then never upgraded. Check every caller of `_lock_actor` and `begin_verification` for lock order first. Why not take the exclusive row lock first: photo reads lock the same row `FOR SHARE NOWAIT` (PD67) and would start to fail during every confirmation. | PostgreSQL: two confirmations by one administrator at the same time. Before the fix, one fails with SQLSTATE 40P01. After the fix, both succeed in turn. Keep the existing rate-limit tests green. |
| 2.2 | C2 | On `SupabaseAuthUnavailable`, keep the session and answer 503 with `Retry-After`. On a fresh token that fails local checks, keep the session and answer 503; the next refresh inside the 10 s reuse window gets a new pair. Revoke only on a definite refusal (`provider_refused`, identity mismatch, missing or unreadable tokens). Check the frontend: if the auth adapter treats any failed refresh as signed out, the server fix changes nothing for the user. Make it retry a 503 after `Retry-After`. Show nothing for the first 5 s; after that, show a small "Reconnecting…" banner until the refresh works. | Unit: Auth unavailable, then available: the session survives and the second refresh succeeds. Unit: a definite refusal still revokes. Frontend test: a 503 refresh retries and keeps the user signed in. |
| 2.3 | C5 | Withdrawn and reverted: canceling a lost source removed the administrator's retry after a restore. | The sample Jobs control covers the flow. |
| 2.4 | C6, C10 | Logging done. C6 is C3. C10: expired-bucket cleanup deadlocked with sign-ins; cleanup now skips held buckets. Log the Storage failure kind (HTTP status class or timeout) in `supabase_storage.py` and the password-check failure kind in the lifecycle password client. Then fix the cause they show, with a test for it. | Unit tests for the new fields; then a test for the cause. |
| 2.5 | C9 | The operator acts like an organization administrator: "end all sessions" skips accounts that belong to other organizations and reports the count. | Done. Integration: the operator ends sessions in one organization; a shared account keeps its session. |
| 2.6 | Operator review | Dropped: not a pack blocker. | None. |

Done in Phase 2: 2.1 (`0083e006`), 2.2 (`d8546496`, `abf6ee6f`), 2.4 logging (`9b4fd929`), 2.5 (`be4ac8b8`).

Security (SEC-R6): 2.1 keeps the confirmation attempt limits, their keys and their windows. 2.2 keeps every check on a refresh, and changes only when a session is revoked. Each commit states this.

### Phase 3: capacity

Proposed designs with their defaults. Approving this plan approves them; no second approval stop.

| Step | Item | Design | Test (real trigger) |
|---|---|---|---|
| 3.1 | C3 | Defaults: memory budget 256 MiB per API process (25 uploads of 10 MiB at once), 4 processing slots, `Retry-After: 1`. Settings `FILE_MEMORY_BUDGET_MIB` and `FILE_PROCESSING_SLOTS`. The logo and avatar saves use the same budget and slots, so the FMCG logo failure goes away with the cause. Two limits instead of one. (a) A memory budget in bytes for request bodies and download bodies in memory, reserved from `Content-Length` or the file size before the bytes are read. (b) Processing slots only for file validation and Storage I/O, taken after the body is in memory and released before a slow client receives the response. If `Content-Length` is absent (chunked body), reserve the route maximum; if the body grows past the declared size, refuse it with 413. The upload and download UI retries a 503 `files_busy` after `Retry-After`. While it retries, the file row shows "Waiting for the server…"; after about 30 s it shows an error. The budget and the slot counts are settings; the defaults need your approval. | ASGI tests with a client that sends 10 MiB at a slow rate: a slow sender holds only its budget, and other transfers proceed. Budget full: 503 `files_busy` with `Retry-After`. Memory never goes above the budget. A missing or false `Content-Length` cannot exceed the budget. Frontend test: an upload that gets 503 retries. |
| 3.2 | C4 | Measured: one thread, 35 ms per event, about 22 events a second, organizations served one after another (`record_triggers/worker.py:73-94`). A client server usually holds one organization, so spreading organizations over threads alone does not help one organization's burst. Design: (a) 4 trigger threads (setting `TRIGGER_WORKERS`, default 4), each claiming from the shared queue with the existing `FOR UPDATE SKIP LOCKED`. (b) Order per record: the claim skips an event when an earlier pending or running event of the same `record_id` exists (`NOT EXISTS` on `record_trigger_events`), so one record's events never run in parallel or out of order. (c) Before code, profile the 35 ms; if most of it is locks or reads when no trigger matches, skip enqueue for modules with no enabled trigger. Estimate: about 90 events a second (4 × 22, no database contention assumed); the failing-first test measures the real number against the 2 s target. | PostgreSQL: several organizations enqueue events at once; the oldest event age stays under 2 s; events for one record stay in order. |
| 3.3 | C7 | Design: one publisher thread per API process with a bounded queue (1,024 events). Each queue item carries the `database_url` its transaction committed to (the T1 fix), and the publisher keeps one long-lived autocommit connection per distinct URL; production has one. A commit puts its invalidations on the queue and returns; it opens no connection. This makes the publish asynchronous: tests that expect a NOTIFY right after a request get a drain hook. If the queue is full or a publish fails, the publisher reconnects and sends one `resync` invalidation, so open browsers refetch instead of losing the update. No new dependency (`psycopg_pool` is not installed). Then trace the browser's handling of `resync` and of an SSE reconnect, and close the gap if there is one. | Unit: 200 commits open no connection each. A failed publish is logged with its SQLSTATE and is followed by one `resync`. PostgreSQL: a subscriber receives every invalidation of 200 concurrent commits, or a `resync`. Browser test if the gap is real. |

Done in Phase 3: 3.1 (`22143a1b`, `593910d4`), 3.2 (`22143a1b`), 3.3.

### Phase 4: throughput

| Step | Item | Work |
|---|---|---|
| 4.1 | C8 | Measure 1, 2 and 3 API worker processes. First check what changes per process: transfer budget (C3), trigger threads (C4), SSE hub and `LISTEN`, and the database pool times processes against PostgreSQL `max_connections`. |
| 4.2 | C8 | Profile `POST /api/records`, `PATCH /api/records/{id}` and `POST /api/relationships` at Large volume (F2). |

Exit: recorded numbers. Production uses the measured best worker count for 8 cores and 16 GB, set in the production Compose file. Record the memory and database connections per worker.

Result 4.1 (2026-10-29): `API_WORKERS` (default 1, range 1 to 8) is read by `app/__main__.py` and passed to Uvicorn; the smoke runner passes it through. Audit: every background claim takes a row lock (`SKIP LOCKED` or `FOR UPDATE` with a state recheck), an advisory lock or a unique key, and SSE `LISTEN` and the invalidation publisher are per-process broadcast, so they stay correct with several processes; they multiply connections, threads and memory. One item was wrong with several processes: the provider-account cache is per process, so a factor verified in one process stayed hidden in the others for up to 10 s. Fixed: a cached account without a verified factor is not reused when the person's committed MFA observation records one (`test_a_factor_verified_in_another_api_process_requires_aal2_on_the_next_request`). Measured with `tests.smoke_runner --seed-only --parallel --packs harbor,school`, defaults otherwise (4 automation threads per process), all packs passed:

| Workers | Seeding s | Requests | Requests/s | p50 / p99 ms (Harbor, School) | Peak API RSS | Peak `openslate_runtime` conn. | Peak client conn. |
|---|---|---|---|---|---|---|---|
| 1 | 690 | 18,225 | 26.4 | 27/240, 27/213 | 309 MB | 11 | 22 |
| 1 (repeat) | 804 | 18,203 | 22.6 | 30/245, 28/251 | 286 MB | 11 | 20 |
| 2 | 939 | 18,254 | 19.4 | 46/339, 43/288 | 590 MB | 17 | 27 |
| 3 | 827 | 18,199 | 22.0 | 38/324, 37/291 | 740 MB | 25 | 35 |

Per worker: about 250–300 MB, and at most `DATABASE_POOL_SIZE` + `DATABASE_MAX_OVERFLOW` + 3 connections (13 with 5 + 5; 13, 26, 39 for 1, 2, 3 workers) against `max_connections` 100 (3 reserved), with the provider services at about 10–13 more. The machine has 4 performance cores (10 in all) and runs PostgreSQL, Auth, Storage, Caddy and both seeding clients beside the API, so the result cannot separate contention from core starvation. Two packs offer only a few requests at a time, and one process was not saturated (p50 27–30 ms): extra workers added only overhead (4 automation threads and the pollers per process). Production keeps `API_WORKERS=1` in `compose.production.yaml`. The evidence does not support more on the 8-core target; measure again with a load that saturates one process before raising it.

4.2 results (2026-10-29, development database holding Harbor Standard, profiled during School Small; cProfile in 3.14 also samples other threads, so treat shares as approximate): `POST /api/records` 1,246 calls, 22 SQL statements and 18 ms of SQL per call; `PATCH /api/records/{id}` 1,000 calls, 20 statements and 17 ms; `POST /api/relationships` 2,265 calls, 13 statements and 10 ms. SQL and its waits are about 60% of handler time. Top costs inside a record create: `module_reader_ids` (`access/policy/readers.py:58`, about 2 calls and 4 ms per create), `notify_record_assignments` (`records/assignment_notifications.py:31`, about 4 ms), `_module_fields` (`records/router.py:180`, about 2 calls and 3 ms) and the commit (about 3 ms). Candidates, not fixed: the per-call reader and field lookups repeat for every record of one module, and 22 statements per create is high for one row plus audit. No full-table scan was seen.

4.2 change (2026-10-29): each record create and edit reads the module's readers and fields once, and passes the readers to validation, assignment notifications and the response labels; the labels keep each field's type, so the commit no longer forces a second field read. A new link checks duplicate and cardinality in one locked read. Authorization checks, audit rows, trigger events, notifications and invalidations are unchanged, and nothing is cached across requests. Statements per call in `tests/relationships_integration/test_statement_budgets.py` (person, choice and one-to-many link fields; authentication overridden): `POST /api/records` 21 to 16, `PATCH /api/records/{id}` 22 to 17, `POST /api/relationships` 14 to 13 (one-to-one links save 2). Remaining candidates, not changed: the audit listener's redacted-field and link-module reads (`manage/audit/listeners.py:78`, `:102`), the reader query's separate department lookup (`readers.py:63`), and the batch-update route reading readers once per item.

### Phase 5: check the branch

1. Run the focused batches for each changed area once, one lane at a time.
2. Guarded reset of development data, then populate the seven Small packs into the development database, two at a time, with no fix sized to the run. A real defect a pack exposes gets the same treatment as C1: cause, failing-first test, fix.
3. Run a hands-on pass for the changed user flows: purge confirmation, session refresh, file upload and download.
4. Run the pre-push gate (`prepush.py --serial`) on a freed machine when you decide to push.

## Decisions

| Item | Decision |
|---|---|
| Target | Mid-size: 8 cores, 16 GB, about 300 people active at once. |
| Delivery | All phases on `sample-pack-realism-p1`, one pull request. |
| C2 | Users stay signed in through a short Auth outage. Quiet for 5 s, then a "Reconnecting…" banner. |
| C3 | When the budget is full, the file row shows "Waiting for the server…", then an error after about 30 s. Defaults in step 3.1. |
| C4 | An automation runs within 2 s at the target. Design in step 3.2. |
| C5 | Withdrawn; the existing retry flow stays. |
| C8 | Production runs the measured best number of API workers. |
| C9 | The operator acts like an organization administrator when it ends sessions. |

## Out of scope

- Rate-limit numbers and new limits. The rate-limit plan (`docs/plans/api-rate-limits.md`) owns them.
- Large and permanent sample runs. They wait for your word.
- Push and pull request. They wait for your word.
