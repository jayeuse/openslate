# UI-equivalent sample data plan

> **Frontend rollback, 2026-09-30.** At the user's direction the frontend is exactly `main` (`bf64d2f`). The OpenView record and relationship controls and the API-backed Manage and Platform pages that this task added were removed; a backup is in `.agent-runtime/frontend-rollback-2026-09-30/`. The frontend design in `main` takes priority over sample-data needs. Until a design-led frontend task adds record and relationship controls, the seeder still writes records and relationships through the same authenticated APIs, but no current UI control exposes those two operations; Manage and Platform in `main` are local examples, so workspace settings set by a run are visible through the API, not in Manage.

> Implementation plan revalidated against the schema redesign at `bf64d2f`. The user authorized population and minimal API-backed record and relationship controls after the redesign. Resetting or replacing an existing installation still requires its own confirmation.

## Contract and current limit

The user subsequently excluded **all file insertion and scanner-dependent sample acceptance**. Small and Standard create zero attachments. Remove no scanner feature or application scan enforcement as part of this task; only omit file seeding. Existing partial uploads are cleaned through the guarded reset.

Every populated value must be enterable through an existing supported UI control. Population must use that control's authenticated API operation with the same validation, authorization, concurrency, and audit behavior. Do not insert application rows directly, call internal services, provision identities through provider-admin APIs, or fabricate audit entries.

Current OpenView record inspection is read-only. Add New Record to the selected module's Views results, Edit to its inspector, and relationship assignment/link/unlink controls. These controls establish UI equivalence for the existing record and relationship APIs before operational population. Sandbox Test inputs remain temporary simulations; Platform's local sample controls do not establish live authoring eligibility.

The authorized operational target is the counts the run manifest records for the selected organization pack and profile. Populate only after the authoring controls are implemented and verified. Empty results and failures must remain honest; no fallback examples may stand in for seeded records.

## Cross-department relationships

A relationship can connect modules in two departments of one organization. The
publication planner and the relationship assignment and create APIs accept such
a link. The person who links needs write access to the source module and read
access to the target module.

Harbor models eight links across departments as relationships:
Customers–Customer Sites, Customers–Invoices, Equipment–Service Requests,
Products–Purchase Lines, Goods Receipts–Stock Movements,
Warehouses–Purchase Orders, Sales Orders–Invoices, and Work Orders–Products.
In each link, the record that names the other record is the source. For
example, a Customer Site links to its Customer. The source record links itself
after both records exist. Each department's staff group reads the other
department's modules its records link to, so the clerk who created the record
also writes the link. A Customer Site names one Customer, and a Customer has
several sites, so that link is many-to-many. The relationship graph still exercises one-to-one, one-to-many and
many-to-many cardinalities. Exact definition and edge counts are printed from
the generated profile before population.

The admitted Harbor design has 26 relationship definitions. Record, edge and content totals are the counts the run manifest records. Current Harbor record totals are Small 1,001, Standard 5,001 and Large 20,004. Version 1 manifests retain the old sizes for verification.

## Supported scope

Retain Harbor Operations Group with six departments and 24 modules. Use the existing Sandbox document editor, checkpoints, Test action, publication preview, and publication controls. Documents use version 4: select options have stable UUID IDs and editable labels, person fields store UUIDs, and modules may select a record-title field. Draft person values are explicitly simulated and do not prove live assignment eligibility.

| Area | Proposed coverage through current controls |
| --- | --- |
| Sandbox | Six departments, 24 modules, supported field types, relationship definitions, readable layout, checkpoints, temporary Test history, and actual publication history |
| Operational records | The counts the run manifest records across the pack's modules, with real relationship edges and named financial, service and purchasing scenarios |
| Record triggers | Eight supported same-record Set-field rules using record-created, field-changed, threshold-crossed, and daily/weekly schedules; clearly distinguish simulated Test results from live executions |
| People | 36 invited internal identities: 30 active, four pending, two disabled; eight guests: six active, one pending, one disabled, with valid sponsors and expiry |
| Groups and access | Nine groups with overlapping membership and department/module read, write, and manage rows, including a read-only Internal Audit group; roles are only admin, member, and guest |
| Boards | Built-in Company Board, six department Boards, and five project Boards; project access uses groups, department access follows its department |
| Board content | 96 posts, 144 events, genuine post revisions, and 24 event reminder configurations using supported timings |
| OpenView | 36 shared module Views across supported layouts, six department Dashboards with four widgets each, and 12 shared Reports; configure only outputs available through current controls |
| Files | Excluded by user instruction; zero inserted files or attachments |
| History | Genuine user-attributed mutations and supported publication, scheduling, notification, and report-run history |

Counts are proposed targets, not evidence of created data. `plan` must report the exact admitted counts and exclusions before any future population. Chart settings are page-local and are not persistent sample entities. Report runs against empty modules may demonstrate empty-output behavior, not populated business results.

Exclude file insertion and scanner acceptance, removed custom roles, service identities, access rules/defaults/deny policies, Board grants/templates/favorites/homes/personal read or bookmark states, content audiences, private Dashboards, and saved chart preferences. Workspace execution is not represented as a fabricated service account. Include real record links, live record-trigger scenarios, populated CSV/report outputs, and cross-module business journeys after the authoring prerequisite passes.

Use the counts the run manifest records. Harbor Standard uses each old module count divided by four and rounded upward (5,001 records). Small uses each Standard count divided by five and rounded upward, with a minimum of one (1,001 records). Large uses four times each Standard count (20,004 records) and remains opt-in. The table below records the frozen version 1 distribution: Small used five percent rounded upward, Standard used 20,000, and Large used five times Standard. Retain deterministic business values with seed 42 and an explicit pack-local business-date anchor; server IDs, passwords and authentication timestamps remain newly generated.

| Department | Legacy version 1 Standard module counts |
| --- | --- |
| Sales | Customers 300; Contacts 600; Quotes 800; Sales Orders 2,000 |
| Customer Service | Customer Sites 300; Service Contracts 200; Service Requests 1,200; Request Updates 1,400 |
| Field Operations | Equipment 600; Work Orders 2,000; Inspections 1,000; Maintenance Plans 200 |
| Inventory | Products 500; Warehouses 10; Stock Movements 3,500; Stock Counts 490 |
| Purchasing | Suppliers 100; Purchase Orders 700; Purchase Lines 1,400; Goods Receipts 700 |
| Finance | Invoices 800; Payments 600; Expenses 500; Credit Notes 100 |

## Control-to-API catalogue

Before implementation, catalogue each admitted operation with its reachable page/control, editable fields, actor and access requirements, API request, concurrency preconditions, expected saved state, and audit behavior. A route existing in OpenAPI is insufficient.

Use current boundaries:

| Reachable control | Authenticated operation / editable values | Actor, preconditions and saved evidence |
| --- | --- | --- |
| Sign in / session refresh | `POST /api/auth/login`; `POST /api/auth/refresh` | Independent cookie jars, UI Origin and CSRF; real sessions; credentials excluded from journal |
| Sandbox Save | `PUT /api/sandbox/document`: document v4 and `expectedRevision` | Admin; whole UI-authored design; updated draft revision and genuine audit |
| Sandbox checkpoint | `POST /api/sandbox/versions`: revision, checkpoint label/note | Admin; saved document; checkpoint history |
| Sandbox Test | `POST /api/sandbox/tests`: revision, module, values, event and optional trigger IDs | Admin; temporary simulation results, never operational records or stored authored scenarios |
| Sandbox Review / Publish | `POST /api/sandbox/publication-previews`, then `/publications` | Admin; password, revision, preview token, impact digest, idempotency key; genuine published version and audited structure |
| Access New group | `POST /api/access/groups`: name, description, optional member IDs | Admin; server-issued group ID and ETag |
| Access group access / members | `PUT /api/access/groups/{id}/access` or `/members` | Fresh `If-Match`; access rows use department/module IDs and read/write/manage; delegated membership rules preserved |
| Access Invite | `POST /api/auth/invitations`: email, username, display name, job title, role, groups; guest sponsor/expiry | Admin; existing groups, active non-guest sponsor, future guest expiry; pending profile and actual captured mail |
| Invitation confirmation | `POST /api/auth/invitations/complete`: token hash and new password | Cookie-free recipient session, matching newly captured Mailpit message; genuine activation |
| Access Disable | `PATCH /api/users/{id}`: disabled status | Admin; previously accepted account; actual session revocation and audit |
| OpenView New Record / Edit | `POST /api/records`; `GET` then `PATCH /api/records/{id}` | Module write/manage; complete active field-ID map, valid select UUIDs and eligible person IDs; server ID and actual actor audit |
| OpenView relationship picker | `GET /api/fields`, `/records`, `/relationships`; `PUT /api/relationships/fields/{id}/sources/{id}` or `POST /api/relationships`, `DELETE /api/relationships/{id}` | Source write and target read; target-module restriction/cardinality; genuine edge or assignment change |
| Manage organization | `GET/PATCH /api/workspace`: display name, locale, timezone, revision | Admin write; current revision; only visible supported fields |
| Manage audit / sessions | Existing audit/security/session read and revoke APIs | Real mutation/login history; no authored audit or session rows |
| Boards New project / project access | `POST /api/boards`: name/description; `PUT /api/boards/{id}/groups`: revision and group/level rows | Admin creates projects; current Board manage for access; Company/department Boards come from initialization/publication |
| Board post editor | `POST /api/boards/{id}/posts`; `PATCH .../posts/{id}`: title/body/links/expiry/pin | Board write, manage for pin; current `board_revision` and `post_revision`; saved draft and real audit |
| Post Publish / Schedule / Archive | `POST .../posts/{id}/publish`, `/schedule`, `/archive` | Current revisions; publication uses body `publication_key`; scheduling uses future UTC `publish_at`; genuine immutable revisions |
| Board event editor | `POST /api/boards/{id}/events`; `PATCH .../events/{id}` | Board write; current Board/event revisions; date or timed event, timezone, recurrence and supported reminder timing |
| Board widgets | `POST /api/boards/{id}/widgets`; revisioned update/order actions | Board manage; editor-supported widget type/config/position; saved configuration references real content |
| Board record links | `POST /api/boards/{id}/posts/{id}/record-links` or `/events/{id}/record-links` | Parent content write and record visibility; existing live record, parent revisions; real cross-page link |
| OpenView Save View | `POST /api/views`; revisioned `PATCH /api/views/{id}` | Module manage; name/query/selected fields/layout settings; shared saved view |
| OpenView Dashboard editor | `POST /api/dashboards`; revisioned `PATCH /api/dashboards/{id}` | Department manage; name, position, refresh cadence and supported widget queries; department-scoped saved Dashboard |
| OpenView Report editor / Run | `POST /api/reports`; revisioned `PATCH`; `POST /api/reports/{id}/runs` | Manage recipe, permitted reader run; fields/filters/sorts/grouping/count; run `Idempotency-Key`, real captured rows and eligible readers |
| Report schedule | `/api/reports/{id}/schedule` create/update operations | Current report/schedule revisions; daily/weekly, timezone/local time, enabled state; finish disabled except an explicitly bounded execution exercise |

The frontend request builders under `systems/boards/adapters` and `systems/openview/adapters` define the remaining Board, View, Dashboard and Report payloads. Each corresponding population routine must retain their request revisions, scoped parent IDs and publication/run idempotency keys; a successful route without its rendered control does not satisfy admission.

- Sandbox document/checkpoint/Test/publication operations under `/api/sandbox`; preserve preview digest, password confirmation, revision, and idempotency requirements.
- Invitations and account actions through the Access UI's endpoints. Complete selected invitations using matching messages in the owned Mailpit instance and the normal invitation-completion endpoint.
- Groups through `/api/access/groups`; use the dedicated member and access replacement operations with `If-Match`. Administrators set access; eligible department managers may change membership within the existing policy.
- Boards through their existing scope, project-group, post, event, widget, and lifecycle controls. Use record-link controls after live records exist through the admitted workflow.
- Shared Views, department Dashboards, and module Reports through their existing editors. Add only the explicitly authorized live record and relationship authoring controls.
- Manage: connect organization name, locale and timezone to Workspace, and audit/session views to their existing APIs. Show unsupported backup, licensing, update and global security controls as unavailable. Do not reinterpret the bundled mark as an uploaded logo.
- Platform: replace local people, records and supported files with authorized API reads, route record editing to OpenView, preserve connected notifications and genuine authentication/session flows. Disable simulated import and use supported export. Preserve legitimate device appearance settings and OpenComms owners/defaults.

The user reauthorized these Manage/Platform connections after the source audit. No new services, API contracts, import system, presence, following or preference APIs are included. OpenComms remains excluded.

## Record control contract

Read complete active field metadata and the complete record before editing. Preserve the existing PATCH replacement semantics by submitting all active values; do not change the backend contract to merge sparse data. Keep module identity immutable. Support select UUIDs and labels, module-scoped eligible person IDs, primitive validation/defaults, optional blanks and valid zero/false values. Preserve inputs and show backend validation failures.

Use the existing assignment endpoint for single-target relationships and link create/delete for multiple targets. Search and paginate only the target module's records, honour cardinality and write access, and guard pending/unsaved changes. Reuse the account-scoped query client, existing metadata keys, tracked read-denial handling and shared invalidation stream. Write refusals remain form errors; confirmed writes refresh results/details without overwriting unrelated drafts. Keep Dashboard's existing refresh behavior.

## Proposed operator workflow

Rebuild the retired sample tool under `backend/operations/`: `plan` performs read-only admission and prints counts; `populate` executes admitted controls' API workflows; `verify` reads back counts, states, access, and audit evidence.

1. Confirm the owned installation, schema, API identity, administrator session, controlled Mailpit delivery, and an explicitly approved empty baseline.
2. Author and publish the Sandbox design with normal controls' preconditions. Resolve server-issued IDs through authorized reads.
3. Invite people, complete only the selected invitations, configure groups and access, and exercise allowed and denied users through separate sessions.
4. Create operational records through the new editor's API contract under the six designated sample actors, then resolve and create relationship edges. Exercise genuine updates and record triggers with independently specified expected outcomes. (Current behavior. The proposed simulated activity runs below replace this step with interleaved episodes.)
5. Configure Boards, posts, events, reminder settings, and widgets; do not insert attachments. Preserve author archiving. Reminders use start, 15 minutes, or one day, with delivery permitted up to 15 minutes late.
6. Configure shared Views, Dashboards, and Reports. Record empty results honestly. Keep scheduled triggers/reports disabled at completion unless a bounded real scheduling scenario explicitly requires otherwise.
7. Verify every admitted count and result. Report any incomplete operation separately.

Use the existing HTTP client, normal login/refresh flow, isolated cookie jars, Origin/CSRF handling, and ordinary API validation. Prompt for the administrator password without retaining it. Generate strong sample credentials and keep them in an ignored owner-only roster, separate from evidence. Pending invitees have no completed-login credentials.

Write sequentially, respect rate limits, and retain logical/server ID mappings and completed-operation status in a private journal without credentials. Do not blindly replay an uncertain POST or silently overwrite a partial run. A timeout is an incomplete outcome, not successful population.

Run from `backend/` with the owned API available (the optional development scanner is not a seeding prerequisite):

```sh
uv run python operations/seed_sample_data.py plan --profile standard
uv run python operations/seed_sample_data.py populate --profile standard --run-root /absolute/private/sample-runs
uv run python operations/seed_sample_data.py verify --run-directory /absolute/private/sample-runs/RUN_ID
```

Population and verification prompt for the current administrator password.
Each run stores its journal and manifest separately from its owner-only
`credentials.json` roster. The development Compose overlay allows 1,000 outgoing
Auth emails per hour into the owned Mailpit catcher, so the 44-person roster and
reset/rebuild acceptance fit within the local delivery limit. This setting is
limited to the development overlay; production mail settings are unchanged.

## Proposed: simulated activity runs with natural content

Status: **implemented for Harbor.** A live Small run (`ed0901e2…`) and a live 20,000-record run (`f10919cc…`) completed with all verification passing, including record history, planned rejections and interleaved Board work. This section replaces the phase-block population order (records, then all edges, then content) for future Small and Standard runs. The UI-equivalence contract above does not change: every write still uses a reachable control's authenticated API as a real sample user.

### Outcome

A populated instance reads like a working organization, not a generated dataset:

- Many people act. Each write comes from an active user who has the required access, not from one lead per department.
- Work is interleaved. A user creates a record and immediately links it, and departments take turns.
- Records have a history. Some records get status changes and reassignments from different users, and real automations fire from these edits.
- Planned rejections happen and are recorded, for example a guest who tries to create a record.
- Record text uses the terms of each business area. No value marks itself as generated.

Audit timestamps show the real run window. Business dates inside records keep their spread over the past year and the next quarter. A run draws a fresh seed unless the operator sets `--seed`. The CLI prints that seed and the manifest records it. The recorded seed and anchor date reproduce the actors, order, values and refusals. Golden masters keep seed 42. Server IDs, passwords and timestamps remain new for each run.

### Current source facts that shape the design

| Fact | Source |
| --- | --- |
| Before this work, each record's creator and "Assigned to" value was its department lead (`@actor:<department>`), so only 6 people created or owned data | `sample/scenario.py` `_field_value`; `sample/population/workflow.py` `build_record_payload` |
| Before this work, population signed in 7 accounts (admin and 6 leads); the other 24 active members never acted | `sample/population/people.py` (actors); `sample/population/workflow.py` actor-set check |
| Before this work, Inventory, Purchasing and Finance members could write only one module each; guests are capped at read | `sample/population/people.py` `_GROUP_ACCESS`; `access/policy/scope.py` |
| Harbor has 26 relationship definitions: 18 link modules inside one department and 8 link a record to a record in another department. The source record links itself after both records exist | `sample/packs/harbor/catalog.py`; `test_sample_references.py` |
| Record verification requires each create audit to match one actor per department | `sample/verification/core.py` |
| The API rotates an access token only in its last 30 seconds. The seeder refreshes in the last 20 seconds and stops if the expiry does not advance (implemented after a Standard run stopped at the 15-minute token lifetime) | `provider_sessions.py` refresh; `sample/client.py` |
| Supabase Auth shares one limit for password sign-in and token refresh (default 150; the hosted documentation describes 150 per 5 minutes, and the Auth source reads a plain value as events per hour). A Supabase 429 during a refresh revokes the local session. FastAPI's own sign-in limits are off in loopback development | `infra/supabase/compose.yaml`; `access/auth/router.py`; `identity/provider_sessions.py` |
| Titles, notes, e-mail addresses, post bodies and OpenView names use fixed templates. Customers repeat 5 names; one supplier name uses a real airline brand | `sample/scenario.py` `_title`; `sample/catalog.py`; `sample/population/board_entries.py`; `sample/population/openview.py` |

### Proposed design

**Actor plan.** Each generated record carries a creator key and an assignee key, chosen by seed from the department's active users who have write access to that module. Assignees spread across department members in proportions that look like normal workload differences. The verifier matches each create, update and relationship audit row to the planned actor of that write, using a map of all acting users. Automation updates are excluded from this check: their audit rows have no user (`performed_by` is empty) and an actor label that starts with `Trigger:`. Admin performs only admin work: Sandbox, invitations, groups, workspace, Board setup (project Boards, their access and widgets), and Company Board posts and events.

**Group access.** Members of Inventory, Purchasing and Finance get write access to all modules in their department, so every department has several writers. The Harbor Operations group, which holds the six department leads, gets manage access to every department, so leads build their department's shared views, Dashboards and Reports. Project Board grants give each project's department team write access. Each staff group also reads the modules in other departments that its records link to (for example, Finance reads Customers and Sales Orders). Denial examples come from guests, from members outside a department (404), and from a new small group, Internal Audit. It gives two Sales members read access to Finance and Purchasing, so their create attempts there return 403.

**Episodes.** The planner turns the dataset into one ordered list of episodes. An episode is one user's short piece of work:

| Episode | Writes |
| --- | --- |
| Create and link | Create one record, then create its edges to parents that already exist |
| Update | Change a status, amount or assignee on an existing record (complete-record PATCH) |
| Board activity | Create, edit, publish or schedule a post or event on a Board the author can write |
| Planned rejection | Send one request that must be refused (see below) |

Episodes are grouped into short work sessions (decided). A user does two to six episodes in a row (a module's last session can be shorter), then another user takes over. Departments with more work, such as Inventory stock movements and Sales orders, receive more sessions. Business journeys run through the sessions: for example customer → quote → price change → sales order → invoice → payment. A later step starts only after its earlier record exists. Because departments take turns, the steps of one journey spread across the run. Inside a department, a parent record always comes before its children, so an edge is only requested when both records exist. A record-created automation runs just after the create and briefly locks that module and record. The planner knows which planned records fire a rule. For those records, the link episode waits until a read of the record shows the rule's result (for example, status Confirmed), with a bounded wait. The seeder's existing retry covers a following record create in the same module that meets the lock. The read-then-retry for edges (below) is a backstop, not the main defense.

Board work is interleaved with record sessions. Each post, event, record link and post life-cycle action is one step by a team member who can write on that Board. A step runs every few sessions once its earlier steps and records exist, and every Board write reads the current Board and item revisions first. Department leads build views, Dashboards and Reports at the end of the run.

Correct session: `Mika Villanueva creates quote Q-2026-0145, links it to Bayview Coastal Foods, then raises its total to ₱52,600.`
Wrong session: `Marina Santos creates 800 quotes in a row; all quote links are written 15 minutes later.` Board record links come after the linked records exist. Views, Dashboards and Reports come after their source modules have records.

**Record history.** About 40% of records receive one to three updates that follow each module's normal status order (for example, Open → In progress → Resolved). Every update episode reads the current record first and sends the complete record with only its planned change, so it never overwrites a value that an automation set. Real record-created and field-changed automations fire from these creates and updates. The planner models each published rule's Set-field action, so every record has an expected final state that includes automation results. The verifier compares final values against that expected state after the automation queue is empty. The seeder records automation runs that it observes and never creates them itself. Automations also set other fields, for example Follow-up required on work orders that pass through Scheduled or Overdue; those values are real automation results and can differ from the generated values.

The trigger-runs list has no filter by rule or record. Automation evidence therefore stays limited to the named cases, with a bounded number of pages, and each run is recorded once. Totals of automation runs are reported, not asserted.

**Safe edge retry.** A relationship write that returns the known busy 503 is retried only after the seeder reads that exact edge (field, source and target), with a short pause before the one retry. If the edge exists, the seeder records it as complete. If it does not exist, the seeder retries once. Any other unknown outcome stops the run.

**Planned rejections.** Each case records actor, request, expected status and detail, actual status and detail, and request ID in a separate `expected_failures` manifest section. They do not count toward totals. Only rejections that the API makes before any write are admitted:

| Case | Expected result |
| --- | --- |
| Guest creates a record in a module their group can manage | 403 `Forbidden` |
| Read-only member creates or edits a record | 403 `Forbidden` (edit uses a valid, non-empty body) |
| Member creates a record in a department they cannot see | 404 `Module not found` |
| Record with a missing required field, an unknown option, a wrong type, or an unknown field ID | 422 with `required_field`, `invalid_field_value` or `unknown_field` |
| Second link on the one-to-one Work Order → Inspection, or a duplicate edge | 409 with the exact conflict detail |
| Group change with an old `If-Match` | 412 `Resource changed` |
| Board post or event edit with an old item revision and the current Board revision | 409 `stale_post_revision` or `stale_event_revision` |
| Sign-in of a pending or disabled account, once each | 401 |

Stale record edits and reused report-run keys are not rejection cases: records have no revision check, and a reused key returns the original run. Any 5xx is a harness failure, never an expected result. Rejections run one at a time: record, link and group cases between sessions once their records exist; the stale post edit and sign-in cases after Board work. After the run, read-back must show exact counts and no audit row that carries a rejection's request ID.

**Natural content.** Record values use the language of each business area. Document numbers appear only where a business uses them (quotes, orders, invoices, receipts, work orders). Names of things are names, not codes. Contacts belong to their customer. E-mail addresses and URLs use the reserved `.example` domain with natural local parts, so no real mailbox or site is used. Names are invented, and a deny-list rejects known brands.

Rules for generated text, each with an example:

| Rule | Correct | Wrong |
| --- | --- | --- |
| Use the business name of the thing | `Forklift RT-07 hydraulic leak at Bay 3` | `Service Request · HOG-SR-000001` |
| Use a document number only for documents | `INV-2026-0412` | `Customer Site · HOG-SITE-000001` |
| Write notes as a person would | `Customer asked to move delivery to Friday; dock 2 is closed Thursday.` | `Harbor Operations Group follow-up for quotes 0001.` |
| Never mark data as generated | `Quarterly cycle count — Warehouse 2` | `Sample stock count (test data)` |
| Invent names; avoid real brands | `Tidewater Industrial Supply` | `Cebu Pacific Components` |

A generator test fails if any value contains a whole-word match for `sample`, `test`, `demo`, `dummy`, `fake`, `placeholder`, `lorem`, `ipsum`, `scenario` or `synthetic`, outside the reserved `.example` domain part. A short allow-list in the vocabulary module admits real trade phrases, such as `pressure test`, `load test` and `oil sample`, and the test checks every allow-listed phrase against that list. A second test limits exact-title repetition in each module. The workspace name stays Harbor Operations Group. Identity e-mail addresses move from `@harbor.example.test` to a `.example` domain.

**Development limits.** The development Compose overlay raises the Supabase Auth token and verify limits next to the e-mail limit. Production configuration does not change. The seeder also signs users in one at a time and refreshes each user only near expiry, one refresh at a time. It never retries a refresh in parallel.

### Acceptance criteria

| ID | Criterion |
| --- | --- |
| SIM-1 | For the same seed, anchor and profile, `plan` prints the same episode count, per-user write counts and planned rejections on every run. |
| SIM-2 | Every create, update and relationship audit row matches the planned actor for that write. No write comes from a user without the required access. |
| SIM-3 | At least 80% of active internal members make at least one write in Small, and all of them do in Standard. |
| SIM-4 | Record, edge and content totals equal the counts the run manifest records. |
| SIM-5 | Each planned rejection returns its expected status and detail. Read-back shows no record, edge, group, Board or audit change from these requests. |
| SIM-6 | No generated value contains a deny-listed word or brand. Title repetition stays under the configured limit in each module. |
| SIM-7 | A Standard run longer than the access-token lifetime completes without a 401 or a Supabase 429. |
| SIM-8 | An interrupted run stops with a readable manifest and never resumes by itself. The existing guarded reset clears it. |

### Implementation slices

1. **Development limits.** Change the development overlay, recreate only the owned Auth service, and stagger sign-ins. Proof: a controlled local run of 30 sign-ins and refreshes with no 429.
2. **Natural content.** Update the generator's names, notes, e-mail addresses, posts, events and OpenView names. Keep named financial and purchasing scenarios and the first record of each module stable. Proof: generator tests for the deny-list and repetition limits, and the existing scenario tests.
3. **Actor plan and group access.** Add creator and assignee keys, change group access, and match the verifier to planned actors. Proof: generator and verifier tests.
4. **Episode planner and executor.** Order episodes, write edges right after their records, and add the safe edge retry. Proof: planner tests for parent-before-child order and determinism, and a Small run.
5. **Record history.** Add update episodes that follow each module's status order. Proof: generator tests for status order and expected final state; observed automation results in the Small run after slice 6.
6. **Planned rejections.** Add rejection episodes, the manifest section and the no-change read-back. Proof: a Small run with all cases matching.
7. **Standard run.** Reset, populate and verify Standard once.

Live runs happen at three fixed points, because each needs a guarded reset that the operator confirms: a Small run after the episode planner, a Small run after planned rejections, then Standard. The first reset also clears the partial Standard data. Other slices use generator and planner tests only.

Backend files keep the 500-line limit. `sample/population/people.py`, `sample/scenario.py` and `sample/client.py` are near it, so the planner, executor, text vocabulary and rejection logic go into new modules.

### Decisions

- Work sessions: a user does two to six episodes in a row, with business journeys running through the sessions.
- Group access: Inventory, Purchasing and Finance members get write access to all modules in their department.
- Identity e-mail domain: `@harbor-ops.example` replaces `@harbor.example.test`, with natural local parts such as `carlo.reyes@harbor-ops.example`.
- Record history: about 40% of records receive one to three updates. This adds about 16,000 Standard writes. Standard is expected to take 75 to 100 minutes.

## Proposed: run sizes and organization packs

Status: **Harbor and School pack data are implemented.** Organization extraction, run sizes and manifest version 2 are complete. School has offline admission checks. Its live Small run and user check are pending. No live run was performed for these changes. Decided with the user on 2026-09-30.

### Run sizes

Each run populates one organization pack. The operator runs one pack, checks it in the app, resets the sample data with the guarded reset, and runs the next pack.

| Profile | Records | Use |
| --- | --- | --- |
| Standard | 5,000 to 7,000 per pack, across all its departments and modules | The normal run for each organization |
| Small | Each Standard module count divided by five, rounded upward, minimum one | A quick check while a pack is being built |
| Large | Four times Standard | Occasional scale check; opt-in |

Each pack sets its own module counts so that its Standard run falls in the 5,000 to 7,000 range. Version 2 manifests record the organization pack, profile, simulated span, sampling scope, exact module counts and planned totals. `verify` rebuilds the dataset from the recorded module counts, so later default-count changes do not alter an older run. Version 1 manifests use the frozen Harbor counts under the old rules. Changes to a pack's fields or generators can still affect verification; these manifests do not freeze a full pack revision. The 20,000-record Harbor run from 2026-09-30 is a Large-size run under the old definition.

### Organization packs

OpenSlate serves any organization, so sample data is not limited to a business. A pack is one complete organization: its departments, modules, fields, relationships and automations; its people, groups and access; the vocabulary and copy for records, Board posts, events and OpenView; status paths for record history; its named scenario; and its country, locale, currency and time zone. A run uses one pack (`--organization <key>`), because one installation holds one organization. Changing packs needs a guarded reset.

| Pack | Organization |
| --- | --- |
| harbor | Harbor Operations Group: distribution and field service (current data) |
| school | A school: admissions, classes, enrolments, attendance, grades and fees |
| clinic | A clinic: patients, appointments, visits, prescriptions and billing |
| nonprofit | A nonprofit: donors, donations, programs, volunteers and grants |
| local-government | A local government office: permits, requests, inspections and payments |

[sample-organization-packs.md](sample-organization-packs.md) gives the research-based design for each pack: departments, modules and counts, chains, named scenario, refusals, trade phrases and country. It also proposes `fmcg-distributor` and `manufacturer` packs.

Design rules:

- A pack is data in `backend/operations/sample/packs/<key>/`, not a set of code hooks. The engine reads every count from the pack; no test pins a Harbor count unless it belongs to the Harbor pack.
- Planned rejections derive their actors and targets from the pack's access table and fields: a read-only member, a member without a department, a guest, a one-to-one relationship, and Select and Number fields in a writable module.
- Every pack has one named scenario: a parent amount that a child record settles in part (for example a school fee and a partial payment). Board links and verification read it from the pack.
- Harbor's purchasing and receipt reconciliation stays inside the Harbor pack.
- Each pack's design must pass the Sandbox document validation offline before any live run.
- The generated-data marker check blocks the words `sample`, `test`, `demo`, `dummy`, `fake`, `placeholder`, `lorem`, `ipsum`, `scenario` and `synthetic` (`tests/operations/sample/test_sample_text.py`), except inside the pack's allowed trade phrases (`TRADE_PHRASES`). Schools and clinics use the word "test" for real work, so each pack lists its own phrases.

Correct: `Grade 8 science unit test — Section B`. Wrong: `Test record for class 12`.

### Order of work

1. Extract Harbor into the pack interface with no change in output. A saved golden master of Harbor's dataset, sessions, history, Board steps, rejections and plan summary must stay identical.
2. Change run sizes and record the pack and counts in the manifest. This changes Harbor's Standard output on purpose, so save a new golden master after this step and record why it changed.
3. Build the School pack end to end, including a live Small run.
4. Add server-rule preflight, recorded random seeds, multi-seed offline checks, and the end-of-run admin and reorganization phases to Harbor and School. Pass offline review before any live run. Both packs must pass live before Clinic starts.
5. Build the Clinic, Nonprofit, Local government, FMCG distributor and Manufacturer packs one at a time, each with a live Small run. Large stays offline.

### End-of-run admin and reorganization contract

The phase plan records each actor, target, request expectation and final state. It uses a separate seeded generator, so the existing records, links, sessions, history and content stay identical. The manifest stores the plan before the first write. All original content and refusals finish before the new phases start.

1. Admin promotes one member, moves another between groups, changes group access, disables and re-enables a leaver, and ends a separate person's completed run session. A member's role-change attempt must fail without an application audit row.
2. Reorganization archives and restores a saved view, Dashboard, report and project Board. A non-manager's Board archive attempt must fail. The plan creates one extra project Board, archives it, previews purge and purges it through the confirmed UI API flow. Its earlier audits must remain.
3. Sandbox adds an optional text field, renames a module and adds a Select option, then publishes. It adds an empty module and publishes, closes that module through the draft and publishes, then reopens it and publishes. It restores the earlier open version into the draft and publishes it. It never closes a populated module. The final design has the original 24 operational modules plus this empty module.
4. Readback derives final roles, memberships, grants, restored items and published documents from the recorded plan. It checks every primary application audit and related row against the actor and request. Session revocation has no application audit: it checks one server-authored security event against the actor, target person and exact session request. Original records and links keep their existing exact checks. No failed write is retried by this phase executor.

Offline admission uses the server's schemas and validators across 20 fixed seeds per pack. Golden masters stay at seed 42 and add only phase hashes and the changed summary. A stop records the safe operator message and stage/action/substep, without response bodies or credentials. Board purge requires the operator's enabled instance setting; this work does not change that setting. Live runs, guarded resets and API process changes require separate user authorization.

### Product gaps found

- The Manage workspace screen in `main` is a local example ("Settings here are examples"). It does not read or save the workspace through the API, so a pack's locale and time zone are set and checked through `PATCH`/`GET /api/workspace` only. Connecting the designed Manage page to the API is a separate, design-led frontend task.
- The six Sandbox organization templates are all business types.

## Cleanup and acceptance

Reset is a separately confirmed operation, using the existing guarded `reset_application_data.py` workflow. Preserve the administrator when using that application's reset contract. Recreating the Supabase volume is a different, destructive operation affecting Auth and Storage and requires its own explicit approval. Do not carry an old plan's reset approval into a new installation.

For ordinary department lifecycle purge, that department's Board and database content cascade with the department. Attached file bytes must first be purged through their existing confirmed flow; foreign Board references still block source deletion. Preserve failure reporting across Auth, application data, and Storage.

Implementation must prove representative operations through rendered controls and the real authenticated API: record create/edit and all relationship cardinalities, invitation states, group authorization, stale revisions, supported select/person values, Board content and reminders, report snapshots, genuine audit attribution, session loss, interrupted population, and owned reset/rebuild. Preserve per-account cache isolation, drafts during background refresh, and current SSE/refresh behavior. Add only the explicitly authorized record and relationship controls.

Use focused meaningful tests followed by one stable work-unit batch, and the canonical pre-push gate for publication readiness. Preserve rerunnable procedures and run artifacts. Completion requires persisted, audited state and correctly rendered permitted results; configuration, screenshots, or a successful request alone do not prove the whole workflow.

Source contracts: [schema redesign](../specs/schema-redesign.md), [domain architecture](../architecture/03-domain-architecture.md), [field values](../architecture/06-data-architecture.md), and [access policy](../../backend/app/systems/access/policy/scope.py).
