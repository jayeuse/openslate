# UI-equivalent sample data plan

> Proposed follow-up to the schema redesign. This plan does not authorize population, a reset, new record-editing screens, or changes to an existing installation.

## Contract and current limit

Every populated value must be enterable through an existing supported UI control. Population must use that control's authenticated API operation with the same validation, authorization, concurrency, and audit behavior. Do not insert application rows directly, call internal services, provision identities through provider-admin APIs, or fabricate audit entries.

OpenView remains read-only. Its record inspector has no create/edit/relationship controls. Sandbox Test inputs are temporary simulations; Platform's sample record controls do not write live records. The record and relationship APIs alone therefore do not establish UI equivalence. The earlier proposal to add an OpenView record editor is withdrawn.

The 20,000-record Harbor Operations Group dataset and its live relationship graph are deferred until a separately authorized, API-backed authoring surface exists. Do not bypass this prerequisite by calling backend-only write routes. Configuration and Board content can be planned independently; empty results must remain visibly empty.

## Supported scope

Retain Harbor Operations Group with six departments and 24 modules. Use the existing Sandbox document editor, checkpoints, Test action, publication preview, and publication controls. Documents use version 4: select options have stable UUID IDs and editable labels, person fields store UUIDs, and modules may select a record-title field. Draft person values are explicitly simulated and do not prove live assignment eligibility.

| Area | Proposed coverage through current controls |
| --- | --- |
| Sandbox | Six departments, 24 modules, supported field types, relationship definitions, readable layout, checkpoints, temporary Test history, and actual publication history |
| Record triggers | Eight supported same-record Set-field rules using record-created, field-changed, threshold-crossed, and daily/weekly schedules; clearly distinguish simulated Test results from live executions |
| People | 36 invited internal identities: 30 active, four pending, two disabled; eight guests: six active, one pending, one disabled, with valid sponsors and expiry |
| Groups and access | Eight groups with overlapping membership and department/module read, write, and manage rows; roles are only admin, member, and guest |
| Boards | Built-in Company Board, six department Boards, and five project Boards; project access uses groups, department access follows its department |
| Board content | 96 posts, 144 events, genuine post revisions, and 24 event reminder configurations using supported timings |
| OpenView | 36 shared module Views across supported layouts, six department Dashboards with four widgets each, and 12 shared Reports; configure only outputs available through current controls |
| Files | 60 valid Board attachments using normal upload, scan, attachment, and download controls |
| History | Genuine user-attributed mutations and supported publication, scheduling, notification, and report-run history |

Counts are proposed targets, not evidence of created data. `plan` must report the exact admitted counts and exclusions before any future population. Chart settings are page-local and are not persistent sample entities. Report runs against empty modules may demonstrate empty-output behavior, not populated business results.

Exclude removed custom roles, service identities, access rules/defaults/deny policies, Board grants/templates/favorites/homes/personal read or bookmark states, content audiences, private Dashboards, and saved chart preferences. Workspace execution is not represented as a fabricated service account. Record links, live record-trigger scenarios, populated CSV/report outputs, and cross-module business journeys remain deferred with operational records.

The future operational target retains the original 20,000 records across Customers, Contacts, Quotes, Sales Orders; Customer Sites, Service Contracts, Service Requests, Request Updates; Equipment, Work Orders, Inspections, Maintenance Plans; Products, Warehouses, Stock Movements, Stock Counts; Suppliers, Purchase Orders, Purchase Lines, Goods Receipts; and Invoices, Payments, Expenses, Credit Notes. Revalidate exact distributions and Small/Standard/Large profiles when live authoring is authorized. Retain deterministic business values with seed 42 and an explicit Asia/Manila business-date anchor; server IDs and authentication timestamps remain server-generated.

## Control-to-API catalogue

Before implementation, catalogue each admitted operation with its reachable page/control, editable fields, actor and access requirements, API request, concurrency preconditions, expected saved state, and audit behavior. A route existing in OpenAPI is insufficient.

Use current boundaries:

- Sandbox document/checkpoint/Test/publication operations under `/api/sandbox`; preserve preview digest, password confirmation, revision, and idempotency requirements.
- Invitations and account actions through the Access UI's endpoints. Complete selected invitations using matching messages in the owned Mailpit instance and the normal invitation-completion endpoint.
- Groups through `/api/access/groups`; use the dedicated member and access replacement operations with `If-Match`. Administrators set access; eligible department managers may change membership within the existing policy.
- Boards through their existing scope, project-group, post, event, widget, file, and lifecycle controls. Record-link APIs are deferred until live records exist through an admitted workflow.
- Shared Views, department Dashboards, and module Reports through their existing editors; keep OpenView record inspection read-only.
- Manage and Platform only where the current screen is genuinely connected to an authenticated API. Local sample controls and unsupported settings are exclusions, not a mandate to implement new product features.

No new services, API contracts, import system, preference system, or broad placeholder-replacement project is part of this plan.

## Proposed operator workflow

Rebuild the retired sample tool only as a separate authorized implementation. Keep operator commands under `backend/operations/`: `plan` performs read-only admission and prints counts; `populate` executes admitted controls' API workflows; `verify` reads back counts, states, access, and audit evidence.

1. Confirm the owned installation, schema, API identity, administrator session, controlled Mailpit delivery, and an explicitly approved empty baseline.
2. Author and publish the Sandbox design with normal controls' preconditions. Resolve server-issued IDs through authorized reads.
3. Invite people, complete only the selected invitations, configure groups and access, and exercise allowed and denied users through separate sessions.
4. Configure Boards, posts, events, reminder settings, widgets, and scanned attachments. Preserve author archiving. Reminders use start, 15 minutes, or one day, with delivery permitted up to 15 minutes late.
5. Configure shared Views, Dashboards, and Reports. Record empty results honestly. Keep scheduled triggers/reports disabled at completion unless a bounded real scheduling scenario explicitly requires otherwise.
6. Verify every admitted count and result. Report deferred operational data and any incomplete operation separately.

Use the existing HTTP client, normal login/refresh flow, isolated cookie jars, Origin/CSRF handling, and ordinary API validation. Prompt for the administrator password without retaining it. Generate strong sample credentials and keep them in an ignored owner-only roster, separate from evidence. Pending invitees have no completed-login credentials.

Write sequentially, respect rate limits, and retain logical/server ID mappings and completed-operation status in a private journal without credentials. Do not blindly replay an uncertain POST or silently overwrite a partial run. A timeout is an incomplete outcome, not successful population.

## Cleanup and acceptance

Reset is a separately confirmed operation, using the existing guarded `reset_application_data.py` workflow. Preserve the administrator when using that application's reset contract. Recreating the Supabase volume is a different, destructive operation affecting Auth and Storage and requires its own explicit approval. Do not carry an old plan's reset approval into a new installation.

For ordinary department lifecycle purge, that department's Board and database content cascade with the department. Attached file bytes must first be purged through their existing confirmed flow; foreign Board references still block source deletion. Preserve failure reporting across Auth, application data, and Storage.

Future implementation must prove representative operations through rendered controls and the real authenticated API: invitation states, group authorization, stale revisions, supported select/person values, Board content and reminders, scan-gated files, report snapshots, genuine audit attribution, session loss, interrupted population, and owned reset/rebuild. Preserve per-account cache isolation, drafts during background refresh, and current SSE/refresh behavior. Do not add polling or new write controls to make a demonstration appear complete.

Use focused meaningful tests followed by one stable work-unit batch, and the canonical pre-push gate for publication readiness. Preserve rerunnable procedures and run artifacts. Completion requires persisted, audited state and correctly rendered permitted results; configuration, screenshots, or a successful request alone do not prove the whole workflow.

Source contracts: [schema redesign](../specs/schema-redesign.md), [domain architecture](../architecture/03-domain-architecture.md), [field values](../architecture/06-data-architecture.md), and [access policy](../../backend/app/systems/access/policy/scope.py).
