# System health for the people who use Slate Operations

> **Status: S1 to S4 built (2026-11-03); S5 and S6 in progress (2026-11-05).** The Human Owner answered "Approve S1 and S2" to the go-ahead question on 2026-11-02. Client side only. The developer side of observability (error tracking, uptime checks, metrics, traces, log search) is deferred until this spec ships; see [Deferred](#deferred).

## Outcome

Every signed-in person can open **Manage → System health** and see, in plain sentences, whether Slate Operations works for them now, which version runs, and how to report a failure. Each role sees every signal that belongs to its scope, and nothing from outside it:

| Role | Sees |
|---|---|
| Member and guest | The status of each part of Slate Operations, the version, and how error references work. Later slices add their own sign-in history and the history of records they can read. |
| Organization admin | All of the above, plus their organization's backup freshness, failed jobs, and sign-in activity (links into the pages that already hold them). |
| Installation owner (`PlatformOperator`) | All of the above, plus installation-wide signals: disk, database size, and background worker liveness (slice 4). |

When the server does not answer, the page cannot tell anyone anything, because FastAPI serves the page. So the app shell shows its own banner when requests fail (S2).

**Owner decisions (2026-11-02).**

- Members and guests see status, version and error references. They also see their own sign-in history and the history of records they can read. The record-history change widens audit visibility (`docs/architecture/10-audit-and-history.md`), so it is its own slice.
- Organization admins see backup freshness: the status word, the time and the result only.
- Plan usage is dropped until plans or seats exist. Slate Operations has no seats and no organization storage quota (`frontend/src/components/systems/manage/domain/updates-rules.ts:11-12`).
- Slice 1 shows current status only. The history timeline comes later, with stored samples.

**Owner decisions for S3 to S6 (2026-11-03).**

- S3 backups: late when no successful backup ran since the last due time plus 1 hour. With no schedule, the block says "No backup schedule".
- S3 sign-in activity: counts of failed sign-ins and lockouts in the last 7 days, plus a link to Access → Security.
- S3 failed jobs: only job kinds the admin already sees in Manage → Jobs (backup jobs count for the installation owner only).
- S3 block: organization admins only; department managers do not get it.
- S4 readable records: the same read check that opens a record, so records reached through a cross-department link count.
- S4 history detail: who, when, field, old and new value, only for fields the person can read.
- S4 own sign-in history: in Settings → Sessions, listing successful sign-ins, failed attempts, lockouts and ended sessions.
- S5 samples: every minute, kept 30 days. "Slow": a part's check takes longer than 1 second on 3 samples in a row.
- S5 timeline: everyone sees it (the parts reveal nothing about other organizations, R4).
- S5 storage: no host disk figure. Organization admins see their organization's file storage in use (from its file records) and "Storage limit: not set yet", a placeholder for the planned per-organization limit.
- S5 email: record send results, so the Email part shows Working or Not working from real sends. Status emails that people opt in to are a later feature.
- S6 diagnostics: one JSON file with a summary at the top. The installation owner gets versions, database size, worker heartbeats, samples and recent server errors (reference, status, route template; no record IDs or record data). An organization admin gets versions, the parts timeline, their organization's storage and its own server errors only (R4).
- Also in this round: the D4 item 6 wording for admins and the owner, and D4 item 7, finding Audit and Security events by the 8-character reference.
- Kept out: the changelog and maintenance notices; the page name stays "System health".
- Delivery: two pull requests (S3 and S4, then S5 and S6), fast checks locally with CI as the full gate, and QA recreates the School testing accounts for the reader and writer levels.

**Out of scope.**

- Developer observability (see [Deferred](#deferred)).
- Maintenance notices and a changelog. Both need an authoring flow, which makes them a separate feature.
- A status page hosted outside the installation.
- New settings. Cache time, sample interval and retention are fixed constants.

**Preserved behavior.**

- `/api/health` and `/api/ready` keep their responses and stay unauthenticated. The Compose and runner health checks depend on them.
- Backup, Updates & licensing, Audit, Jobs and Access → Security keep their pages, access rules and URLs. System health links to them and does not copy their lists.
- Manage → Organization stays the default Manage tab.
- No "Checking…" curtain. Status loads in the page frame and refreshes in the background.

## Current state (checked 2026-11-02)

| Signal | Today | Source |
|---|---|---|
| Readiness | Database, auth, storage, smtp (configuration only). Unauthenticated. Not called by the frontend. Concurrent callers share one in-flight probe; no result cache. | `backend/app/core/readiness.py:51-165`, `backend/app/main.py:261-274` |
| Request ID | uuid7 per request, sent as `X-Request-ID`, written to logs, audit and security events. Error bodies carry `detail` only. The frontend never reads the header. | `backend/app/core/middleware/request_context.py`, `backend/app/request_middleware.py`, `frontend/src/lib/api.ts:222-231` |
| Unreachable server | A failed fetch becomes "Could not connect…" inside the failing control. No shell banner. | `frontend/src/lib/api-errors.ts:7`, `frontend/src/components/session-connection-status.tsx` |
| Version | Hardcoded `0.1.0`. `/api/version` is installation-owner only. | `backend/app/main.py:169`, `backend/app/systems/manage/backups/router.py:245-262` |
| Backups | `BackupRun` state, `finished_at`, `verified_at`; runner `stale` after 5 minutes. Installation owner only. | `backend/app/systems/manage/backups/models.py`, `service.py:185-203`, `router.py:122-127` |
| Failed jobs | `GET /api/jobs` with states and failure labels. Verified admin only; backup jobs hidden from non-owners. | `backend/app/systems/manage/jobs/router.py:48-95` |
| Sign-in activity | Org security events and all sessions: admin. Own active sessions: everyone. Own sign-in history: nobody. | `backend/app/systems/manage/audit/router.py`, `backend/app/systems/access/users/sessions_router.py` |
| Record history | Admin (organization) and department manager (their departments). | `backend/app/systems/manage/audit/router.py:61-69`, `frontend/src/components/systems/openview/components/record-history-panel.tsx` |
| Server resources, worker liveness | Not measured. Only the backup runner reports `runner_last_seen_at`. | `docs/architecture/18-observability.md` "Monitoring gaps" |

## Rules

**R1. Plain parts, not services.** The page names what a person does, never a service: "Saving and loading your data" (database), "Signing in" (auth), "Files and pictures" (storage), "Email" (smtp). No service names, hosts, ports, SQL or stack traces appear anywhere.

**R2. Status words, with an icon and the word.** Never color alone.

| Word | Meaning | Source in slice 1 |
|---|---|---|
| Working | The probe passed. | readiness `ready` |
| Not working | The probe failed or timed out. | readiness `unavailable` |
| Not set up | The part is not configured on this installation. | readiness `not_configured` |
| Set up | Configured, but Slate Operations cannot test it yet (email only). | smtp `ready` |

Email is a special case. Readiness checks only that email is configured (`readiness.py:167-171`), not that mail is delivered. Until S5 records send failures, the Email row says "Set up" with the line "Slate Operations cannot yet confirm delivery", never "Working". From S5, the Email row follows real send results (S5-C5, D16); this paragraph describes S2.

"Slow" needs a measured latency, so it arrives with stored samples (S5), not before.

**R3. One headline sentence.** It answers "does Slate Operations work for me?" first. Examples: "Slate Operations is working normally." or "Email is not working. Everything else works." It carries the check time: "Checked at 10:42".

**R4. Scope never widens through this page.** Installation-wide figures (disk, database size, workers, other organizations) go to the installation owner only. Readiness parts are shared by every organization and reveal nothing about the others, so everyone sees them.

**R5. Every error message carries a reference.** Format: "Reference 4f9c2e1a" (the last 8 characters of `request_id`), with a Copy button that copies the full ID. A sentence under the reference explains how to use it: "Give this reference to your administrator." Admins can search Audit and Security events by the full ID or the 8-character reference (D7).

**R6. No raw diagnostics for non-owners.** No graphs for members and admins; sentences and status words only (the reference's "do not frighten an older business owner" rule).

## Page layout (`/manage?view=health`)

Reading order, one column, readable width, the slim Manage grammar. On a phone the same order stacks with no horizontal scroll.

1. **Headline.** The R3 sentence, the check time, and a "Check again" button. The page also refreshes every 60 seconds while visible and when the window regains focus.
2. **Parts of Slate Operations.** One row per part (R1): name, status word with icon (R2), one plain line of cause when it does not work, for example "Messages that need email, such as invitations, wait until email works."
3. **Your organization** (admin only).
   - Backups: "Last backup today at 02:00 · verified" or "No backup in the last 2 days". Status word, time and result only.
   - Failed jobs: "2 jobs failed in the last 7 days", linked to Manage → Jobs.
   - Sign-in activity: a link to Access → Security.
4. **Installation** (installation owner only, S5): database size and background workers. Host disk was dropped by the owner on 2026-11-03.
5. **About this system.** Version, plus the release-notes link for the installation owner as today.
6. **When something goes wrong.** Two sentences on error references (R5), and what to do when Slate Operations does not load: "Wait a minute and reload. If it still does not load, tell your administrator." From S6, admins and the owner also get "Download support file" here (D19).

**Shell banner (S2).** When requests fail with no response, a banner shows at the top of the app: "Slate Operations cannot reach its server. Changes you make now may not save. It tries again on its own." It clears on the next success. It is a banner, not a curtain, and it does not block the page.

## Slices

| Slice | Delivers | Backend change (needs go-ahead) | Proof |
|---|---|---|---|
| **S1 Error references** | R5 in every error message and toast. | `request_id` added to every error JSON body (wire-format change). | Backend test: a 4xx, 422 and 5xx body each carry the request's ID, equal to `X-Request-ID`. Frontend isolated test: `ApiError` keeps the ID and the message shows it; copy copies the full ID. |
| **S2 Status now** | The page (blocks 1, 2, 5, 6) for every role; the Manage tab for everyone; the shell banner. | `GET /api/system/status` for any signed-in person: parts with status words, version, check time. Reads readiness behind a 30 s cache. | Backend test per role (member, guest, admin) and a forced-unavailable part. Isolated UI tests for each status word and the banner. Hands-on at 1440 and 390. |
| **S3 Organization block** | Block 3 for admins. | The status response gains an admin-only `organization` part: last backup time and result against the schedule, failed-job count for 7 days, failed sign-in and lockout counts for 7 days. Backup data is installation-wide in storage; the response gives only the freshness of backups. | Backend test: admin gets it, member and guest do not; a non-owner admin gets no sizes, paths or run lists. Hands-on as an admin in two organizations. |
| **S4 Personal history** | Everyone sees their own sign-in history in Settings → Sessions; readers see the history of records they can read, limited to readable fields. | A self-only sign-in history endpoint over security events. Audit list visibility widened to records the caller can read (policy change in `docs/architecture/10-audit-and-history.md`). | Backend tests for denial outside the caller's scope. Hands-on as reader, writer, guest and no-access. |
| **S5 History and installation** | The timeline ("Email did not work for 12 minutes on Tuesday"), the "Slow" word, and block 4. | A sampler worker, a `system_health_samples` table with no organization column, heartbeats in the record-trigger, scheduling and Comms job workers, a database-size probe, recorded email send results, an organization storage sum, and a stored server-error log for S6. | Backend and PostgreSQL tests; hands-on as owner and as a non-owner admin. |
| **S6 Diagnostics export** | The installation owner, and an organization admin for their own organization, download a JSON support file: versions, resource values, recent errors by reference. No record data. | Export endpoint for the owner and for organization admins, scoped by R4. | Before the first on-premise install. |

S1 and S2 are independent and can run in parallel. S3 needs S2. S4 and S5 need S2.

## Acceptance criteria (S1, S2)

Tests and reviews cite these IDs.

**S1 Error references**

- **S1-C1.** Every error JSON response carries a top-level `request_id` beside `detail`, equal to that response's `X-Request-ID` header: `HTTPException` 4xx, 422 validation, middleware refusals (body size, rate limit), 503 database unavailable, and 500 unexpected. `detail` keeps its current shape.
- **S1-C2.** Success response bodies do not change.
- **S1-C3.** The frontend `ApiError` keeps the request ID: from the body, else from the `X-Request-ID` header.
- **S1-C4.** Every error message and toast that shows an API error shows "Reference" with the last 8 characters, a Copy control that copies the full ID, and the R5 sentence. The Copy control has an accessible name, and its confirmation is announced.
- **S1-C5.** A failure with no response (no request ID) shows no reference and no empty placeholder.
- **S1-C6.** No error message shows a stack trace, SQL, a service name, a host or a port (R1, R6).

**S2 Status now**

- **S2-C1.** `GET /api/system/status` answers every signed-in person of the bound organization (admin, member, guest, member with no group access) with the four R1 parts and their R2 status words, the version, and the check time. A request with no session gets 401.
- **S2-C2.** The endpoint probes readiness at most once in 30 seconds per process and returns the time of the probe it used.
- **S2-C3.** The Email part is "Set up" or "Not set up" or "Not working", never "Working" (R2). S5-C5 replaces this from S5: Email reads Working after a real successful send.
- **S2-C4.** The response and the page contain no service names, hosts, ports, error strings, or data of another organization (R1, R4).
- **S2-C5.** Manage → System health (`/manage?view=health`) shows for every role. Manage → Organization stays the default Manage tab.
- **S2-C6.** The page shows, in this order: the R3 headline with the check time and "Check again"; one row per part with icon and word, and a plain cause line when a part does not work; About this system (version, plus the release-notes link for the installation owner only); When something goes wrong. It loads in the page frame with no curtain, and refreshes every 60 seconds while visible and when the window regains focus.
- **S2-C7.** When a request fails with no response, the app shell shows the banner text from this spec. The banner does not block the page and clears on the next successful response.
- **S2-C8.** `/api/health` and `/api/ready` keep their responses and stay unauthenticated.
- **S2-C9.** At 1440 and 390 px wide, the page has no horizontal scroll. Every control works with the keyboard, and status words are text, not color alone.
- **S2-C10.** A status request writes no audit row and no security event.

## Acceptance criteria (S3, S4)

Approved by the Human Owner on 2026-11-03 ("Start S3 and S4"), with the choices in "Owner decisions for S3 to S6". Tests and reviews cite these IDs.

**S3 Organization block**

- **S3-C1.** For an admin of the bound organization, the status response carries an `organization` part. For a member, guest or member with no group access it is empty, and the response never becomes a 403 because of it.
- **S3-C2.** Backups: the part gives the state against the schedule (on time, late, no schedule, never backed up), the time of the last successful backup and the result word of the last run. Late means no successful backup since the last due time plus 1 hour. A non-owner admin gets no sizes, paths, run lists or failure codes.
- **S3-C3.** Failed jobs: the count of failed jobs in the last 7 days, limited to the job kinds that admin sees in Manage → Jobs (backup kinds only for the installation owner).
- **S3-C4.** Sign-in activity: the counts of failed sign-ins and lockouts in the last 7 days for the bound organization only.
- **S3-C5.** The page shows block 3, "Your organization", to admins only: a Backups line, a Failed jobs line linked to Manage → Jobs, and a Sign-in activity line linked to Access → Security. Non-admins see no block and make no extra request.
- **S3-C6.** The organization part writes nothing (no audit row, no security event) and shows no data of another organization.

**S4 Personal history**

- **S4-C1.** A signed-in person can list their own sign-in history: successful sign-ins, failed attempts, lockouts and ended sessions, each with time, browser and IP address, newest first, in pages. No request can return another person's history.
- **S4-C2.** Settings → Sessions shows "Your sign-in history" below the active sessions, in plain sentences, with an empty state and paging.
- **S4-C3.** A person can read the history of a record they can open (the same read check as the record page, so cross-department links count). For a record they cannot open, the answer is the same as for a record that does not exist. Admin and department manager visibility does not change.
- **S4-C4.** A non-admin reader's history shows only fields they can read: hidden fields, their names and their values are left out.
- **S4-C5.** The record history panel shows to every person who can open the record.
- **S4-C6.** Audit detail, the audit CSV export and the organization security-event list stay admin-only.

**Small items**

- **D6-C1.** In error references and in block 6, an admin reads "Give this reference to the person who runs your server.", the installation owner reads no second sentence, and members and guests keep "Give this reference to your administrator."
- **D7-C1.** Audit and Security events find an entry by the 8-character reference (the end of `request_id`) as well as by the full ID, with today's admin-only access.

## Acceptance criteria (S5, S6)

Approved by the Human Owner on 2026-11-05 ("Start S5 and S6"), with the choices in "Owner decisions for S3 to S6" and these defaults: the error log stores server errors (5xx) only; email outcomes come from the requests FastAPI makes to Auth (invitations and recovery requests); while the database is down no error is stored, and the samples record the outage. Tests and reviews cite these IDs.

**S5 History and installation**

- **S5-C1.** The installation records one sample a minute, not one per API process: each part's status and the time its check took. With several API processes, only one writes. Samples have no organization column.
- **S5-C2.** Samples older than 30 days are deleted at least once a day.
- **S5-C3.** Every signed-in person sees a 30-day timeline under the parts: each period when a part did not work or was slow, as a plain sentence with its day and length, for example "Email did not work for 12 minutes on Tuesday", newest first. With no such period: "No problems in the last 30 days." It shows nothing about any organization (R4).
- **S5-C4.** A part shows "Slow" when its check took longer than 1 second on the last 3 samples in a row, in the current status and in the timeline. "Not working" always wins over "Slow".
- **S5-C5.** FastAPI records the outcome of each email it asks Auth to send (invitations and recovery requests) and changes none of those responses (a recovery request stays 204). The Email part reads Working after a recent successful send, Not working after recent failures, and Set up when no recent outcome exists. It never reads Working without a real success.
- **S5-C6.** Each in-app worker (record triggers, report scheduling, Comms jobs, provider sign-out) records when it last ran; the backup runner keeps its existing heartbeat. The installation owner's block 4 shows each worker as running or "not seen since" a time, and the database size. Nobody else gets this block or its data.
- **S5-C7.** Organization admins see their organization's file storage in use, summed from its file records, with "Storage limit: not set yet". Members and guests do not.
- **S5-C8.** The sampler, the heartbeats and the email outcomes write no audit row and no security event. `/api/health` and `/api/ready` do not change, and the status request stays read-only.

**S6 Diagnostics export**

- **S6-C1.** Each server error (5xx) is stored with its request ID, status, route template (no IDs or values), the bound organization when there is one, and its time, and kept 30 days. No request body, header, personal data or record data is stored. Two kinds are not stored by design: the `/api/ready` 503 (readiness has its own samples) and requests whose method fails the method pattern.
- **S6-C2.** The installation owner can download one JSON file: a summary at the top, versions, database size, worker heartbeats, 30 days of samples and recent server errors.
- **S6-C3.** An organization admin can download one JSON file for their organization only: versions, the parts timeline, their organization's storage and its own server errors. It holds no database size, no workers and no data of another organization (R4).
- **S6-C4.** Members and guests cannot download a diagnostics file and see no download action.

## API contract (S1, S2)

Fixed by the Software Architect (TASK-0002) on 2026-11-02 against `main` d3efacd1 (FastAPI 0.162.0, Starlette 1.6.0). Paths are relative to the repository root.

### S1: `request_id` in every error JSON body

Body: `{"detail": <unchanged>, "request_id": "<uuid7 string>"}`. `request_id` is a top-level sibling of `detail`, equal to the response's `X-Request-ID` (the request middleware creates the context at `request_middleware.py:98-99` before any handler and writes the header from the same object at `:197`; a forged client `X-Request-ID` is ignored, `request_context.py:16`).

Mechanism: one helper next to `RequestContext` in `app/core/middleware/request_context.py`, `error_content(request, detail) -> {"detail": detail, "request_id": str(ctx.request_id)}`. It reads the existing `request.state.request_context` and never creates one. Raw ASGI code uses `Request(scope)` (as `file_transfers.py:133` does). Framework-raised errors go through two app-level handlers in `main.py`; routes need no edits except rows 10 and 11.

| # | Origin | file:line | Change |
|---|---|---|---|
| 1 | 503 database unavailable | `request_middleware.py:65-69` | helper |
| 2 | 500 unexpected | `request_middleware.py:81-85` | helper |
| 3 | 413 body too large (declared size) | `request_middleware.py:141-144` | helper |
| 4 | 413 body too large (streamed) | `request_middleware.py:150-153` | helper |
| 5 | HTTPException raised inside the middleware (`files_busy` 503, `providers.py:69-74`) | `request_middleware.py:159-163` | helper |
| 6 | 504 `file_timeout` (nested `detail` object) | `request_middleware.py:166-176` | helper |
| 7 | Every raised `HTTPException` (401, 403, 404, 405, 409, 412, 428, 429, route 503; routing 404/405; the `ExportSecretRoute` 422 re-raised as HTTPException at `backups/router.py:78`) | `main.py:277-293` (the `/api` 404 branch at 283; delegation to FastAPI `http_exception_handler` at 280 and 293) | Extend the existing handler. Keep FastAPI's no-body branch for statuses that cannot have a body. Keep the static-site branches. |
| 8 | 422 `RequestValidationError` (schema validation, `parse_organization_id` at `auth.py:109`, `comms/templates/router.py:66`) | no handler today (FastAPI default) | New `@app.exception_handler(RequestValidationError)`; keep `detail = jsonable_encoder(exc.errors())` exactly. |
| 9 | FileDispatch `files_busy` (raw ASGI) | `file_transfers.py:140` | helper through `Request(scope)` |
| 10 | Refresh 401 with cleared cookies, returned directly | `cookies.py:56-61`, called at `auth/router.py:173` | helper with `request` passed in; keep the three `delete_cookie` headers |
| 11 | `security_effect_error`, returned directly | `users/router.py:378-390`, called at 352 and 372 | helper with `request` passed in |

Rejected: rewriting bodies at the end of the middleware (JSON re-serialization, stream buffering, risk of collapsing the three `Set-Cookie` lines of row 10).

S1-C2: success bodies do not change; the helper runs only on error paths. `/api/ready` 503 is a returned body, not raised, so it stays unchanged.

Non-JSON error responses that stay unchanged and carry no body ID (the frontend treats them as S1-C5): `trusted_hosts.py:43` plain-text 400 (still has the header); the static-site 404 page and no-body 405 (`main.py:288-292`); uvicorn `limit_concurrency` 503 (`app/__main__.py:34-35`, before the app, no ID); Caddy `respond 400/404`; Starlette `ServerErrorMiddleware` plain 500 (only if the middleware itself fails).

### S2: `GET /api/system/status`

- Home: `backend/app/systems/manage/health/` with `router.py`, `schemas.py`, `service.py` (the process cache needs a lock).
- Router: `APIRouter(prefix="/system", tags=["system"])`, `@router.get("/status", response_model=SystemStatusResponse, operation_id="get_system_status")`, registered in `main.py` with `prefix="/api"`.
- Sync handler (`def`), like `/api/ready`, because the readiness wait blocks.
- Auth: `get_current_user` (`app/common/dependencies/auth.py:329`). It admits any active membership of the bound organization (admin, member, guest, member with no group access; it checks the membership row only, `auth.py:241-250`). 401 with no session or mixed credentials (`auth.py:148-154`) and for setup-only identities (`auth.py:226-229`); 403 `organization_required` with no bound organization (`auth.py:96-97`).
- Organization binding is required (`X-Org`, else `identity_sessions.active_org_id`, `auth.py:286-287`): `resolve_membership` applies the organization's IP allowlist and MFA step-up (`auth.py:260-274`), and S3 needs the bound organization and role. Do not use `get_account_user`.
- Take `db: Database` and call `db.rollback()` before waiting on readiness (`get_db` does not commit, `session.py:53-67`), so no pooled connection idles in a transaction across the probe.

Schema (`schemas.py`):

```python
PartKey    = Literal["data", "signing_in", "files", "email"]
PartStatus = Literal["working", "not_working", "not_set_up", "set_up"]
class SystemPart(BaseModel):            key: PartKey; status: PartStatus
class SystemStatusResponse(BaseModel):  parts: list[SystemPart]; version: str; checked_at: datetime
```

- `parts` always has four entries in R1 order: `data`, `signing_in`, `files`, `email`. Keys are not readiness names (S2-C4). No overall field and no `required` field; the frontend builds the R3 headline.
- `version` = `request.app.version` (single source: `FastAPI(version=...)` at `main.py:169`; `/api/version` reads it the same way at `backups/router.py:252`; its access does not change).
- `checked_at`: timezone-aware UTC from `utc_now()` (`base_model.py:13-14`), ISO 8601 with `Z`. The frontend shows local time.
- `Cache-Control: no-store` from the middleware default (`request_middleware.py:190-191`).

Example: `{"parts":[{"key":"data","status":"working"},{"key":"signing_in","status":"working"},{"key":"files","status":"not_working"},{"key":"email","status":"set_up"}],"version":"0.1.0","checked_at":"2026-11-02T10:42:05.123456Z"}`

R2 mapping (readiness values `readiness.py:22-24`):

| Readiness | `ready` | `unavailable` | `not_configured` | missing |
|---|---|---|---|---|
| database → `data` | working | not_working | not_set_up | not_working |
| auth → `signing_in` | working | not_working | not_set_up | not_working |
| storage → `files` | working | not_working | not_set_up | not_working |
| smtp → `email` | set_up | not_working | not_set_up | not_working |

Email is never `working`. Readiness never returns `unavailable` for smtp today (`readiness.py:110-115,167-171`).

S3 attach point: a top-level `organization: OrganizationStatus | None`, filled only for an admin of the bound organization, `null` otherwise; never a 403. S3 must update the frontend zod adapter in the same slice (39 frontend files use `.strict()`).

The endpoint itself can return 503 "Authentication service unavailable" (`auth.py:171-172`) when the database is down; the page shows "cannot check now" for it.

### Cache

- Module-level `(snapshot, checked_at_utc, monotonic_at)` in `manage/health/service.py`, guarded by a `threading.Lock`; per process; `readiness.py` unchanged.
- TTL 30 s measured with `time.monotonic()` from when the snapshot was received.
- On a miss: release the lock, call `get_readiness_snapshot()` (it already shares one in-flight probe among concurrent callers, `readiness.py:69-82`), store the result. The caller-timeout fallback snapshot (`readiness.py:58-66`) is cached too.
- "Check again" within the TTL returns the cached result with its original `checked_at`; there is no bypass (a bypass breaks S2-C2 and lets any member trigger probes at will).
- S2-C8: `main.py:261-275` and `readiness.py` are not edited; `/api/health` and `/api/ready` stay unauthenticated and byte-for-byte the same, with no `request_id`.

### Side effects and controls

- No audit row and no security event from an admitted request (`resolve_provider_session` writes nothing on ordinary reads, `provider_sessions.py:178`; the readiness probe uses a separate read-only engine, `readiness.py:32-48,196-205`). The existing `identity.ip_blocked` write on a denied IP (`auth.py:207-209`) stays.
- The frontend's automatic 60-second poll passes `refreshOnUnauthorized: false` (as `workspace-event-source.ts:86` does), so the poll never extends an idle session (`api.ts:524-541`, `provider_sessions.py:369,417`, `security_policy.py:138-146`).
- No route-level limiter; bounded by authentication, the 30 s cache, `server_max_concurrency` and Caddy. CSRF and Origin checks apply to unsafe methods only. Not added to TrustedHost `read_only_host_paths`.

### Risks

- SEC-R6: organization isolation, credential separation, CSRF plus Origin, `AuditSession` and `scope.py` are unchanged; S1 adds no new information (the ID is already in the header); the sanitized secret-export 422 (`backups/router.py:62-80`) stays sanitized; rows 10 and 11 keep their cookie clearing.
- R4: readiness parts are already public through `/api/ready`; the only new disclosure is the version string to members and guests (installation-wide, accepted by the owner on 2026-11-02).
- Test fallout: 33 exact `json() == {"detail": ...}` assertions in 20 backend test files fail; make each stricter (`{"detail": X, "request_id": r.headers["X-Request-ID"]}`), then run `python3 scripts/assertion_guard.py --base <base>`.
- After the build, update `docs/architecture/15-error-handling-and-recovery.md:8-10`, `18-observability.md:7-14,23` and `07-api-architecture.md` (route groups).
- `/api/system/status` is singular (differs from `fastapi-api-design` rule 1); the owner approved this path, so it stays.

### Backend test list

| # | Criterion | Layer | Test |
|---|---|---|---|
| 1 | S1-C1 | stack-free `TestClient(create_app())` | HTTPException handler: a 401, an `/api` 404 and a 405 each give `request_id == X-Request-ID` with `detail` unchanged (429 shares the handler). |
| 2 | S1-C1 | stack-free | A schema-validation 422 keeps its exact `detail` list and adds `request_id`. |
| 3 | S1-C1 | stack-free | Middleware errors: 413 (declared size), 503 database (dependency raises `OperationalError`), 500 (raises `RuntimeError`): body ID equals header. |
| 4 | S1-C1 | ASGI unit | FileDispatch `files_busy` gives `request_id` equal to the `scope["state"]` context; 504 `file_timeout` the same with an expired deadline. |
| 5 | S1-C1 | PostgreSQL integration (extend the existing tests) | Refresh 401 from `cleared_auth_error` keeps three cookie deletions and has `request_id`; same for the `security_effect_error` route test. |
| 6 | S1-C2, S2-C8 | stack-free | `/api/health` 200 and `/api/ready` 200/503 bodies and headers stay exact, no auth, no `request_id`; two `/api/ready` calls probe twice. |
| 7 | S2-C1 | stack-free | No session → 401 with `request_id`. |
| 8 | S2-C1, S2-C10 | PostgreSQL integration, readiness monkeypatched | Admin, member, guest and member with no group access each get 200 with four parts in order, `version == app.version`, UTC `checked_at`; no bound organization → 403 `organization_required`; audit rows, security events and `refreshed_at` unchanged. |
| 9 | S2-C2 | service unit with fake clock and counting stub | Two calls within 30 s → one probe, same `checked_at`; after 30 s → new probe; timeout fallback cached; concurrent misses → one probe. |
| 10 | S2-C3 | unit table | Every readiness value maps per the table; email never `working`. |
| 11 | S2-C4 | stack-free, `get_current_user` overridden | Body holds only schema fields; no `database`, `auth`, `storage`, `smtp`, `supabase`, host or port text. |

## API contract (S3, S4)

Fixed by the Software Architect (TASK-0009) against `main` 542102d1. Owner decisions on 2026-11-03: DQ1 option A (attribute failed sign-ins to the account), DQ2 default (live, non-redacted fields), DQ3 no index (revised after the RLS finding). Paths are relative to `backend/app/`.

### S3: `organization` part of `GET /api/system/status`

```python
BackupState  = Literal["on_time", "late", "no_schedule", "never_backed_up", "unknown"]
BackupResult = Literal["verified", "failed", "interrupted"]
class OrganizationBackups(BaseModel): state: BackupState; last_success_at: datetime | None; last_result: BackupResult | None
class OrganizationStatus(BaseModel): since: datetime; backups: OrganizationBackups; failed_jobs: int | None; failed_sign_ins: int; lockouts: int
# SystemStatusResponse gains: organization: OrganizationStatus | None  (always present, null for non-admins)
```

- `since` = request time minus 7 days; the frontend uses it for the Jobs and Security links. `unknown` only when `installation_id(db)` raises `BackupStateError` (`backups/service.py:45-55`); then `failed_jobs` is null too.
- Admission: `require_current_membership(db, person).role == "admin"`; never `require_admin` or `require_fresh_exact_admin` (both 403). Everyone else: `organization: null`, 200. Org queries run after the existing `db.rollback()` (`health/router.py:24`; the next transaction re-binds the organization for RLS) and end with another `db.rollback()`. Nothing commits. The readiness cache never holds org data; no org cache.
- Backups, read-only (`db.scalar(select(BackupPolicy))` as `service.py:107`; never `lock_policy`), runs filtered to the current installation. Order: no_schedule (no policy, schedule `disabled`, or the policy of another installation) → never_backed_up (no succeeded run) → late (a last due time exists, now ≥ last due + 1 h, and no run succeeded with `finished_at >= last_due`; manual runs count) → on_time. Last due = `next_due_at` when it is ≤ now (it only advances when the runner claims a run, so a dead runner shows late), else the latest `BackupRun.scheduled_for <= now`, else none. `last_success_at` = `finished_at` of the latest succeeded run (succeeded always has `verified_at`, so the result word is `verified`); `last_result` = state of the latest finished run. Never a name, failure code, snapshot, manifest, size, path or run list.
- Failed jobs: count over `registry.jobs_query(instance)` with `state == "failed"` and `effective_at >= since` (as `jobs/router.py:62-65`), the platform-operator filter of `jobs/router.py:56-57`, and an explicit org filter: add `org_id` to `_work_columns` and a null UUID to `_backups` in `registry.py`, then `or_(org_id == bound_organization_column(), kind == "backup")`.
- Sign-in counts: two counts over `security_events` with `event_type IN ('identity.sign_in_failure', 'identity.lockout')`, `occurred_at >= since`, and `_security_events_of_bound_organization()` (`audit/service.py:140-158`), the rows Access → Security shows.
- Frontend: the strict status schema gains `organization: organizationStatusSchema.nullable()` in the same slice.

### DQ1: attribute failed sign-ins to the account (Security Engineer reviews)

On a failed password sign-in, look up the local account with that email and set `subject_id` (actor stays null) on `identity.sign_in_failure`, with the user agent and that request's `request_id`. Owner revision 2026-11-03 after QA: every failed attempt on an existing account writes its own event, so counts are exact and each login-page reference is findable; rows stay bounded by the account budget of 10 attempts per 15 minutes. Unknown-email failures keep one row per source address per hour. Account lockouts carry the subject; source-address lockouts do not. The sign-in response, its status and its timing class do not change for known or unknown emails. History starts from this release.

### S4: own sign-in history

- `GET /api/auth/sign-in-events`, operationId `list_own_sign_in_events`, on `auth_router` in `access/users/sessions_router.py`.
- Auth: `get_account_identity` + `_require_completed_identity`, as `GET /api/auth/sessions` (`sessions_router.py:176-181`). No organization binding: account events have `org_id = NULL`, RLS then returns only those rows, and a person blocked by an organization's IP rule or MFA step-up still sees their own failures.
- Only the caller: `IdentitySession.user_id == me` and `SecurityEvent.subject_id == me`; no person parameter.
- Sources (UNION ALL, built like `registry.jobs_query`): `signed_in` = `IdentitySession.created_at` with its `user_agent` and `ip_address`; `session_ended` = `IdentitySession.revoked_at` when set; `sign_in_failed` and `locked_out` = security events with `subject_id == me` (IP from `metadata.ip_address`, browser from `metadata.user_agent` when present). Idle timeouts are not listed (no stored end time).
- Response: `StandardListResponse[SignInEventResponse]` with `{id, kind, occurred_at, user_agent: str | None, ip_address: str | None}`; keys unique as `kind:id`; sort `occurred_at` newest first, tie-break `(id, kind)`; limit 1–100, default 25; no search or deleted filter (422 if sent); `Cache-Control: no-store`. Retention: `session_retention_days` and `security_event_retention_days` of the platform settings.

### S4: wider audit list (`GET /api/audit-logs`)

- Admission order in `_require_audit_list_visibility` (`audit/router.py:62-71`): admin unchanged → `department_id` with manage on that department unchanged → **new reader path**: `entity_id` given and no `department_id`; the server loads the `Record`; missing record or `module_level(db, user, record.module_id) is None` gives an empty page (200, total 0), the same answer a missing ID gives an admin; rows forced to `entity_type == 'records' AND entity_id == record` plus `_audit_rows_of_bound_organization()` → anything else 403.
- The read check moves out of `_record` (`sandbox/records/router.py:119-130`) into a shared `sandbox/records/access.py`, used by the record route and the audit route (the same `scope.py` function; no second policy).
- Reader field filtering (DQ2): `before`/`after` keep only `data` keys that are live fields of the record's module with `audit_redacted = false`, plus `is_deleted`; entries with no readable change are removed in SQL (`.has_any(ids)` on `before`/`after['data']`, or action create or delete) so `total` stays right; `request_method`, `request_path` and `note` become null. Managers and admins keep the full snapshot. `/options`, detail, export and security events do not change (S4-C6).
- `docs/architecture/10-audit-and-history.md` gets the reader rule (any member may list one record's history when the `scope.py` module read of `GET /api/records/{id}` passes; otherwise an empty page; readable fields only; no method, path or note). SEC-R6: a deliberate widening approved by the owner on 2026-11-03, through the one access function; the PR states this.

### D7: reference search

- `reference: str | None` (8 hex characters or a full UUID, lowercased, 422 otherwise) on `GET /api/audit-logs` and `GET /api/security-events`. 8 characters: `right(request_id::text, 8) = :ref`; 36: `request_id = :uuid`. It only narrows what the caller can already list.
- DQ3 (revised 2026-11-03): no index. Under row-level security PostgreSQL cannot use an expression index on `right()`, which is not leakproof, so the owner chose to drop the migration. A reference search scans only the bound organization's rows; the full-ID search keeps `ix_audit_logs_request`. Revisit with a stored generated column if audit tables grow large.
- Readers on the audit reader path get 422 for any `search` and for sorting by request path, because the admin search reads raw `before`/`after` values and the request path.
- Correction to R5: the security-event list had no request-ID filter before D7.

### Backend test list

| # | Criterion | Layer | Test |
|---|---|---|---|
| T1 | S3-C1 | PG integration (extend S2 #8) | Admin gets `organization`; member, guest, no-access member get null and 200 |
| T2 | S3-C2 | PG + fake clock | State table: no policy, disabled, other installation, never, due ≤ 1 h (on_time), > 1 h without success (late), manual success after due, last failed after an earlier success, other installation's runs ignored, `BackupStateError` → unknown |
| T3 | S3-C2 | stack-free | Admin body keys exactly the schema; no name, failure_code, snapshot or size |
| T4 | S3-C3 | PG | Org A failed job within 7 days counted; older not; org B not; failed backup only for the operator |
| T5 | S3-C4 | PG | Attributed failure and lockout of an org A member counted in A; non-member and > 7 days not |
| T6 | S3-C6 | PG | Admin call leaves audit rows, security events, `runner_last_seen_at` and the policy row count unchanged |
| T7 | S4-C1 | PG | Own list: signed_in, session_ended, failed, locked_out, newest first, paged; another account's rows absent; works with no bound organization; 401 without a session |
| T8 | S4-C3 | PG | Reader by module grant (including another department) gets history; no-access member gets the same empty page for a real ID and a random UUID; other entity types never appear |
| T9 | S4-C3 | PG | Admin and manager department paths unchanged; non-manager with `department_id` gets 403 |
| T10 | S4-C4 | PG | Reader sees no closed or redacted field keys; an entry with only hidden changes is omitted and `total` matches; path, method, note null; manager sees the full snapshot |
| T11 | S4-C6 | PG, parametrized | Reader gets 403 on audit detail, export, options and security events |
| T12 | D7-C1 | PG | `reference` by suffix and full ID on both lists, uppercase accepted; other organization's match not returned; bad format 422 |
| T13 | DQ1 | PG | Wrong password for a real account writes a failure with `subject_id` and user agent; unknown email writes none with a subject; both responses identical; a source-address lockout has no subject |

## API contract (S5, S6)

Fixed by the Software Architect (TASK-0015) against `main` 856d859d, database head e46611902f25. Owner choices (2026-11-05, recommended options under the owner's standing instruction): J1 A — recovery requests record failures only, and only Auth 5xx answers count (revised 2026-11-05 after the security review: an unauthenticated caller could otherwise trigger 400 or 429 answers and make Email read Not working); successes come from invitations. J2 A — no security event on a diagnostics download (as the audit CSV export). D20-7 (parent): the owner's installation file lists each organization's storage total. Paths relative to `backend/app/`.

### Sampler (S5-C1, S5-C2)

- `manage/health/worker.py` `SystemHealthWorker`, created in `create_app` as `app.state.health_worker`, started after the other workers in `application_lifespan`, stopped first, before `dispose_readiness_resources()`; same test gate as the other workers (`environment != "test" or e2e_background_workers`).
- One thread per process; wakes at each UTC minute + a random 0–10 s offset; one retention attempt per hour.
- Probe: new `get_timed_readiness_snapshot() -> (ReadinessSnapshot, dict[str, int])` in `core/readiness.py`, timing each part with `perf_counter` inside the shared in-flight probe and its 2 s budget; on timeout unfinished parts are `unavailable` with the time used. `get_readiness_snapshot()`, `/api/ready` and the 30 s cache keep their behavior.
- Per tick: skip if the minute's row exists → probe outside any transaction → short transaction on `AuditSession(bind=get_engine())` (not the read-only readiness engine) → `pg_try_advisory_xact_lock(hashtextextended('slateops:system-health-sampler',0))`, else skip → re-check, insert buffered minutes and this minute, commit. Primary key on `sampled_at` is the second guard. `database_bytes = pg_database_size(current_database())` by the writer.
- Database down: the sample (data `not_working`, `database_bytes` null) goes into a per-process `deque(maxlen=1440)` and flushes at the next lock win, skipping existing minutes.
- Retention: `SELECT public.retain_system_health()` hourly from every process (the function takes its own try-lock).
- Test hooks: `sample_once(now=, probe=)`, `retain_once()`, injectable clock, stubbable timed probe.

### Tables (one migration, `down_revision = "e46611902f25"`; models `__audit_enabled__ = False`)

| Table | Columns | Keys | RLS and grants to `slateops_app` |
|---|---|---|---|
| `system_health_samples` | `sampled_at timestamptz` PK with CHECK seconds = 0; `{data,signing_in,files}_status` NOT NULL CHECK IN (working, not_working, not_set_up); `{data,signing_in,files}_ms integer NULL` ≥ 0; `email_status` NOT NULL CHECK IN (working, not_working, set_up, not_set_up); `database_bytes bigint NULL` ≥ 0 | PK | no RLS (no organization column, installation-wide); SELECT, INSERT |
| `system_health_signals` | `key text` PK CHECK IN (record_triggers, report_scheduling, comms_jobs, provider_signout, email_accepted, email_failed); `last_seen_at timestamptz NULL` | PK; the migration inserts all six rows | no RLS; SELECT, UPDATE |
| `server_errors` | `request_id uuid` PK; `occurred_at timestamptz NOT NULL DEFAULT now()`; `status smallint` CHECK 500–599; `method text` CHECK `^[A-Z]{3,7}$`; `route text` length ≤ 200; `org_id uuid NULL` FK organizations ON DELETE RESTRICT | `(occurred_at)`, `(org_id, occurred_at)` | RLS as security_events: SELECT and INSERT `org_id IS NULL OR org_id = bound`; SELECT, INSERT |

- `public.retain_system_health() RETURNS integer`, `SECURITY DEFINER`, owner `slateops_owner`, `search_path pg_catalog, pg_temp`, try-xact-lock, deletes samples and errors older than 30 days and errors beyond the newest 50,000 in batches ≤ 5,000, no proof event; `REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO slateops_app`; added to the root-function lists.
- `server_errors` joins `ORGANIZATION_TABLES` and `MIXED_TABLES` in `tests/migrations/test_organization_root.py`.

### Email outcomes (S5-C5)

- Invitations: `send_invitation_email(provider, email)` in `access/users/invitation_provider.py`, used at `users/service.py:286, :407, :482`; 200 → `email_accepted`; `SupabaseAuthUnavailable` `http_5xx`/`http_429` → `email_failed`; transport errors and other 4xx record nothing; the original exception is re-raised unchanged.
- Recovery (J1 A, revised): in `provider_actions.request_recovery`, only an Auth 5xx records `email_failed` (4xx and 429 record nothing) (add `kind=f"http_{status}"` at `supabase_auth.py:220-221`); a 200 records nothing (Auth answers 200 for unknown emails). Responses unchanged (204 on success, the existing 503).
- `record_signal(key)` in `manage/health/signals.py`: own `AuditSession`, `SELECT … FOR UPDATE`, `last_seen_at = max(old, now)`, commit, never raises (logs `operational_attention reason_code=health_signal_write_failed`).
- Email word (read from the 60 s history cache, so it can lag a send by up to 60 s): smtp `not_configured` → `not_set_up`; else `email_failed` within 24 h and newer than `email_accepted` → `not_working`; else `email_accepted` within 24 h → `working`; else `set_up`. Working means Auth accepted the send.

### Heartbeats (S5-C6)

`record_triggers` after `TriggerWorker._run` `run_once` (lane 0); `report_scheduling` and `comms_jobs` in `ReportSchedulingWorker._run` after `_poll` when each is due; `provider_signout` after `run_once`. At most one write per key per 60 s per process (`monotonic`), outside `worker_organization`. The backup runner keeps `BackupPolicy.runner_last_seen_at`.

### Status response, periods read, storage, installation (S5-C3, C4, C6, C7)

- `PartStatus` gains `slow`; Email may be `working` (replaces S2-C3); Email is never slow. A part is `slow` when its current word is `working` and the newest 3 samples are within the last 4 minutes, each `working` with `ms > 1000`. Not working wins.
- History cache: per process, 60 s TTL, no bypass, holds periods and slow parts, no organization data.
- Periods per part: not_working runs (gaps ≤ 2 minutes) and slow runs (working, `ms > 1000`, ≥ 3 samples); `ended_at` = last bad sample + 1 minute, or `null` while ongoing (the run reaches the newest sample, at most 3 minutes old).
- `GET /api/system/health-periods` (`list_system_health_periods`, `get_current_user`, same answer for everyone): `limit` 1–100 default 5, `offset` ≥ 0 → `{items: [{part, kind: "not_working"|"slow", started_at, ended_at|null}], pagination, oldest_sample_at|null}`; ongoing first (`started_at` desc), then ended by `ended_at` desc, ties in part order. The frontend de-duplicates by `part:kind:started_at`.
- `organization.storage_used_bytes: int | None`: `SUM(actual_size)` for `org_id = bound`, `state IN ('ready','deleting')`, `actual_size IS NOT NULL`, under files RLS; trashed files count until purged; pending, rejected and avatars do not; on error `null`.
- `installation: InstallationStatus | None` for `is_platform_operator(db, person.id)`, else `null` (never 403): `database_bytes`, `database_measured_at` from the newest sample with a size ≤ 10 minutes old, else null; `workers [{key, state: "running"|"not_seen"|"never_seen", last_seen_at|null}]` in order record_triggers, report_scheduling, comms_jobs, provider_signout, backup_runner; running within 3 minutes (5 for backup_runner, `backups/service.py:200`); `backup_runner` reads the `BackupPolicy` singleton directly.
- "No change" (D20-6): the frontend ignores `installation.database_bytes`, `database_measured_at` and a running worker's `last_seen_at`.

### Server error log (S6-C1)

- `RequestContext.org_id` set only at `common/dependencies/auth.py:275` (after IP and MFA checks).
- In `request_middleware.py` after the headers (`:199`), when `status >= 500`: `await run_in_threadpool(record_server_error, …)`, never raising; stores `request_id`, `status`, `method`, the `_request_route()` template or `"unknown"`, `org_id`, time; no body, header, query, user or record data; fresh `AuditSession` bound through `worker_organization(org_id)`.
- The database-unavailable path writes nothing; after a failed write, writes pause 30 s per process; cap 120 per minute per process (overflow counted in one `operational_attention reason_code=server_error_log_dropped` line).

### Diagnostics downloads (S6-C2 to S6-C4)

- `GET /api/system/diagnostics/installation` (`download_installation_diagnostics`; `require_fresh_exact_admin` + `require_platform_operator`) and `GET /api/system/diagnostics/organization` (`download_organization_diagnostics`; `require_admin`). Members and guests 403; no session 401. Sync handlers returning JSON with `Cache-Control: no-store` and `Content-Disposition: attachment; filename="slateops-diagnostics-<installation|organization>-YYYYMMDD-HHMMZ.json"`; `summary` first; no audit row or security event (J2 A).
- Installation file: `summary`, `versions {application, schema_revision, postgresql}`, `database`, `workers`, `organizations [{org_id, storage_used_bytes}]`, `samples {columns, rows}` (30 days), `periods` (≤ 1000), `server_errors {total_30d, truncated, items ≤ 1000}`; other organizations are read one at a time in a new session inside `worker_organization(org)`, plus one unbound pass for null-organization rows.
- Organization file: `summary`, `versions {application}`, `periods` (≤ 1000), `storage {used_bytes}`, `server_errors` of the bound organization only (no `org_id`, no null-organization rows); no database, workers or samples.

### Cloud mode

Nothing depends on `cluster_name` or `installation_id()`; only transaction-scoped advisory locks; retention follows `retain_security_events`; storage cost about 15 MB. Risk: probes over the internet may read Slow; measure in the cloud spike (the 1 s limit stays). On Cloud `backup_runner` reads never_seen; C8 hides it with the backup controls.

### Backend tests

I-1 two samplers one row, lock held skips, rollback then later write (S5-C1); I-2 buffered flush, one row per minute (S5-C1); I-3 timed probe and `/api/ready` unchanged (S5-C1, C8); I-4 retention and denied direct DELETE (S5-C2); I-5 period table unit (S5-C3); I-6 identical periods for every role, 401 (S5-C3); I-7 Slow rule (S5-C4); I-8 invitation and recovery outcomes with unchanged responses (S5-C5); I-9 email word table (S5-C5); I-10 owner installation part, runtime-role `pg_database_size` (S5-C6); I-11 heartbeat throttle (S5-C6); I-12 storage sum scope (S5-C7); I-13 no audit or security rows (S5-C8); I-14 error row exactness, no row for database 503, 4xx, success, non-member `X-Org` (S6-C1); I-15 cap and pause (S6-C1); I-16 `server_errors` RLS (S6-C1); I-17 owner file (S6-C2); I-18 admin file scope (S6-C3); I-19 member, guest 403, no session 401 (S6-C4).

After the build: update `docs/architecture/18-observability.md` and `07-api-architecture.md`, and the D19.2 owner paragraph (each organization's storage total).

## Design (S1, S2)

`ui-ux-pro-max` set the structure, flows, keyboard order, and responsive behavior. `impeccable` set the presentation inside that structure. The design adds no token: each color below is an existing token utility in `frontend/src/app/globals.css`. For anything this section does not name, `DESIGN.md` applies (Manage sections, Slim controls, Request feedback, Loading, Words).

### D1. Error references (S1)

**D1.1 Components.** Make one new component and one new helper.

- `ErrorReference` in `frontend/src/components/ui/error-reference.tsx`. Its input is the full request ID, or nothing. With no ID it renders nothing: no "Reference" word, no empty line, and no reserved space (S1-C5).
- `apiErrorReference(error)` in `frontend/src/lib/api-errors.ts`, beside `apiErrorMessage`. It returns the full ID of an `ApiError` that kept one (S1-C3), or nothing.

These failures have no ID, so they show no reference: a failed fetch (`TypeError`), an aborted request, a check in the browser before a request, a clipboard failure, and a render error (`error.tsx`). Some error responses also carry no ID in the body: a plain-text 400 from the host check, a 503 from the concurrency limit in front of the application, and a 400 or 404 from a proxy. They show their message with no reference and no placeholder, as S1-C5 says. An `ApiContractError` keeps the `X-Request-ID` of the response that it rejected, so it shows a reference when that response had one (D4, question 5). A contract check in the browser before any request has no ID and shows none.

**D1.2 What the reference shows.** Two lines, always after the message:

```text
Reference 4f9c2e1a   Copy   Reference copied
Give this reference to your administrator.
```

- Line 1: the word "Reference", then the last 8 characters of the ID in the code face (`--font-code`, 14px, tabular figures), then the Copy button, then the confirmation slot. The line wraps between its parts on a narrow width. The 8 characters never break. Their `title` holds the full ID.
- Line 2: the R5 sentence, word for word, 14px.
- Both lines are ink (`text-foreground`), not muted ink. They sit on `--danger-tint` in alerts and error toasts, and the contrast guard checks muted ink only on the ground, card, and sunken fill.

**D1.3 Copy control.**

- A `Button`, variant ghost, size sm: the lucide `Copy` icon (16px, `aria-hidden`), then the visible word "Copy". The accessible name is "Copy reference". It is 44px tall below 1280px and 32px from 1280px, as the slim controls are.
- A press copies the full ID, not the 8 characters.
- Success: the confirmation slot shows "Reference copied" for 4 seconds, then empties. The slot is a `role="status"` span that is in the DOM, empty, from the first render, so the text is announced politely. Focus stays on the button, and the button label does not change.
- Failure: the browser can refuse the clipboard, for example on an installation served over plain http. The slot then shows "Copy failed. Select the reference below." A third line shows the full ID as code text with `select-all` and `break-all`, so one click or tap selects it and it never scrolls sideways. The line stays until the error closes.
- Pattern source: the snapshot ID copy in `frontend/src/components/systems/manage/components/backup-detail.tsx` (a status slot that clears after 4 seconds, and a failure sentence).

**D1.4 Where the reference renders.** One reference for each failed request. The reference is always the last part of the error container, after any action such as Retry.

| Error surface | Today | Where the reference goes |
|---|---|---|
| Form error at the form level | A destructive `Alert` with the `apiErrorMessage` text | In the same Alert, under the message |
| Field errors from a 422 | `FieldError` under each field | Never under a field. When a form shows only field errors, it also shows one form-level destructive line, "Check the entered values and try again." (today's 422 text), with the reference under it, above the form's buttons |
| Error toast | `toast.add({ type: "error" })` and `reportError(title)` | In the toast, under the title and the description (D1.5) |
| Page or region error (a region that could not load) | A destructive `Alert` with the message and a Retry button (Jobs) | In the Alert, after the Retry button |
| Dialog or sheet | A destructive `Alert` in the body; the dialog stays open | In that Alert. The pinned footer does not change |
| Inline error beside one control (a switch or a row action that failed in place) | One destructive line | Under that line |

These are not error messages, so they show no reference: a refusal that the page turns into a plain notice (`ManageUnavailable`, "Only the installation owner can do this."), the hidden-section notice (it sends no request), empty states, and success and info toasts.

**D1.5 Toasts.** `NoticeOptions` in `frontend/src/components/ui/toast.tsx` holds strings only. Make these changes:

1. Add an optional `reference` (the full ID). The toast renders it through `ErrorReference` under the title and the description, for `type: "error"` only.
2. Add a second argument to `reportError(title, reference?)` in `frontend/src/lib/feedback.ts`.
3. Show the existing hidden hint "Press F6 to reach this notice." when a toast has a reference, as it does for an action.

Error toasts stay until dismissed (`timeout: 0`), so Copy stays reachable. The toast region announces the title as it does today. The reference is not in the announced text, because 8 characters spoken on every failure are noise. The person reaches it with F6. The deduplication by title keeps the first toast and its reference.

**D1.6 Keep the ID with the message.** Some callers keep only a message string in state, for example `setReadError(string)` in `jobs.tsx`. Each caller that shows an API error keeps the message and the reference together until the error renders, for example as `{ message, reference }`. The same applies to the local message helpers beside `apiErrorMessage`, such as `kanbanErrorMessage`.

### D2. System health page (S2)

**D2.1 Frame.** The page is a Manage section with the Manage grammar (`manage-ui`, `slim-ui`).

- Title (`data-slot="page-title"`): "System health".
- Meta line: "See whether Slate Operations works now, and what to do when it does not."
- No header actions. "Check again" belongs to the status that it refreshes, so it sits in block 1.
- Under the header, the four blocks form one column, at most 672px wide (`max-w-2xl`), left-aligned, with 16px between blocks. Each block is a `section` card (`bg-card`, `border-border`, the large radius), as in `updates-panel.tsx`.
- Block 3 (Your organization, S3) has its place between blocks 2 and 5. In S2 nothing renders there: no card, no heading, and no gap.

**D2.2 Block 1, the headline.** This card has no 56px header. Its parts, in DOM order:

1. A 20px status icon (`aria-hidden`), from the table in D2.3. When all parts work, it is `CircleCheck`. With a part that is Not working, it is `CircleX`. With no part down and Email Not set up, it is `CircleMinus`.
2. The headline sentence as the card's `h2` (`data-slot="section-title"`, Title Large: 18px, weight 600). Heading navigation lands on the answer right after the page title.
3. The check line, 14px, muted, tabular figures: "Checked at 10:42". The response gives the check time in UTC. Show it in local time with no seconds, through the formatter that Manage uses for its other times (`formatWorkspaceDateTime` with the workspace region, as in `backup-time.ts`). When the check is not from today: "Checked on Nov 1 at 23:58", in the same format.
4. The "Check again" button.
5. The error Alert, only in the error states (D2.7).
6. A hidden `role="status"` span for announcements (D2.4).

Headline sentences (R3). "Set up" counts as working and never appears in the headline. Each part has a fixed subject and verb:

| Part | Subject and verb |
|---|---|
| Saving and loading your data | "Saving and loading your data is" |
| Signing in | "Signing in is" |
| Files and pictures | "Files and pictures are" |
| Email | "Email is" |

| Parts that are Not working | Email Not set up | Headline |
|---|---|---|
| None | No | "Slate Operations is working normally." |
| None | Yes | "Email is not set up. Everything else works." |
| One | No | "Files and pictures are not working. Everything else works." |
| One | Yes | "Signing in is not working. Email is not set up." |
| Two or three | No | "Some parts are not working: Signing in, Files and pictures. Everything else works." |
| Two or three | Yes | "Some parts are not working: Signing in, Files and pictures. Email is not set up." |
| All four | No (Email is one of the four) | "Slate Operations is not working right now. Wait a minute, then check again." |

The colon list gives the part names as the list shows them, in list order, separated by commas, with no "and". Some names contain "and", so an "and" between names would be unclear. Email Not working counts as a part that is Not working.

On a phone, the headline wraps. From 640px, the headline and the check line take the left column, and "Check again" sits at the right, at the top of the card.

**D2.3 Block 2, Parts of Slate Operations.** A card with a 56px header that holds the `h2` "Parts of Slate Operations" (`data-slot="section-title"`). The body is a `dl` with one row per part, always in R1 order: Saving and loading your data, Signing in, Files and pictures, Email. A status change never reorders the rows.

- From 640px: label-left rows. The part name (`dt`) is in a muted column of 14rem (the longest name needs about 12rem at 14px). The status (`dd`) is the icon and the word in ink, weight 500, with the cause line under it in muted ink. 6px padding above and below each row, as in the Updates panel.
- Below 640px: the name sits above the status, and the cause line sits under the status, with 12px between rows.

| Word | Icon (lucide, 16px; 20px in the headline) | Icon color |
|---|---|---|
| Working | `CircleCheck` | `text-flow-text` |
| Set up (Email only) | `CircleDashed` | `text-muted-foreground` |
| Not set up (Email only in S2) | `CircleMinus` | `text-warn-text` |
| Not working | `CircleX` | `text-danger-text` |

The response gives each part by key, with one status word for each, and no overall status. The page builds the headline from the four parts (D2.2).

| Key | Row name | Status values and words |
|---|---|---|
| `data` | Saving and loading your data | `working` Working, `not_working` Not working, `not_set_up` Not set up, `set_up` Set up |
| `signing_in` | Signing in | the same |
| `files` | Files and pictures | the same |
| `email` | Email | the same |

The four icons differ by shape as well as color. Do not use the `StatusWord` dot here, because its filled tones differ by color only. The icons are `aria-hidden`; the word is text. A value that the page does not know shows "—" and does not count in the headline.

Cause lines (one line, only for these states):

| Part | State | Cause line |
|---|---|---|
| Saving and loading your data | Not working | "Pages may not load, and changes you make may not save." |
| Signing in | Not working | "People who are signed out cannot sign in until it works again." |
| Files and pictures | Not working | "Files and pictures cannot be uploaded or opened until it works again." |
| Email | Not working | "Messages that need email, such as invitations, wait until email works." |
| Email | Not set up | "Invitations and password emails cannot be sent until the person who runs your server sets up email." |
| Email | Set up | "Slate Operations cannot yet confirm delivery." |

A Working part has no cause line.

**D2.4 Check again and refresh.**

- `Button`, variant ghost, with the lucide `RefreshCw` icon (16px), then the label "Check again". It is 44px tall below 1280px and 32px from 1280px.
- While a check runs, the button stays in place with the same label. It takes `aria-disabled="true"` and `aria-busy="true"`, looks disabled (50% opacity), and ignores presses. Do not use `disabled`, because a focused button that becomes disabled loses focus. The icon turns only with `motion-safe`. All other content stays as it is: no curtain, no skeleton, and no "Checking…" text.
- Result with a change: the headline, the icon, the rows, and the check line update in place, with no animation. The status span announces the new headline and the check line, for example "Email is not working. Everything else works. Checked at 10:43."
- Result with the same check time: inside 30 seconds of a check, the server returns the same result with the same check time, and no new check runs (S2-C2). The page must not suggest a new check. The check line reads "Checked at 10:42 · This is the latest check". The status span announces "This is the latest check, from 10:42." and then the headline. Without this cue the button would look broken.
- Result with a new check time and the same result: the check line reads "Checked at 10:43 · No change". The status span announces "No change. Slate Operations is working normally. Checked at 10:43."
- The suffix after the time ("This is the latest check" or "No change") stays until the next result changes the line. A background refresh never adds a suffix.
- Background refresh: every 60 seconds while the page is visible, and when the window gains focus (S2-C6). The focus refresh belongs to this page's status read only. The global refetch on focus stays off, as `frontend/AGENTS.md` requires. It changes nothing that shows during the request. The 60-second and focus refreshes are not activity: they never renew or extend an idle session. Only a press on "Check again" is the person's activity. When the session has ended, the page follows the existing signed-out behavior: no status error, no Alert, and no reference on this page. When the headline changes, the status span announces the new headline. When nothing changes, it announces nothing.
- The first load announces nothing. A screen reader reads the title and then the headline in page order.

**D2.5 Block 5, About this system.** A card with a 56px header that holds the `h2` "About this system". The body is label-left rows, as in `updates-panel.tsx` (a muted label column of 7rem, 8.5rem from 640px).

| Viewer | Version row |
|---|---|
| Member, guest, administrator who does not own the installation | "Version" and the version text from the status response, for example "0.1.0". No link. |
| Installation owner (`installationOwnerFor`) | The same, then " · " and a "Release notes" link that opens in a new tab, with the `ExternalLink` icon (14px), styled as in `updates-panel.tsx`. When the page does not know a release-notes link, an internal link "Updates & licensing" (`/manage?view=updates`) takes its place. |

**D2.6 Block 6, When something goes wrong.** A card with a 56px header that holds the `h2` "When something goes wrong". The body is two paragraphs: 14px, 24px line height.

1. "When an action fails, its message shows a reference, for example “Reference 4f9c2e1a”, with a Copy button. Give this reference to your administrator." The example reference is in the code face.
2. "When Slate Operations does not load: wait a minute and reload. If it still does not load, tell your administrator."

The words are the same for every role (D4, question 6).

**D2.7 Loading and error states.**

- First load: the header and all four card frames render at once. The part names and the block 6 text are fixed, so they render at once too. Only the data waits, in a `LoadingRegion` for each block: the headline (a skeleton line of about 60% width at 18px and a 96px line at 14px), the four status cells (a 16px circle and a 64px bar each, beside the real names), and the version value (a 48px bar). The region label is "Loading system status". `LoadingRegion` keeps its 300ms rule, so a fast load shows no skeleton. "Check again" shows its busy state during the first load.
- The page never turns a failed status request into part statuses. When the status request itself fails (for example a 503, because the server cannot check sign-in), no row says "Not working". The two states below apply.
- Failure with a response, after a good result: all of the last result stays. The check line keeps the old time. Under it, a destructive `Alert` says "The status could not be checked. The result below is from the last check." and then `ErrorReference`. The Alert closes at the next good check.
- Failure with a response, before any result: the `h2` reads "The status cannot be checked now.", with no icon and no check line. Under it, a destructive `Alert` says "The status could not be loaded. Try Check again in a minute." and then `ErrorReference` (nothing when the response has no ID, D1.1). The status cells and the version show "—".
- Failure with no response: the same two states, with today's message for a failed connection ("Could not connect. Check your connection and try again.") and no reference (S1-C5). The shell banner (D3) shows too.

**D2.8 Phone, desktop, keyboard, and contrast.**

| | 390 × 844 | 1440 × 900 |
|---|---|---|
| Page | Manage's 12px padding; the page scrolls | The Still Page Rule: the header stays, and the column under it is the one `manage-scroll` panel. The cards should fit in Slate at 100% text, and only the panel scrolls when they do not |
| Width | The cards fill the width | One column, at most 672px, left-aligned |
| Block 1 | Icon and headline, then the check line, then "Check again" on its own row at the start (44px) | "Check again" at the top right of the card (32px) |
| Block 2 | Name above status above cause | 14rem name column, status and cause at its right |
| Blocks 5 and 6 | The same label-left rows (7rem); the paragraphs wrap | 8.5rem label column |
| Horizontal scroll | None. The reference line wraps between its parts, and a full ID breaks anywhere | None |

Keyboard order follows the DOM and the visual order. The page title takes focus by program only (`tabIndex={-1}`, as today). The tab stops are "Check again", then "Copy reference" (only in an error state), then the version link (installation owner only). The rows hold no controls. Each control uses the standard focus outline (2px `--focus`, 2px offset). No card that holds a control uses an overflow clip that could cut the outline.

Contrast (S2-C9): status words are text in ink, and the icon shape repeats the meaning, so color is never alone. Muted ink is only on the card. The icon colors are the `-text` tokens, which the guard checks at 4.5:1 on the card. Icons need 3:1. Ink on `--danger-tint` (references) and on `--warn-tint` (the banner) is not in the guard today. Add both pairs to `PAIRS` in `frontend/tooling/check-theme-contrast.mjs`, so `npm run check` covers all eight look modes. Reduced motion stops only the icon turn; the page has no other motion.

**D2.9 The Manage tab.**

- `workspace-navigation.ts`: add `{ id: "health", label: "System health" }` second in the Manage items. The order is then Organization, System health, Backup, Audit, Jobs, Updates & licensing. Every role sees System health, so it holds the same place for every role, and the sections for administrators and the installation owner follow it.
- `visibleManageItem` returns `true` for an id it does not name. So the tab shows for every role (S2-C5), also while the identity loads, with no new branch.
- `defaultItem` stays `"organization"`. Manage → Organization stays the default tab.
- The Manage query key is `view`, so the URL is `/manage?view=health` (D4, question 1). In `manage/page.tsx`, add `"System health"` to the tabs, map it to `"health"` in `manageSectionIds`, and map `health` to the tab in `manageTabFromQuery`, as `updates` is mapped today.
- The breadcrumb reads Workspace › Manage › System health.
- The Manage description (the sidebar tooltip and drawer line) changes from "Organization settings and audit" to "Organization settings, system health, and audit". A member who sees only Organization and System health then finds the page from the description.

### D3. Shell banner (S2)

**D3.1 Text.** Word for word: "Slate Operations cannot reach its server. Changes you make now may not save. It tries again on its own."

**D3.2 When it shows.** Slate Operations has not answered a request. That is one of these cases, for a request through `apiFetch` or the session refresh:

- The fetch rejects, and it is not an abort (`AbortError` never counts, because navigation and cleanup abort requests).
- A response has status 500, 502, or 504 and no `X-Request-ID` header. Such a response comes from something in front of Slate Operations when FastAPI does not run: Caddy in production (502 or 504), or the Next development proxy (500). Without this case, the banner could never show behind Caddy (D4, question 2).

A 503 from the concurrency limit and a 400 or 404 from a host check or a proxy do not show the banner. They prove that something answers, and the failing control shows its own error with no reference (D1.1).

It shows at once, with no quiet period, because changes can be lost.

**D3.3 When it clears.** At the first response that carries `X-Request-ID`, of any status, from any request. A 401, 404, or 503 from FastAPI proves that the server answers. It clears at once, with no animation.

**D3.4 Retry.** "It tries again on its own" must be true when the person does nothing. While the banner shows, the shell requests the existing unauthenticated `/api/health` after 5, 10, and 20 seconds, then every 30 seconds. The retry pauses while the tab is hidden. It runs at once when the tab becomes visible, the window gains focus, or the browser fires `online`. The person's own requests also count (D3.3).

**D3.5 Position and look.**

- New component `ServerConnectionBanner` in `frontend/src/components/server-connection-banner.tsx`, mounted by `AppShell`.
- It sits directly under the top bar, across the content column (not under the sidebar). It stays in view with the top bar when the page scrolls on a phone.
- It is in the page flow, not over the page, so it never covers a control. On a page with a fixed height, the panels get shorter by the banner's height, and the page itself does not start to scroll. OpenComms and Access have a fixed height at every width, phones included. Manage, module pages, Boards, and the Sandbox have one from 1280px. The fixed `calc(100dvh-3.5rem)` heights in `app-shell.tsx` must count the banner, for example through a flex column or a variable for the top height.
- A band: `--warn-tint` fill, a `--warn-rule` bottom rule, ink text at 14px, and the lucide `ServerOff` icon (16px, `text-warn-text`, `aria-hidden`). Padding 8px by 16px, with 20px sides from 640px to match the top bar. Minimum height 40px. On a phone the text wraps to about three lines. It is warn, not danger: it asks for attention, and the control that failed shows its own destructive error. It is not the `Alert` component, because the looks frame alerts as boxes. Only the tokens change it per look.
- It has no button: no close and no retry. It holds no focusable element, so the tab order does not change. It never moves focus, never makes the page inert, and never blocks a click.

**D3.6 Announcement.** The container is a `role="status"` region with `aria-atomic="true"`. It is in the DOM, empty, at all times, so the text is announced politely once when it shows. It is not `role="alert"`, because the control that failed already raises its own alert, and a second urgent message would cut it off. When the banner clears, the region announces "Slate Operations can reach its server again." (screen readers only). It empties after 4 seconds.

**D3.7 With the other connection messages.** One connection message at a time. While the banner shows, the "Reconnecting…" status (`session-connection-status.tsx`) and the "Session verification is temporarily unavailable." alert (`app-page.tsx`) stay hidden. The banner names the larger problem. After the banner clears, both follow their own rules again: "Reconnecting…" still waits its 5 seconds.

### D4. Open design questions

Questions 1 to 5 were answered on 2026-11-02 from the API contract above.

1. **Spec text.** Resolved: S2-C5 and "Page layout" now say `/manage?view=health`.
2. **Banner trigger.** Confirmed. Every response that passes the request middleware carries `X-Request-ID`: errors, middleware refusals, the host-check 400, `/api/health`, and the static export (file dispatch runs inside the request middleware). Responses with no header come from outside the application: the uvicorn concurrency 503, Caddy (including its 502 when FastAPI stops), the Next development proxy when FastAPI stops, and the plain 500 when the middleware itself fails. D3.2 stays as designed: a fetch failure, or a 500, 502 or 504 with no `X-Request-ID`. A 503 with no header shows as an ordinary error with no reference.
3. **Retry request.** Confirmed: `/api/health` is unauthenticated, probes nothing (`main.py:261-266`), and S2-C8 keeps it unchanged.
4. **Release-notes link.** The existing owner-only `/api/version` read. The status response carries no release fields, so it widens nothing (R4).
5. **`ApiContractError`.** Yes. It keeps the `X-Request-ID` of the response that it rejected (S1-C3 header fallback) and shows a reference like any other error.
6. **Proposed words.** The R5 sentence and block 6 say "your administrator" to every role, also to the administrator. Proposed: for an administrator, "Give this reference to the person who runs your server."; for the installation owner, no second sentence. This design keeps the approved words until a decision.
7. **Proposed for later.** A person reads "4f9c2e1a" aloud, and Audit finds only the full ID. Audit and Security events could also find the last 8 characters. Not in S1.

Questions 8 to 10 came from the Frontend Engineer during the build and were answered on 2026-11-03.

8. **A part other than Email that is Not set up.** The headline uses the same word as the row, so it does not count such a part as Not working. Today readiness reports Not set up for Email only, so this case shows only if the contract changes. Rules, which extend D2.2 and D2.3:
   - The headline has up to two sentences, in this order: one for the parts that are Not working, then one for the parts that are Not set up.
   - A sentence names one part with its subject and verb ("Files and pictures are not set up."), or two or more parts as a colon list ("Some parts are not set up: Signing in, Email.").
   - "Everything else works." follows only when exactly one of the two sentences shows and at least one part is Working or Set up.
   - All four parts Not working keep their own sentence (D2.2).
   - Icon: `CircleX` when a part is Not working, else `CircleMinus` when a part is Not set up, else `CircleCheck`.
   - Examples: "Files and pictures are not set up. Everything else works." · "Signing in is not working. Files and pictures are not set up." · "Some parts are not set up: Files and pictures, Email. Everything else works."
   - Cause lines for Not set up: Saving and loading your data, "Pages cannot load or save until the person who runs your server sets this up."; Signing in, "People cannot sign in until the person who runs your server sets this up."; Files and pictures, "Files and pictures cannot be uploaded or opened until the person who runs your server sets this up." Email keeps its D2.3 line.
9. **Help guide line.** Add this as the second `manage` entry in `frontend/src/components/help/page-guides.ts`, after Organization, in the order of the Manage tabs: "System health: the top line says whether Slate Operations works now, and Parts of Slate Operations shows the status of each part. Choose Check again to see the latest check. When an action fails, give the reference in its message to your administrator." It fills the sixth and last entry that the `PageGuide` type allows, so a later Manage section needs a wider type.
10. **The same announcement twice.** A live region speaks only when its text changes, so a second press inside 30 seconds, with the same text, can stay silent. For each result that the status span announces, empty the span first, then write the text about 150 ms later. Use one timer, and cancel it at a new result or when the page unmounts. Do not add hidden characters or change the words to force a change, and do not remount the span: screen readers often ignore a new live region. Test: two presses inside 30 seconds each change the span (empty, then the text).
11. **The banner while a modal dialog or sheet is open.** Decision: a screen-reader user hears it. A modal makes the rest of the page inert, so the banner's region inside the shell cannot speak, and the person who edits in a sheet is the one whose changes may not save. Change:
    - Export one hidden announcer from `server-connection-banner.tsx`: a `role="status"` span with `aria-atomic="true"`, empty at mount, that reads the server connection store.
    - Render it inside the shared modal content primitives in `frontend/src/components/ui/` (dialog, sheet, and alert dialog content), for modal surfaces only.
    - While it is mounted, it announces the D3.1 text when the banner starts to show, and "Slate Operations can reach its server again." when it clears, then empties after 4 seconds. It does not announce at mount, because the person heard the banner before the modal opened.
    - No visible change inside the modal: the banner stays in its place behind the backdrop, and the action that failed shows its own error. A non-modal surface does not render the announcer, so nothing speaks twice.
12. **Conflict notices.** A 409 that the page turns into a conflict notice with a way to recover ("Someone changed this first…", "This record changed after you opened it…", "Organization settings changed…") shows no reference, as the refusal notices in D1.4 do: the person fixes it, and nobody needs to find the request. A 409 that shows as an ordinary failure (today's "This item changed. Refresh it and try again.") is an error message and keeps its reference.
13. **The OpenComms refresh error band.** The band in `comms-layout.tsx` was built `absolute`, to cover the 44px connection strip only. With a reference it grows to several lines and covers the top of the panes, on a phone the conversation header and its Back button. While it shows an error, the band is in the flow above the panes, as the shell banner is (D3.5), so the panes get shorter and nothing is covered. "Refreshing conversations…" can stay over the strip, because it stays one line.

### D5. Criteria map

| Criterion | Covered by |
|---|---|
| S1-C4 | D1.2 (text), D1.3 (Copy control, name, announcement), D1.4 (each surface), D1.5 (toasts), D1.6 (keep the ID) |
| S1-C5 | D1.1 (renders nothing with no ID), D2.7 (failure with no response), D3 (no reference while the server does not answer) |
| S2-C5 | D2.9 |
| S2-C6 | D2.1 (order), D2.2 (headline), D2.3 (parts), D2.4 (Check again, 60-second and focus refresh), D2.5 (About), D2.6 (When something goes wrong), D2.7 (frame first, no curtain) |
| S2-C7 | D3.1 to D3.7 |
| S2-C9 | D2.3 (icon and word), D2.8 (390 and 1440, keyboard order, focus, contrast) |

## Design (S3, S4)

Written by the Product Designer (TASK-0008) against `main` 542102d1. `ui-ux-pro-max` set the structure, states and keyboard order; `impeccable` set the presentation inside it. No new token. Everything in "Design (S1, S2)" applies unless this section says otherwise: the card frame (D2.1), icons and words (D2.3), the refresh rules (D2.4), loading and errors (D2.7), widths and keyboard (D2.8), and `ErrorReference` (D1). The Software Architect fixes the field names; D11 lists the values this design needs. Subsections start at D6 so that D6 matches D6-C1; D7-C1 needs no design.

### D6. Reference wording by role (D6-C1)

| Viewer | `ErrorReference` line 2 (D1.2) | Block 6, paragraph 1 ends with | Block 6, paragraph 2 |
|---|---|---|---|
| Member, guest, or no known role | "Give this reference to your administrator." | "Give this reference to your administrator." | "When Slate Operations does not load: wait a minute and reload. If it still does not load, tell your administrator." |
| Organization admin who does not own the installation | "Give this reference to the person who runs your server." | "Give this reference to the person who runs your server." | "… If it still does not load, tell the person who runs your server." |
| Installation owner (`installationOwnerFor`) | No line 2: no sentence, no empty line. Line 3 (copy failed) is unchanged | Ends after "with a Copy button." | "… If it still does not load, check that your server is running." |

- In paragraph 2, "…" stands for the member row's first sentence, word for word: "When Slate Operations does not load: wait a minute and reload."
- The installation owner wording wins when the owner is also an admin. The role is the current membership role of the bound organization, the same test as the Jobs tab. An organization switch changes the words in place.
- While the identity loads, and on pages with no identity (sign-in, invitation, recovery), the member words show.
- Recommendation for the engineer: give the viewer once, from `AppPage`, to every `ErrorReference` (Alerts, toasts, inline lines). A prop at each caller would keep the member words wherever a caller forgets it. The mechanism is the engineer's decision.
- The help guide line (D4, answer 9) stays the same for every role: the guides are not role-aware.

### D8. Your organization (S3)

**D8.1 When it shows.** Block 3 sits between blocks 2 and 5 and comes from the same status request, so nobody makes an extra request (S3-C5).

- After a result: the card renders only when the response carries the organization part. Without it there is no card, no heading and no gap (D2.1). This covers members, guests, department managers, and an admin whose role changed since the identity loaded.
- First load: the card frame and its skeleton render only when the identity says the person is an admin of the bound organization. While the identity loads, nothing renders there.

**D8.2 Frame.** A card with a 56px header and the `h2` "Your organization". The body is a `dl` with the block 2 grid (D2.3): a 14rem muted label column from 640px, the label above the value below 640px, 12px between rows. The value columns of blocks 2 and 3 then line up. Rows, always in this order: Backups, Failed jobs, Sign-in activity. In each value cell, line 1 is ink at weight 500, line 2 is muted, and the link comes last. Links use the D2.5 link style (`text-action-text`, 44px tall below 1280px) through `GuardedWorkspaceLink`.

**D8.3 Backups.** These status words extend R2 for this row only. Each shape has one meaning on the page: `CircleMinus` is "not set up" here as in block 2, and Late gets a shape of its own.

| State | Icon (16px, `aria-hidden`) | Line 1 |
|---|---|---|
| On time | `CircleCheck`, `text-flow-text` | "On time" |
| Late | `CircleAlert`, `text-warn-text` | "Late" |
| No schedule | `CircleMinus`, `text-warn-text` | "No backup schedule" |
| Never backed up | `CircleX`, `text-danger-text` | "No backup yet" |

Line 2 has up to two parts, joined by " · ":

- "Last good backup today at 02:00", or "Last good backup on Nov 1 at 02:00". This is the time of the last successful backup, in local time with no seconds, with the D2.2 check-line formatter and its same-day rule. Leave this part out when there is no successful backup.
- "Latest run: Verified". The result word of the last run uses the Backup words from `backupRunStatus`: Queued, Running, Verified, Completed, Failed, Interrupted, Expired. Leave this part out when no run exists.
- With neither part, line 2 reads "No backup has run yet."

Examples: "Last good backup today at 02:00 · Latest run: Verified" (on time). "Last good backup on Oct 30 at 02:00 · Latest run: Failed" (late).

Line 3 shows only for Late, No backup schedule, and No backup yet. The installation owner sees the link "Open Backup" (`/manage?view=backup`). Any other admin sees the muted line "The person who runs your server manages backups.", because Backup is owner-only. On time has no line 3. No sizes, paths, run lists or failure codes show (S3-C2).

**D8.4 Failed jobs.** No icon: a count is not a status (R6).

- Line 1: "No failed jobs in the last 7 days" · "1 job failed in the last 7 days" · "12 jobs failed in the last 7 days". Numbers use the workspace locale and tabular figures.
- Line 2: the link "Open Jobs" (`/manage?view=jobs`), at every count.
- The Jobs filters are page state with no URL, so the link opens the plain list. That list shows every age and state and does not equal the count. Do not add a filter to the URL in this slice. The page shows the count from the server as it is. Backup jobs count for the installation owner only (S3-C3).

**D8.5 Sign-in activity.** No icon.

- Line 1, by the two counts: "No failed sign-ins or lockouts in the last 7 days" · "3 failed sign-ins in the last 7 days" · "1 lockout in the last 7 days" · "1 failed sign-in and 2 lockouts in the last 7 days". The singular is "failed sign-in" and "lockout". The plural is "failed sign-ins" and "lockouts". A count of zero is left out unless both counts are zero.
- Line 2: the link "Open Security in Access" (`/access?view=security`). Its text has no arrow, because a screen reader reads the arrow aloud.

**D8.6 Loading, refresh and errors.**

- First load: one `LoadingRegion` for the block, with the label "Loading system status". The three labels render at once. Each value is a 160px bar, with a 16px circle before it on Backups. The 300ms rule applies.
- Each result updates block 3 in place, with no animation: the 60-second refresh, the focus refresh, and "Check again". Block 3 never changes the R3 headline or its icon, because the headline answers whether Slate Operations works.
- The D2.4 "same result" comparison includes the organization part. When a block 3 value changed and the parts did not, the check line gets no "No change" suffix. A press announces the changed-result text ("{headline} Checked at 10:43."). Block 3 changes are never announced on their own.
- A failed status read follows D2.7. After a good result, the last block 3 values stay and the block 1 Alert covers the whole page. Before any result, the values show "—" and the links stay. Block 3 never shows an Alert of its own.
- Keyboard: after "Check again" and "Copy reference" come "Open Backup" (owner, when it shows), "Open Jobs", "Open Security in Access", and then the version link.

### D9. Your sign-in history (S4)

**D9.1 Place.** Settings → Sign-in → the Sessions row, below "Sign out other sessions", in the same `SettingsRow`. Section titles in Settings are `h2`, so the sub-heading is the `h3` "Your sign-in history" (14px, weight 600, ink, 16px above it). Under the heading is one muted line: "Sign-ins, failed attempts and ended sessions on your account, newest first. If you do not recognize one, change your password." The Password row with "Change…" is just above.

**D9.2 Rows.** An `ol` with `aria-label="Your sign-in history"`. Its frame is the frame of the active sessions list: a bordered list with a container query and rows that the `SessionRow` grammar builds, but with no ⋯ menu, so a row holds no control. Each row has:

- a 16px icon (`aria-hidden`);
- the sentence (ink, weight 500);
- the meta line (muted, 13px, tabular figures): "{device} · {address} · {time}".

The device comes from `accountDeviceLabel` ("Chrome on macOS", else "Unknown device"), with the full user agent as its `title`. The address is the IP address, else "Unknown address". The time uses `formatWorkspaceDateTime` with the same region states as the active sessions ("Loading organization date settings…", "Time unavailable").

| Event | Icon | Sentence |
|---|---|---|
| Successful sign-in | `LogIn`, muted | "Signed in" |
| Failed attempt, one row for each attempt | `ShieldAlert`, `text-danger-text` | "Sign-in failed" |
| Failed attempts, one row with a count (D11, item 3) | the same | "1 failed sign-in attempt" · "4 failed sign-in attempts" |
| Lockout | `Lock`, `text-warn-text` | "Sign-in paused after too many failed attempts" |
| Session ended by you, on that device | `LogOut`, muted | "You signed out" |
| Session ended by you, from another device | the same | "You ended this session from another device" |
| Session ended by an administrator | the same | "An administrator ended this session" |
| Ended when your password changed, or by an account recovery | the same | "Ended when your password changed" · "Ended by an account recovery" |
| Ended when two-step sign-in changed | the same | "Ended when two-step sign-in changed" |
| Ended by the session limit | the same | "Ended because a newer sign-in replaced it" |
| Ended for an unknown reason | the same | "Session ended" |

The device, address and time of an ended session belong to the session that ended. The time is when it ended. The administrator gets no name: an account can belong to several organizations, so a name could show an admin of another organization. "An administrator" is enough to act on. The words carry the meaning, and the icons repeat it.

**D9.3 Paging: "Show older".** The list shows the 10 newest events. An outline button "Show older" under the list (44px below 1280px, 32px from 1280px) adds the next 10 below them. It is not `TablePagination`: that control needs a total and a page-size select, which is too heavy for a Settings row, and a sign-in log is read from the newest back.

- While a page loads, the button keeps its label and takes `aria-disabled` and `aria-busy` (as D2.4 does). Do not use `disabled`.
- After a page loads, focus moves to the first new row (`tabIndex={-1}`, with the standard outline). A screen reader then reads it, and the next Tab reaches "Show older" again.
- With no older events, the button is removed. A first page of fewer than 10 rows shows no button.
- When a page fails to load, the rows stay. Under them, the active-sessions error block shows "Older sign-in events could not be loaded.", the button "Retry", and `ErrorReference`.

**D9.4 States.**

- Loading: a `LoadingRegion` with the label "Loading sign-in history…" and three 40px skeleton rows.
- Empty: "No sign-in events are recorded yet." (muted, 44px line).
- Error: the active-sessions error block with "Sign-in history could not be loaded. Try again.", the button "Retry sign-in history", and `ErrorReference`.
- Refresh: the history reads when Settings opens. It reads again after an End session or "Sign out other sessions" succeeds, so the new ended-session row shows. There is no poll and no focus refresh (`frontend/AGENTS.md`).

**D9.5 Phone and desktop.** At 390px, a row has two lines: the icon and sentence, then the meta line (at least 56px). The meta line wraps between its parts, each part stays whole, and an IPv6 address breaks anywhere. From the container width at which the active sessions go to one line, a row is one 40px line with the meta at the right. There is no horizontal scroll at any width.

### D10. Record history for readers (S4)

**D10.1 Who sees it.** The History tab shows to every person who can open the record (S4-C5), records opened through a cross-department link included. `canReadHistory` in the OpenView workspace and in the Boards card sheet changes from "manage on the department" to "the record is open in the sheet, and the sheet knows the department of the record" (the history read sends `department_id`, as the Boards guard `departmentId !== ""` shows today). The old manage-level test stays, under a new name such as `managesHistory`, for the text rule in D10.2. The tab order does not change: Details, Linked records, Files, History.

**D10.2 One panel; the server decides the content (S4-C4).** The layout and the states have no role branch. Only the entries and fields that arrive differ, and the one text rule in item 2 depends on `managesHistory`:

| | Admin and department manager | Every other reader |
|---|---|---|
| Entries | Every entry, as today | Created, Deleted and Restored, plus each change entry with at least one readable change |
| Fields in an entry | All | Readable fields only |

Read access is per module today, and there is no field-level read rule. The Software Architect defines a readable field (D11, item 4). Whatever that definition is, what is left out leaves no trace:

1. The server leaves out a hidden field: its name and both values. It also leaves out an entry whose only changes are hidden, so the number of entries hints at nothing.
2. In the panel of a non-manager reader, a key that is not in the panel's field list is dropped. An entry that then has no change is dropped. This is the second guard; the server is the first. A reader never sees "a field that is no longer shown", "Updated the record" from an entry with no named change, a "Hidden" value, or a count of fields left out. A redacted value counts as hidden for a reader.
3. Admins and department managers keep today's text, "a field that is no longer shown" for a retired field included.

**D10.3 What an entry shows.** This applies to everyone. The owner decision adds old and new values, so the display changes for managers too. Their visibility does not change (S4-C3).

- Line 1: the sentence from today's `describe` ("Changed Status, Amount", "Created the record", "Deleted the record", "Restored the record").
- Line 2: today's muted "{who} · {time}". When the name is unknown, the fallback word stays "Someone".
- Under a change entry: one row for each readable change. Each row has the field name (muted), the old value (muted, `line-through`; "Not set" without the line), a hidden "to", the 14px `ArrowRight` (`aria-hidden`), and the new value (weight 600). These are the "What changed" rows of the Audit event sheet, built through `auditChanges`. A reference reads as its loaded name, else "Set", "Changed" or "Removed", never as an ID. Values wrap anywhere. Created, Deleted and Restored entries have no rows.
- Names today come from `assignableUsersOptions(moduleId)`, which lists only the readers of the module, and only one page of them. A person who opened the record through a link may not read its module, and the person who made the change may have left. So each entry needs a display name from the server (D11, item 4).

**D10.4 States.** Loading keeps today's "Loading history…". Empty keeps "No changes are recorded for this record.", also when every entry was left out. The error state keeps "History could not be loaded." and Retry, and adds `ErrorReference` after Retry (D1.4). Today that reference is missing, which is an S1-C4 gap on this surface. The tab shows only inside an open record. A record that the person cannot open shows the sheet's own not-found state, never a history error (S4-C3). The limit stays 50 entries with no paging. On a phone, a change row wraps between the name and the values, with no horizontal scroll.

### D11. Values this design needs from the contract

For the Software Architect. Items marked Proposed are design proposals, not decisions.

1. **Backups.** The state (on time, late, no schedule, never backed up), the time of the last successful backup, and the state of the latest run with its verified and expired facts, enough to choose a `backupRunStatus` word. Proposed: "never backed up" starts only after the first due time plus 1 hour. Before that, the state is on time, and line 2 reads "The first scheduled backup has not run yet."
2. **Counts.** Failed jobs, failed sign-ins and lockouts as whole numbers. Proposed: a lockout is not also counted as a failed sign-in.
3. **Own sign-in history.** The event kinds. Whether failed attempts give one row for each attempt or one representative row with a count (`append_representative_failure`): this chooses the D9.2 sentence. Which enders the history can tell apart (you on that device, you from another device, an administrator, a password change, an account recovery, a two-step change, the session limit, an idle expiry), with "Session ended" for the rest. Today `revoke_session` stores no reason. The user agent, the IP address and the time for each row. Pages of 10, newest first, with a sign that more exist; a cursor or an offset both work, and no total is needed. Whether the list covers the whole account (Proposed, because sessions are account-wide) or the bound organization only.
4. **Record history.** The definition of a readable field. The server leaves out hidden fields and the entries that only change them. A redacted value counts as hidden for a reader. Whether `department_id` stays required on the history read of a record opened through a link (D10.1). Each entry carries a display name of the person who made the change, because `assignable-users` cannot give it to every reader.
5. **D6.** No contract value. The identity already carries the role and the installation owner flag.

### D12. Criteria map

| Criterion | Covered by |
|---|---|
| S3-C5 | D8.1 (admins only, no extra request), D8.2 (frame and order), D8.3 (Backups), D8.4 (Failed jobs and its link), D8.5 (Sign-in activity and its link), D8.6 (loading, refresh, errors, keyboard) |
| S4-C2 | D9.1 (place and heading), D9.2 (rows and words), D9.3 (paging), D9.4 (empty, loading, error), D9.5 (phone) |
| S4-C4 | D10.2 (hidden fields, their names and values left out, no hint), D10.3 (readable changes only) |
| S4-C5 | D10.1 (tab for everyone who can open the record), D10.4 (states) |
| D6-C1 | D6 |
| D7-C1 | D13, item 3 (Reference field timing and words) |

### D13. Answers to the Frontend Engineer (screen review, 2026-11-03)

These extend D8, D9 and the Reference filter. Each answer gives its one-line reason.

1. **Backup state `unknown`, and a missing failed-jobs count.** The server sends both when it cannot read the installation, so they show together. Do not show a bare "—": an admin cannot act on it.
   - Backups: `CircleDashed` (`text-muted-foreground`). In block 2 this icon already means "cannot confirm". Line 1: "Cannot be checked". Line 2: "Slate Operations cannot read the backup state now." Line 3 is the same as for Late: "Open Backup" for the installation owner, else "The person who runs your server manages backups."
   - Failed jobs: line 1 "The failed job count cannot be read now." The "Open Jobs" link stays.
   - D11, item 1 was not adopted: a new schedule shows "No backup yet" until the first backup succeeds. This stays as built, because it is true and line 2 says "No backup has run yet."
2. **Who ended a session, and how many attempts failed.** Confirmed: rows read "Session ended" and "Sign-in failed", the D9.2 fallbacks. The other D9.2 sentences apply only when the contract can tell the ender or carries a count. Do not guess them from other events.
3. **Reference field (D7-C1).** Keep the words: "Enter the 8 characters of a reference, or its full ID." Change the timing:
   - While the person types, show no error and change nothing on the page. The last list stays, and the request keeps the last valid reference or none.
   - Check the field on blur and on Enter. When it is not valid, show the field error and leave the reference out of the request.
   - The error clears as soon as the field holds a valid reference or is empty.
   - Reason: today every keystroke before the 8th shows the error, and Security events swaps the list for "Check the filter values to review security events." The list flickers away while the person types a valid reference.
4. **Sign-in history when the identity read fails.** The active sessions above already show "Sessions could not be loaded. Try again." with "Retry sessions" and the reference, and that retry reads the identity again. So the history shows no second error block and no skeleton. Under its heading and intro, it shows one muted line: "Your sign-in history shows when your sessions load." It has no "Show older". After a successful retry, the history loads with its own D9.4 states. Reason: one cause, one error, one retry. A skeleton that never ends says "Loading" for ever.

## Design (S5, S6)

Written by the Product Designer (TASK-0014) against `main` 856d859d. `ui-ux-pro-max` set the structure, states and keyboard order; `impeccable` set the presentation inside it. No new token. "Design (S1, S2)" and "Design (S3, S4)" apply unless this section says otherwise: the card frame (D2.1), icons and words (D2.3), refresh and announcements (D2.4), loading and errors (D2.7), widths and keyboard (D2.8), `ErrorReference` with the D6 wording, the block 3 grid (D8.2), and "Show older" (D9.3). The Software Architect fixes the field names; D20 lists the values this design needs. Items marked Proposed are design proposals, not decisions.

### D14. Slow (S5-C4)

**D14.1 The word.** Slow is a fifth status word for a part, in block 2, in the headline and in the timeline (D15).

| Word | Icon (lucide, 16px; 20px in the headline) | Icon color |
|---|---|---|
| Slow | `CircleGauge` | `text-warn-text` |

No other word on the page uses the gauge shape (`CircleCheck`, `CircleDashed`, `CircleMinus`, `CircleX`, `CircleAlert`), so the shape repeats the word. Not working always wins: a part whose check fails shows Not working, never Slow. The page shows the word the response gives and never computes Slow from check times (D20, item 1). Proposed: Email is never Slow, because its word comes from real sends (D16), not from a timed check.

| Part | Cause line for Slow (muted, under the word) |
|---|---|
| Saving and loading your data | "Pages may load and save more slowly than usual." |
| Signing in | "Signing in may take longer than usual." |
| Files and pictures | "Files and pictures may upload and open more slowly than usual." |
| Email (only if the Proposed rule above is declined) | "Email may take longer than usual." |

**D14.2 Headline.** This extends D2.2 and D4 answer 8.

- Up to three sentences, in this order: Not working, Slow, Not set up.
- The Slow sentence has no "not". One part: "Saving and loading your data is slow." · "Signing in is slow." · "Files and pictures are slow." Two or more: "Some parts are slow: Signing in, Files and pictures."
- "Everything else works." follows only when exactly one sentence shows and at least one part is Working or Set up. A Slow part does not count as working.
- All four parts Not working keep their own sentence (D2.2).
- Icon: `CircleX` when a part is Not working, else `CircleGauge` (warn) when a part is Slow, else `CircleMinus` when a part is Not set up, else `CircleCheck`.
- Examples: "Signing in is slow. Everything else works." · "Email is not working. Files and pictures are slow." · "Files and pictures are not working. Signing in is slow. Email is not set up."

### D15. The last 30 days (S5-C3)

**D15.1 Place.** Inside block 2, under the parts list, so each part's history sits with its status and the block numbers stay. A top rule (`border-border`) separates it. The sub-heading is the `h3` "Last 30 days" (14px, weight 600, ink), and the list is an `ol` labelled by it. No graph for anyone, the installation owner included: one sentence per period gives the part, the state, the day and the length, which is all that a graph would show (R6).

**D15.2 Rows.** The D9.2 row grammar with no control: a 16px icon (`aria-hidden`), the sentence (ink, weight 500), and a muted meta line (13px, tabular figures). "Did not work" rows use `CircleX` (`text-danger-text`); slow rows use `CircleGauge` (`text-warn-text`).

| Part | Ended, not working | Ended, slow | Still going, not working | Still going, slow |
|---|---|---|---|---|
| Saving and loading your data | "Saving and loading your data did not work for {length} {day}." | "Saving and loading your data was slow for {length} {day}." | "Saving and loading your data has not worked since {time} {day}." | "Saving and loading your data has been slow since {time} {day}." |
| Signing in | "Signing in did not work for …" | "Signing in was slow for …" | "Signing in has not worked since …" | "Signing in has been slow since …" |
| Files and pictures | "Files and pictures did not work for …" | "Files and pictures were slow for …" | "Files and pictures have not worked since …" | "Files and pictures have been slow since …" |
| Email | "Email did not work for …" | "Email was slow for …" (only if D14.1's Proposed rule is declined) | "Email has not worked since …" | "Email has been slow since …" (the same) |

- Meta line of an ended period: "10:42 to 10:54"; across midnight, "Nov 1 at 23:50 to Nov 2 at 01:10". Of a period still going: "Still going". Times are local, with no seconds, through the D2.2 formatter.
- Not set up and Set up are not problems and make no row.

**D15.3 Lengths.** From the start to the end, in whole minutes, at least 1 minute. A part that is zero is left out. Numbers use the workspace locale; "1" takes the singular.

| Length | Reads | Examples |
|---|---|---|
| Under 60 minutes | minutes | "1 minute" · "12 minutes" |
| 60 minutes to under 24 hours | hours, then minutes | "1 hour" · "1 hour 30 minutes" · "5 hours 1 minute" |
| 24 hours or more | days, then hours; minutes are dropped | "1 day" · "2 days 3 hours" |

A Slow period lasts at least 3 samples, so it does not read "1 minute" in practice. The page does not enforce this.

**D15.4 Days.** The day of the start, in the organization time zone, with the `signInWhen` steps but the long weekday, because the day sits in a sentence:

| Start | {day} | Example |
|---|---|---|
| Today | "today" | "Email has not worked since 10:42 today." |
| Yesterday | "yesterday" | "Signing in was slow for 4 minutes yesterday." |
| 2 to 6 days ago | "on Tuesday" | "Email did not work for 12 minutes on Tuesday." |
| 7 days ago or more | "on Nov 1" | "Files and pictures did not work for 1 hour 30 minutes on Nov 1." |

**D15.5 Order and paging.** Periods still going come first, then ended periods by end time, newest first. The list shows the 5 newest rows. "Show older" under the list adds 10 rows at a time, with every D9.3 rule: outline button, busy as `aria-disabled` and `aria-busy`, focus to the first new row, removed when nothing older exists. When older rows fail to load, the rows stay, with "Older periods could not be loaded.", "Retry" and `ErrorReference`. A refresh keeps the number of rows the person opened.

**D15.6 Empty and short history.**

- No period in 30 days: "No problems in the last 30 days." (muted, 44px line, no icon).
- Proposed: when the oldest sample is younger than 30 days, "No problems since Nov 3." takes its place, because the 30-day sentence would claim days that were not checked. With no sample yet: "No history is recorded yet." (D20, item 2.)

**D15.7 Loading, refresh, errors.** When the periods come in the status response, they follow block 2: one `LoadingRegion` (three 40px skeleton rows under the heading), D2.7 on failure, an update in place at each result. When they have their own read, they get the D9.4 states: "Loading the last 30 days…", then "The last 30 days could not be loaded.", "Retry" and `ErrorReference`. A timeline change is never announced on its own and never changes the headline.

**D15.8 Phone.** At 390px a row has two lines and is at least 56px tall. The meta line wraps only around "to", and each time stays whole. No horizontal scroll.

### D16. Email after S5 (S5-C5)

The four words stay. Their source and two cause lines change.

| Word | When (S5-C5) | Icon | Cause line |
|---|---|---|---|
| Working | A recent send succeeded | `CircleCheck` | None |
| Not working | Recent sends failed | `CircleX` | "Invitations and password emails may not arrive until email works." |
| Set up | Email is configured, and no recent send has an outcome | `CircleDashed` | "No email was sent recently, so Slate Operations cannot confirm that it works." |
| Not set up | Email is not configured | `CircleMinus` | Unchanged (D2.3) |

- "Slate Operations cannot yet confirm delivery." goes. Set up now means "no recent send to judge by".
- The old Not working line said that messages wait. This design does not know that a failed send is retried, so the new line promises no wait and no retry.
- The page shows Working only when the response says Working. The headline rules do not change: Set up counts as working, and Not working is named.

### D17. File storage in block 3 (S5-C7)

A fourth row in block 3, after Sign-in activity, in the D8.2 grid. The label is "File storage". No icon, because a size is not a status. No link, because no page lists storage by organization.

- Line 1 (ink, weight 500): "Files use 1.2 GB". With no files: "No files are stored yet". Under 1 KB: "Files use less than 1 KB". When the server cannot read it: "File storage cannot be read now."
- Line 2 (muted), always: "Storage limit: not set yet".
- Sizes, here and in D18: decimal units (1 KB = 1,000 bytes), so the unit names are exact: B, KB, MB, GB, TB. Use the largest unit with a value of 1 or more; one decimal under 10 ("1.2 GB"), whole numbers from 10 ("12 GB", "340 MB"); a trailing ".0" is dropped. `Intl.NumberFormat` with `style: "unit"` and `unitDisplay: "short"` in the workspace locale.
- Loading adds a fourth 160px skeleton bar (D8.6). Members, guests and department managers get no block 3, so no storage.

### D18. Installation, block 4 (S5-C6)

**D18.1 When it shows.** Between blocks 3 and 5, for the installation owner only. D8.1 applies: after a result, the card renders only when the response carries the installation part; before one, only when the identity says owner (`viewer === "owner"`). Nobody else gets a card, a heading, a gap or a request. No host disk figure (owner decision for S5).

**D18.2 Rows.** A card with a 56px header and the `h2` "Installation", then a `dl` in the D8.2 grid, always in this order:

| Row label | Worker or value (S5-C6) |
|---|---|
| Database size | the database size |
| Record triggers | record-trigger worker |
| Scheduled reports | report scheduling worker |
| OpenComms jobs | Comms job worker |
| Sign-out cleanup | provider sign-out worker |
| Backup runner | backup runner (its existing heartbeat) |

The labels name what each worker does, checked in the code: report scheduling sends OpenView's scheduled reports, and provider sign-out finishes ending a session at the sign-in provider after Slate Operations ends it (`provider_signout.py`).

**D18.3 Values.** Database size, line 1, with no icon and the D17 size rules: "1.4 GB"; unreadable: "Cannot be read now." Each worker:

| State | Icon | Line 1 (ink, weight 500) | Line 2 (muted) |
|---|---|---|---|
| Running | `CircleCheck`, `text-flow-text` | "Running" | None |
| Seen before, not recently | `CircleX`, `text-danger-text` | "Not seen since 10:42" · "Not seen since Nov 1 at 23:58" | "Its work waits until it runs again." |
| Never seen | `CircleDashed`, `text-muted-foreground` | "Not seen yet" | "Check that it runs on your server." |

The time uses the D2.2 formatter and its same-day rule. The server decides the state and how long "recently" is (D20, item 5). Block 4 never changes the headline (as D8.6). Loading: one `LoadingRegion` ("Loading system status"), the six labels at once, a 120px bar for each value with a 16px circle before each worker bar. A failed read follows D8.6. Below 640px the label sits above the value.

### D19. Support file (S6-C2 to S6-C4)

**D19.1 Place.** Block 6, "When something goes wrong", gains a third paragraph and one button, for organization admins and the installation owner. Members and guests see neither, and while the identity loads nothing renders there (S6-C4). Reason: a person downloads this file to report a problem, and block 6 is where the page says how to report one. Alternative not taken: a header action on block 3 (admin) and block 4 (owner), which puts one action in two places beside status values it does not change.

**D19.2 Words and file.**

| Viewer | Paragraph 3 | File name |
|---|---|---|
| Organization admin who does not own the installation | "A support file helps the person who runs your server find a problem. It lists the versions, the last 30 days of the parts, your organization's file storage, and its recent server errors with their references. It holds no records, no personal data and nothing from other organizations." | `slateops-diagnostics-organization-20261105-1042Z.json` |
| Installation owner | "A support file helps whoever supports your installation find a problem. It lists the versions, the database size, the background workers, each organization's file storage, 30 days of checks, and recent server errors with their references. It holds no records and no personal data." | `slateops-diagnostics-installation-20261105-1042Z.json` |

- The owner gets the installation file only, also as an admin of the organization. It lists each organization's file storage total (parent decision, 2026-11-05; D20, item 7).
- The name follows the server-set `slateops-` names (`slateops-audit.csv`, `slateops-sandbox.json`), with the UTC time of the download, because the times inside the file are UTC. The server sets it in `Content-Disposition`.
- "No personal data" rests on S6-C1. If the contract adds a personal value, this sentence changes.

**D19.3 Button.** `Button`, variant outline: the lucide `Download` icon (16px, `aria-hidden`), then "Download support file". 44px tall below 1280px, 32px from 1280px. It sits under paragraph 3 at the start, never full width. Keyboard order of the page (extends D8.6): "Check again", "Copy reference" (error), "Show older", the block 3 links, the version link, "Download support file", then the "Copy reference" of its Alert.

**D19.4 States.** The download is a fetch with the session, then a save through `URL.createObjectURL`, as in `export-dialog.tsx`, so a failure can show its message and reference. A plain link would turn a failure into a browser error page.

- Busy: the label stays; `aria-disabled` and `aria-busy`; presses are ignored (D2.4). A `role="status"` span beside the button, empty from the first render, shows "Preparing the support file…" after 300ms, so a fast download shows nothing.
- Success: the browser saves the file. The span shows "Support file downloaded." for 4 seconds, then empties. Focus stays on the button.
- Failure with a response: a destructive `Alert` under the button: "The support file could not be prepared. Try again in a minute." and `ErrorReference` with the D6 wording (the owner reads no line 2). It closes at the next press.
- Failure with no response: the same Alert with "Could not connect. Check your connection and try again." and no reference (S1-C5).
- 403, because the role changed after the page loaded: "Only an administrator can download a support file." with no reference, as a refusal notice (D1.4). The paragraph and the button go at the next identity read. A 401 follows the signed-out behavior (D2.4).

### D20. Values this design needs

For the Software Architect, unless an item says otherwise.

1. **Slow.** A Slow status value for data, signing in and files, with Not working already winning. Proposed: the server decides Slow, so the rule lives in one place; Email is never Slow.
2. **Timeline.** For each period: the part, the kind (not working or slow), the start, and the end or a sign that it is still going. Whether periods come in the status response or in their own read, and how older periods load (5 first, then 10 at a time). Proposed: the time of the oldest kept sample (D15.6).
3. **Email.** The status word only. The length of "recent" is the server's.
4. **Storage.** The bytes in use by the organization's files, or a sign that the server cannot read them. Whether files in the trash count.
5. **Installation.** The database size in bytes, or a sign that it cannot be read. For each of the five workers: running, not seen recently, or never seen, and the last-seen time. The staleness limit for each worker.
6. **Support file.** One download read for each role, the file name in `Content-Disposition`, and `request_id` in its error body (S1-C1).
7. **Owner file.** Decided by the parent (2026-11-05): one file for the owner, and it lists each organization's file storage total.
8. **Frontend, no contract value: "No change" (D2.4).** The same-result comparison adds the storage bytes and each worker's state and not-seen time. It does not add the periods (D22, item 1). It leaves out the database size, a running worker's last-seen time and the growing length of a period still going. They change every minute, so the owner would never see "No change".
9. **Spec text out of date, for the spec owner (not edited here).** R2's Email note and S2-C3 say Email never reads Working; S5-C5 replaces both. "Page layout" block 4 names disk free, which the owner dropped. "Page layout" block 6 does not name the support file.

### D21. Criteria map

| Criterion | Covered by |
|---|---|
| S5-C3 | D15.1 to D15.8 |
| S5-C4 | D14.1 (word, icon, cause lines, Not working wins), D14.2 (headline), D15.2 (slow rows) |
| S5-C5 (UI) | D16 |
| S5-C6 (UI) | D18.1 to D18.3 |
| S5-C7 | D17 |
| S6-C2 (UI) | D19 (owner row of D19.2), D22 |
| S6-C3 (UI) | D19 (admin row of D19.2) |
| S6-C4 (UI) | D19.1 (no paragraph and no button for members and guests) |

### D22. Answers to the Frontend Engineer (screen review, 2026-11-05)

These change D15, D17 and D20 as written. Each answer gives its reason.

1. **"No change" leaves out the periods.** Confirmed. The periods come from their own read, which "Check again" does not send, so comparing them would compare a value that the press did not refresh.
2. **"Check again" refreshes the status only; the timeline polls every 60 seconds on its own, while the page is visible, with no focus refresh.** Confirmed. Samples are taken once a minute, so a refetch on the press would gain at most a minute. The timeline can trail the parts list by up to about 2 minutes, for example a "Still going" row beside a part that reads Working again. The parts list is the current answer, and the timeline is history.
3. **Units B, KB, MB, GB, TB.** Confirmed: this is D17. `Intl.NumberFormat` formats the number only, because its own unit names ("kB", "byte") differ from D17.
4. **"No problems since <date>." when the oldest sample is younger than 29 days.** Confirmed. Hourly deletion makes a full history up to a few minutes younger than 30 days, so a 30-day limit would show the date for a full history. A history 29 to 30 days deep reads "in the last 30 days", which can claim at most one unchecked day, once in the life of an installation. D15.6 is no longer Proposed.
5. **Timeline rows have two lines at every width.** Confirmed. A period sentence runs to about 70 characters, so a one-line row with the meta at the right (D9.5) would truncate or wrap at 1440px. D15.8 applies at every width.

## Deferred

These come after the client side ships, from the 2026-11-02 reference:

- Error tracking for the backend and frontend (Sentry or self-hosted GlitchTip).
- An external uptime check on `/api/health`.
- `/metrics`, a Grafana dashboard, release markers, traces.
- A tenant view of error rate by organization, from logs only (never a metrics label).
- Gatus, considered in the Tier 2.6 session. It is a developer and operator tool; S5 can adopt it later as its engine if it fits then.

## Open questions

None. The S4 and S5 questions were answered on 2026-11-03 (see "Owner decisions for S3 to S6").
