# Sample packs: natural data and the remaining packs

Status: **approved by the owner** (2026-10-27); P0 merged in PR #70, P1–P3 in progress on `sample-pack-realism-p1` (2026-10-28). Baseline: `main` at `e1e9fc6f` (after PR #67 Profile, #68 OpenView department pages, #69 Boards team space).

## Outcome

Every sample pack produces data that looks like a real organization after a year of use. Charts, dashboards, calendars and Kanban boards show uneven, believable shapes, and the data includes the small mistakes people make. The five remaining packs (Clinic, Nonprofit, Local government, FMCG distributor, Manufacturer) are built on these rules from the start. Each pack then runs once at Large into its `sample-<pack>` organization and stays in the development database as permanent dummy data. All later API smoke runs use disposable stacks.

## Non-goals

- No new API routes, bulk endpoints or schema changes. Population keeps the routes that people use in the UI.
- No OpenComms population (still excluded).
- No change to the controls' job: they still check status, shape and end state.
- No top-up mode for organizations that already hold data. A later need for new data goes into a new organization.

## What the review found

### Why the current data looks clean

| Source | Current code | What a chart shows |
|---|---|---|
| Statuses and choices | `options[(index + seed) % len]` in `packs/harbor/generation.py` | Every status has the same count |
| Amounts | `1_000 + (index * 137) % 10_000`, `500 + randrange(0, 9_000, 25)` | A flat histogram with no long tail and no round numbers |
| Dates | `randint(-365, latest)` in `packs/harbor/dates.py` | A flat line over the year: no weekdays, month-end or seasons |
| Times | `8 + index % 9`, `(index * 7) % 60` | A perfect grid of entry times |
| Workload | Two weights only: lead and member (`actors.writer_weights`) | Every member does the same amount of work |
| Blanks | `index % 7`, `% 9`, `% 5` | Exactly every Nth record has a blank field |

School uses the same patterns.

### What the three new PRs changed for the packs

| Area | Current seeding | Gap against the new system |
|---|---|---|
| Department dashboards (#68) | `population/openview.py::_dashboard_widgets` gives every department the same 4 widgets from one module. All 4 count records by the first Select field and fill 14 of the 20 grid cells. | No sums or averages, no `date_series` trends, and no widgets from linked modules. With the equal status split, the bar chart is flat. This is the main reason the graphs look clean. The query API already supports `sum`, `average`, `min`, `max`, `distinct` and `date_series` with buckets. |
| Kanban (#69) | One Kanban per pack (Harbor Sales, School Academic) with 12 cards that have `due_on` only | Gantt rows need `start_on`. Other department boards have no Kanban. Card counts do not grow with the profile. |
| Calendar sources (#69) | Only the controls create them, and the controls clean them up | Announcements calendars and My calendar show no module dates in a seeded organization |
| Supporting content | Posts, events, reminders, Kanban cards, views, dashboards and reports are fixed counts for every profile | A Large organization with 20,000+ records still has 96 posts and 12 cards |
| Saved views | Table, Grid and Gallery only (Kanban, Calendar and Timeline layouts were removed) | Correct now; no change needed |
| Documents | `docs/plans/sample-pack-contract.md` (Boards section) and `docs/plans/ui-equivalent-sample-data-plan.md` still describe Board widgets and portability, which #69 removed | The documents disagree with the code |
| Live evidence | The last live sample run is Harbor Small on 2026-10-17, before all three PRs | The runner on `main` has unit tests only, no live run |

The handoff `.agent-runtime/CODEX-SAMPLE-PACKS-HANDOFF.md` §16 still says the packs are paused. Phase G passed on 2026-10-03, so the pause no longer applies.

## Rules

Each rule removes something. All rules use the run's seed, so a run stays reproducible.

### R1. Statuses and choices are skewed

Most records sit in the module's normal end state, for example 60–75% Paid or Complete. The other statuses form a long tail. Each pack sets the weights for each module. Removes: `(index + seed) % len`.

Correct: invoices are 68% Paid, 14% Issued, 9% Overdue, 6% Partially paid, 2% Disputed, 1% Cancelled.
Wrong: invoices are 17% in each of the six statuses.

### R2. Amounts have a long tail

Amounts follow a log-normal shape around a median for each module. Some values are round numbers (5,000, 10,000), some have cents, and 1–2% are outliers. Removes the linear formulas, except where a named business case pins a value.

Correct: a median invoice of 4,200 with a few of 48,000 and many of exactly 5,000.
Wrong: invoice totals that step evenly from 1,000 to 11,000.

### R3. Dates and times cluster

- Weekdays hold at least 85% of records. Mondays and the last three working days of the month are denser.
- Public holidays in the pack's country have gaps.
- Each module has a slow season and a busy season from the pack research, for example school enrollment in June.
- A "go-live" week at the start holds a batch of quick entries.
- Entry times cluster at 9–11 and 14–16, with a few after 21:00.

Removes: `randint(-365, latest)` and `8 + index % 9`.

Correct: work orders peak on Mondays and before the rainy season, and none fall on Christmas Day.
Wrong: work orders fall evenly on every day of the year.

### R4. Workload follows a Pareto shape

In each department, one or two people write 40% or more of the records, and some people write only 2–3. Removes: the two-weight model.

### R5. Links are uneven

5–10% of parents have no children, and a few parents have many. Some invoices are never paid, and some requests never get an update.

### R6. Text has dirt that the server accepts

- Double or trailing spaces, ALL CAPS, and mixed abbreviations ("Corp." and "Corporation").
- Near-duplicate records that are really one record.
- "n/a", "-" and "see above" in optional notes, and one note copied across a batch.
- Mixed phone formats. Phone is plain text, so its format can change.
- Email and URL values stay valid, because the server checks them (`sandbox/designs/field_validation.py`). Only their case changes, or they use plus-addressing.

Correct: `ACME Cold Storage Corp.` and `Acme Cold Storage Corporation` both exist, and the second has no orders.
Wrong: an email field holds `n/a` and the run stops with a 422.

### R7. Record states are messy

The data includes quick entries with every optional field blank, old drafts nobody finished, cancelled-then-recreated pairs, and records owned by a person who is now disabled.

### R8. Each pack writes its own department dashboards

Each department's dashboard follows the presets and size rules in `docs/specs/openview-dashboard.md`. It uses 6–10 widgets, including:

- at least one `sum` or `average` widget;
- at least one `date_series` trend;
- one workload widget by owner;
- one records list of open or overdue work.

Where the department has links, it also uses widgets from linked modules. Removes: the generic 4-widget dashboard in `population/openview.py`.

Correct: Finance shows invoice totals by month (line), overdue invoices (records), collected this month (summary, sum), and payments by method (pie).
Wrong: every department shows "count by status" four times.

### R9. Boards content grows with the profile and fills every Board tab

- Every department's Announcements board has a Kanban with 4–6 stages that fit the department.
- Cards have `start_on` and `due_on`, so the Gantt has bars. Some cards are overdue, some are finished, and some are archived.
- Each board has 1–2 calendar sources from module date fields. Some people have personal sources, up to the limit of 5.
- Posts, events and cards scale with the profile:

| Content | Small | Standard | Large |
|---|---|---|---|
| Posts per department board | current count | ×2 | ×6 |
| Events per board | current count | ×2 | ×6 |
| Kanban cards per board | 12 | 24 | 60 |

Removes: fixed supporting counts for every profile, and the single Kanban per pack.

## What stays fixed

- `special_date`, `SPECIAL_STATUSES`, the pinned index cases in each pack's `generation.py`, the refusal actors, and the trigger rules. The new rules skip pinned indices.
- Rule 11: no relationship crosses departments without the contract's read grant. The 24-module cap stays.
- The record budget: Standard has 5,000–7,000 records. Duplicates and quick entries count inside the budget.
- Every write stays valid for the server. The Step 4a server-rule preflight runs after each rule lands.
- `created_at` and `updated_at` are set by the server, so they always show the run day. All time realism lives in the business date fields.

## Where the rules live

- One shared module in `backend/operations/sample/` holds the weighted choice, log-normal amount, date clustering and text-dirt helpers. Each pack calls it with its own rates.
- Each pack's data files hold its weights, medians, seasons, holidays, dashboard layouts and Kanban stages.
- `docs/plans/sample-pack-contract.md` gets these rules in "Rules for every pack", with a correct and a wrong example for each. Its Boards section is rewritten for #69.

## The packs as API smoke

A sample run already does more than populate. It is also an API smoke run:

- **Control actions.** 138 actions per pack (on `e1e9fc6f`) use the frontend's request shapes. Each action checks status, shape and end state, then restores its temporary changes.
- **Planned refusals.** Wrong-role actions must get 401, 403, 404, 409, 412 or 422.
- **Route coverage.** The run reports covered routes, uncovered routes and 5xx responses (`route-coverage.jsonl`). The 2026-10-17 Harbor Small run touched 252 routes, with 0 uncovered and 0 5xx responses.
- **Other checks.** The run also checks organization isolation with a partner organization, invitations and recovery through Mailpit, MFA, triggers, jobs and schedules, and lifecycle purge and restore. The `verify` command reads the end state back.
- **Release smoke.** `prepush.py --release` (`tests/smoke_runner.py`) already seeds Harbor Small in a disposable stack, then runs one browser path for each screen.

Gaps to close in this spec:

1. **Route coverage is complete for the UI (checked 2026-10-27).** `tests/operations/sample/verification/test_frontend_route_coverage.py` already fails when a route in `frontend/api-route-manifest.json` has no run coverage. All 411 UI route shapes are covered. The 11 routes that the run does not call are not in the UI manifest:
   - the CLI bearer routes `POST /api/auth/token` and `/token/refresh`;
   - `POST /api/internal/security-events`;
   - `GET /api/records`, `GET /api/relationships/{relationship_id}`, `GET /api/security-events/export` and `POST /api/users`;
   - board file reconcile and reopen, and file purge with its preview.

   The run copies what the UI does, so these routes stay with the backend route tests. No change.
2. **The release smoke uses Harbor only.** Fix: in the release smoke, run School Small too, and each new pack once it is done. Each pack's own P4 acceptance still runs it at Small.
3. **No live run since PRs #67–#69.** Fix: P0 runs Harbor Small and School Small in a disposable stack.

### Each pack organization gets its own administrator

Today every pack organization is run by the installation operator (`ADMIN_EMAIL`). The operator owns the whole installation: installation settings and backups (`require_platform_operator`). It is not the administrator of one organization. In production, each organization has its own administrator, and that administrator is not the operator.

Change: the operator creates each pack organization and invites one pack administrator. The administrator signs in through Mailpit, then runs the organization's population and controls. Only the steps that need the operator run as the operator: the backup controls, the installation fields of the security settings, and the restore of a removed account.

Decision (2026-10-28): the operator stays the owner and an admin member of each pack organization and of the partner organization. Restoring a removed account and changing installation fields need an operator who is an admin member of the bound organization (`account_operations.py::restore_user`). The owner can also open every permanent pack organization with their own account. The operator-only steps stay inside the pack run under a separate `operator` actor; the separate operator step after all packs is deferred, because it only helps concurrent Large runs, and P5 runs them one after the other. The partner organization's administrator is the operator. The member of two organizations for the switch control is the invited account-control member, not the operator. The cross-pack isolation probe logs in as the operator, so it still probes real peer organizations.

This removes the operator from organization work. The run then tests the non-operator administrator path, which no run tests today. Example: `revoke_admin_sessions` keeps sessions of people who belong to another organization only when the caller is not the operator (`sessions_router.py`).

Correct: `sample-harbor` has an administrator in the pack's own email domain, who revokes sessions only inside Harbor.
Wrong: the operator runs Harbor's Manage controls and ends the operator's own sessions in every other organization.

### Test layers

| Layer | Where | What | When |
|---|---|---|---|
| Offline | No database | Plan tests (`tests/operations/sample`), golden masters, Step 4a server-rule preflight, the realism checks, and the route-list parity test | After each change |
| Live pack run | One disposable stack | Every changed pack at Small, one after the other in the same stack, then `verify`; then remove the stack | Once for each work unit, and before each Large run |
| Release smoke | Disposable stack with Caddy (`prepush.py --release`) | Harbor Small and one browser path for each screen | Before a release |
| Permanent data | Development stack | Each pack at Large, once | P5 only |

Different packs can share one installation, because each pack has its own slug and email domains. Two runs of the same pack cannot. The live pack run needs a seed-only mode of `tests/smoke_runner.py` that takes a list of packs and skips the browser paths. It reuses the runner's disposable stack.

Correct: API smoke runs Harbor Small in a disposable `openslate-e2e-*` stack, and the development stack keeps the permanent Large data.
Wrong: API smoke runs a pack again on the development stack, so the permanent Large data must be reset first.

## Phases

1. **P0: Make the base current.**
   1. Update the two pack documents for #69: remove widgets and portability, and add Kanban and calendar sources.
   2. Clear the pause note in handoff §16.
   3. Add a seed-only mode to `tests/smoke_runner.py` that takes a list of packs.
   4. Do one live Small run each of Harbor and School on `main`, in a disposable stack, before any change.
2. **P1: Build the shared realism module and the offline realism checks** (see Exit criteria). Add one administrator for each pack organization (see "Each pack organization gets its own administrator"). No pack data changes yet.
3. **P2: Apply R1–R5, R8 and R9 to Harbor and School.**
   1. Regenerate both golden masters, and review the change on purpose.
   2. Do one live Small run each.
   3. The owner looks at the dashboards and boards in the dev app.
4. **P3: Apply R6 and R7 to Harbor and School.** The same checks run again.
5. **P4: Build the new packs one at a time:** Clinic, Nonprofit, Local government, FMCG distributor, Manufacturer.
   - Each pack has all rules from its first commit.
   - Each pack passes offline acceptance and one live Small run.
6. **P5: Do the Large runs, one at a time on a free machine.** A pack populates only once in each installation. Its organization slug is fixed (`sample-<pack>`), and population stops if any Auth account exists in the pack's email domains (`operations/sample/organization.py`).
   1. Run the guarded reset once, before the first Large run. It removes the current Small organizations and the `ho-*` accounts.
   2. Run one pack at Large.
   3. Take a backup.
   4. Run the next pack only after the backup.
   5. After the last pack, create the `ho-*` accounts again.

## Exit criteria

These are offline checks on the generated plan, plus the live runs.

1. In every module with 4 or more statuses, the most common status holds 50% or more, and it is at least twice the second (a long tail, not a flat split).
2. For each typed amount field, p99 divided by p50 is 5 or more, and 5% or more of values are round numbers. A computed amount (a sum or product of other fields) is not checked; it takes its shape from its inputs. A fee-schedule amount is checked for round numbers only.
3. On each module's main business date (never a birth date), weekdays hold 85% or more of records. Every pack holiday has no records, or almost none.
4. In each department, the top two writers hold 40% or more of writes.
5. 5% or more of parents have no children, for each one-to-many link that is not structural (a structural link has one child per parent slot, such as two lines per order).

Checks 1–5 run at Standard and Large (`verification/realism.py`); a module or department with fewer than 30 records is skipped. Each pack's `realism.py` names its holidays, computed and tiered amounts, numbers that are not money, and structural links.
6. Every dashboard has 6 or more widgets, and at least one `sum` or `average` and one `date_series`.
7. Every department board has a Kanban with cards that have `start_on` and `due_on`, and 1 or more calendar sources.
8. The Step 4a preflight passes. A live Small run has no 4xx responses except the planned refusals.
9. The pinned business cases and refusals are unchanged in the golden-master comparison.

## Delivered decisions (2026-10-28)

- R1–R5 for Harbor and School: weights, amount shapes, seasons and holidays live in each pack's `realism.py`; records below index 10 keep their named business cases. An invoice bills its sales order's customer, so order links can be uneven. Unpaid Harbor invoices are the recent ones. School fees are round tiers by year group with a long-tailed bursary for a fifth of pupils.
- R8: each department dashboard uses 7 widgets in the Overview shape (four numbers, a monthly trend, workload by owner, open records). The first 2 × 2 of rows 4–5 stays free, for the department's own charts and for the Charts control, which adds one there.
- R9: every department board has a Kanban with the department's stages; the demo Kanban keeps its named cards. Cards per board follow the profile (12, 24, 60), read from the size of the seeded organization. Each board has one or two calendar sources, and some team members (never the lead) add a personal source. Posts and events per board do not scale yet (needs the profile in `prepare_content`).
- R6–R7: dirt applies from index 10. Email and URL dirt changes only the local part or a trailing slash, so hosts stay lower-case reserved domains. Refused-then-entered-again pairs use only modules whose title names no linked parent (Harbor expenses, School leave requests). Records owned by a disabled person are not done.

## P4 results (2026-10-28)

Five new packs are registered, each built on rules R1–R9 from its first commit, and each passed the offline acceptance (pack, scenario, text, realism, control, population and phase suites) and one live Small run in a disposable stack:

| Pack key | Organization | Live Small |
|---|---|---|
| `clinic` | US outpatient clinic | 463 s, 8,258 requests |
| `nonprofit` | Philippine relief and development nonprofit | 511 s, 9,051 requests |
| `local_government` | Philippine city government | 519 s, 8,881 requests |
| `fmcg_distributor` | Philippine consumer-goods distributor | 536 s, 8,844 requests |
| `manufacturer` | US sauce and condiments plant | 449 s, 9,275 requests |

Harbor and School Small also pass live on the same branch (527 s and 648 s). No live run had a 5xx response.

Generic fixes the live runs found: a Board takes each record card once; the run keeps the calendar-source count; a pack names its ISO currency (`currency_code`); a refused write names the API code and fields; a User field must name a reader of the module (now in the shared preflight); a pack key with an underscore gets a valid slug; the session-revocation target never belongs to a second organization; the audit review searches a module name no other module contains; North American phone formats have no trunk 0; board files cover every file type in every pack.

Known limits: pack keys must be Python package names; link rules get no seed or anchor date; the realism date check reads Date fields, not Date/Time; the generic writer weights are not Pareto, so packs keep writer teams at four people or fewer.

## Risks

| Risk | Solution |
|---|---|
| Verification controls may expect the clean shape (a status split, or a field that is never blank). | Before P2, list every hard-coded count in `controls/*_verification.py` and `verification/`. Move each count to the planned value that the pack reports. |
| Outlier amounts fire `large-invoice-threshold` and `large-movement-threshold` more often, so trigger-run counts change. | Accept it. Review the new counts in the golden-master change. |
| More Boards content at Large makes the run longer: about +10–15 min at Large. | Accept it. It is still small next to about 2.5–3 h of records. |
| Five packs written by different implementers can drift apart. | Packs use only the shared module. The P1 offline checks run for every pack. |
| Large runs cannot resume after a failure, and only the reset clears a failed pack. The reset also removes the Large packs that already finished. | Take a backup after each finished pack. After a failure, restore the last backup (`infra/supabase/RESTORE.md`), fix the cause, and run the pack again. Before each Large run, run the same pack at Small in a disposable stack on the same commit. |
| Concurrent pack runs are possible after P1, but they couple failures. One backup covers both runs, so a failure in one sets back the other. The single API process caps the gain at about 25–40%. Timing-sensitive controls (job deadlines, Realtime latency) can fail under the extra load. | Run the disposable Small runs at the same time, because a failure there costs only a rerun. Run the permanent Large packs one after the other in one unattended overnight chain: Harbor Large, backup, School Large, backup. |
| After P5, the development stack cannot run any pack again, so it can no longer do API smoke runs. | Run every API smoke run in a disposable stack (see "The packs as API smoke"). |

## Server findings for a later session

The sample runs also stress the server. These findings are for a separate session; this spec does not fix them. Add each new finding from a live run here, with its evidence.

**Live baseline (P0): green on 2026-10-28.** `--seed-only --packs harbor,school` passed in one disposable stack after the F5–F13 fixes. Harbor Small: 745 s, 8,039 requests, p50 42 ms, p99 292 ms. School Small: 778 s, 9,468 requests, p50 43 ms, p99 220 ms. No 5xx responses.

| # | Finding | Evidence | Next step |
|---|---|---|---|
| F1 | The API runs as one uvicorn process. 332 of 346 route handlers are synchronous `def`, so the Python GIL limits route work to about one core. A second client at the same time adds an estimated 40–70% throughput, not 100%. | `app/__main__.py` sets no `workers`; handler count from `app/systems`. | Measure two Small runs at the same time in one disposable stack. Then check whether more workers are safe with SSE `LISTEN`/`NOTIFY` and the in-process state. |
| F2 | The most frequent write routes cost 46–65 ms each. Sandbox publication costs 2.6 s. | Harbor Small, 2026-10-17: `POST /api/relationships` 1,692 calls at 46 ms, `POST /api/records` 1,011 at 65 ms, `PATCH /api/records/{id}` 594 at 58 ms, `POST /api/sandbox/publications` 7 at 2,632 ms; p50 34 ms, p99 221 ms, max 4,461 ms. | Profile the three record and relationship writes at Large volume (audit, triggers, read-model updates). |
| F3 | About 42% of a Small run's time is spent outside the API: 24% in fixed 2 s job polls and about 18% in client work. | Same run: 233 s of 561 s between requests; 64 waits of about 2.1 s before `GET /api/jobs` (`controls/jobs.py:40`). | Poll faster, with backoff. Send independent writes in parallel inside one run. |
| F4 | As the operator, `DELETE /api/auth/admin-sessions` also ends the operator's own sessions in every other organization. The membership exception applies only to callers who are not the operator. | `app/systems/access/users/sessions_router.py:277`. | Confirm that this is the intended behavior for the installation owner, or limit it to the bound organization. |
| F5 | **Fixed in P0.** The release smoke (`prepush.py --release`) could not seed after the multi-organization change. The disposable stack's organization is the test fixture "Test organization", but the sample baseline needs fresh-install defaults. The run stopped at the baseline before its first write. The last passing release smoke was on 2026-10-13 (`550e8383`). | Live run on 2026-10-27: `stage=baseline`, failure after `GET /api/workspace`. `tests/conftest.py::create_organization` sets `display_name="Test organization"`, and `assert_pristine_workspace` expects "OpenSlate". | The smoke runner now creates the pack's own `sample-<pack>` organization and partner, as the CLI does (`create_pack_organizations`). `smoke_seed.py` passes their IDs to the population. Test: `test_smoke_seed_populates_the_pack_organization_it_is_given`. |
| F6 | **Fixed.** Every Kanban card file download failed with HTTP 503 `files_busy`, for every user, not only in sample runs. The transfer-slot route pattern (`app/core/middleware/file_transfers.py::_BOARD_CONTENT_ROUTE`) matched only event and post attachments. A card download got no transfer lease, so `hold_file_worker` refused it before any read. PR #69 added the card route, and no test downloaded a card file through the middleware. | Harbor Small on 2026-10-27: request `01a17dfa-b613-78db-bf67-f05bbb3dbec7`, step `control:board:kanban-update:download_card_file`, 503 in 6 ms. The journal said only `other`, because `client_failures.failure_code` did not read object-shaped error details. | The pattern now includes `cards`. Test: `test_board_file_upload_and_contextual_download_receive_transfer_leases`. The client journal now records the API error code slug for a 5xx (never the message). Test: `test_server_error_journal_names_the_api_error_code_only_when_it_is_a_bounded_slug`. |
| F7 | **Fixed.** The MFA-reset control sent every request with `refresh_first=False`, so it never refreshed an access token before use. Disposable stacks issue 45-second access tokens (`tests/supabase_runtime.py`, `JWT_EXPIRY`), and the API checks expiry locally with no leeway. The School member's primary client was idle for more than 45 s, so its first step got 401. Harbor passed by timing only. The profile steps were not the cause. | School Small on 2026-10-27: request `01a17dff-df95-7123-aa16-d69b819e8df9`, step `mfa_primary`, `GET /api/auth/me` 401 in 0 ms. | The control now refreshes before each request, and only the session-end probes (`GET /api/auth/session` on a revoked session) skip the refresh. Test: `test_mfa_refreshes_idle_clients_and_skips_refresh_only_for_session_end_probes`. |
| F8 | **Fixed.** The host-delivery control (`operations/sample/controls/host_delivery.py`) had the same hard-coded `refresh_first=False` as F7 had. It runs only with host acceptance, so the Small smoke does not reach it, and it has no revoked-session probe that needs the flag. | Code reading on 2026-10-28; no live failure yet. | Every request now refreshes first. Test: `test_host_control_refreshes_idle_clients_before_each_request`. A host-acceptance run has not verified it. |
| F9 | **Fixed.** The release smoke's administrator was not the installation operator. `fullstack_runner.seed` creates the administrator without a `platform_operators` row, but a real installation's first administrator is the operator (`operations/bootstrap_admin.py`). The access controls delete a single-organization guest, which removes the account, and only the operator can restore a removed account. This was hidden behind F5 and F6. | Harbor Small on 2026-10-28: step `controls:access:restore_guest`, `POST /api/users/{user_id}/restore` 409 after `DELETE /api/users/{user_id}` 204, request `01a17e4d-5361-7769-afeb-2629bd5f6ac7`, after 422 s. | The smoke runner now registers its administrator as the operator once, before the packs (`register_installation_operator`). Test: `test_smoke_overlaps_build_with_startup_and_waits_for_both_prerequisites`. |
| F10 | **Fixed.** The Comms structure control read only the first page of each list. An organization channel holds every member: Harbor Small has 45, and the member page holds 25 by default, sorted by name. So the administrator or a planned member fell onto page 2, and the members check failed. Large has 4× the people, so every pack would fail there. | Harbor Small on 2026-10-28: step `control:comms:primary-structure:list_structure`, "Structure readback differs", after 418 s, right after `GET /api/comms/conversations/{conversation_id}/members` 200. | `StructureRun.page` now reads every page (100 rows per page) for members, categories, conversations and blocks. Test: `test_member_readback_reads_every_page`. |
| F11 | **Fixed.** The Comms jobs control expected a channel export without a password to be refused (403). After D44 (`014a1fd4`) every channel is bound to the organization or one department, and only direct and group messages are private sources (`export_service.private_source`). The server was right; the control checked the old rule. | School Small on 2026-10-28: step `control:comms:primary-jobs:private_proof_required`, 201 instead of 403, request `01a17e68-fc5c-7d2c-9860-ca88ed28d7f8`, after 751 s. | The stale refusal step is removed. `tests/comms/jobs/test_comms_exports.py::test_private_export_requires_fresh_proof_and_later_authority_is_rechecked` owns the private-source proof. The sample run does not export a private source; add a group-message export to the control if the smoke must cover it. |
| F12 | **Fixed.** Final verification rejected the request evidence of 13 Comms controls. The generic check (`controls/request_verification.py::verify_request_evidence`) accepted only the admin or the action's `actor_key` as actor, and only 2xx statuses. The Comms controls also act as their planned members and record planned refusals (`member_export_denied`, `member_template_denied`, 403). Partner structure had the same cause: its member `second` accepts the invitation and switches organization (3 writes). | School Small on 2026-10-28: every population and control step passed; verification printed "A sample control request actor differs from its planned step" and "A sample control request status is invalid or unsuccessful". An offline rerun on the retained manifest named the 13 controls. | For `comms_controls`, the check now accepts an actor named by the plan's `member_key`, `member_keys` or `recipient_key` when its ID matches, and a 4xx only for a step in the plan's `refusal_steps`. Tests: `test_comms_evidence_accepts_the_declared_member_and_planned_refusal`, `test_comms_evidence_still_rejects_wrong_actors_and_unplanned_refusals`. |
| F13 | **Fixed.** A Comms conversation purge with exports failed with 503 `files_busy` whenever another file transfer was running. The purge request holds one of the two file slots, and `export_service.cleanup_artifact` took a second one without waiting. So a background export or a second upload refused the purge. It fails only under concurrency, which is why run 4 passed the same step. | Harbor Small on 2026-10-28: step `control:comms:primary-jobs:purge`, request `01a17ea6-8d63-7bd2-adb8-8d0c80369751`, 503 after 413 ms; the journal recorded `files_busy` (the F6 journal change). | The purge passes `slot_held=True`, so the cleanup runs in the request's slot. Background callers keep taking their own. Tests: `tests/comms/jobs/test_comms_export_cleanup_slot.py`. |
