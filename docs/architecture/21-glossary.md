# Glossary

> **Scope:** The system dictionary. One meaning for each OpenSlate term, the other names it has in code, routes, and plans, and the word to use in new writing.

## How to use this glossary

1. Find the term in the section for its area. The sections follow the sidebar and the backend `app/systems/` packages.
2. Use the word in the **Term** column in new docs, plans, chat, and UI copy.
3. Keep code identifiers as they are. The **Also appears as** column maps them to the term. This glossary does not ask for code renames.
4. Before you add a word to customer copy, check the **Copy** column. "Internal" means the word is correct for the team but not for customers.
5. Read [Same thing, several names](#same-thing-several-names) and [One word, several meanings](#one-word-several-meanings) when two people use different words.

**Copy** values apply to public and positioning copy, per [PRODUCT.md](../../PRODUCT.md): **Customer** = safe there. **Internal** = keep it out of public copy. PRODUCT.md keeps "builder", "no-code", "platform", "workflow", and "module" out of customer-facing lines. In-app labels are a separate decision; the **Also appears as** column shows the labels in use now.

A **Status** note appears only when the term is not fully implemented. Status words follow the [architecture index](README.md#purpose-and-accuracy).

## Product and organization

| Term | Also appears as | Meaning | Copy |
| --- | --- | --- | --- |
| OpenSlate | "Slate" (planned name) | The current product name. A rename to Slate is planned; its timing is not decided. | Customer |
| Organization | `organizations` table, `WorkspaceProfile`, `org_id`, `/api/workspace`, `workspace_*` columns, Manage tab "Organization" | The customer and the one system it owns: its people, departments, records, and settings. One installation holds one or more organizations, and each one sees only its own data. | Customer |
| Installation | "Supabase Compose installation", "client", "deployment" | One self-hosted copy of OpenSlate with its own Compose project, credentials, and volumes. It holds one or more organizations. See [Supabase Compose installation](#infrastructure-and-identity). | Internal |
| Workspace | `WorkspaceNavigationGroup`, sidebar group | One area in the sidebar: Sandbox, Boards, Access, OpenView, Manage, or Platform. OpenComms and Appearance are links below the groups. Do not use "workspace" for the whole organization in new writing. | Internal |
| Section | `?section=`, `?view=`, `item`, `ViewTab` | One sub-page inside a workspace, for example Sandbox → Build. The URL key is `section` in most workspaces and `view` in Access and Manage. | Internal |
| System actor | "runs as the workspace", `actor_label`, empty `performed_by` | A change that no person makes, for example a record trigger or a scheduled report. The audit entry has no user and names the source in `actor_label`. | Internal |
| Organization builder | — | The internal product category. Customer copy speaks about ownership and outcome instead. | Internal |

## Sandbox

The Sandbox is where an administrator designs the organization: departments, modules, fields, relationships, and triggers. Backend package: `app/systems/sandbox/`.

| Term | Also appears as | Meaning | Copy |
| --- | --- | --- | --- |
| Sandbox | `SandboxDocument`, "shared Sandbox", `/sandbox` | The workspace for the organization design, and the one shared design draft it edits. | Customer |
| Build | `designer`, `designer.tsx`, legacy `?section=designer` | The Sandbox section where you lay out departments, modules, and fields on the canvas. | Customer |
| Design draft | `SandboxDocument`, `revision`, "Draft saved", "Unpublished changes" | The one shared, unpublished design for the installation. Its `revision` number stops two people from saving over each other. | Customer ("draft") |
| Publish | `publishSandbox`, `SandboxPublication`, "Review and publish" | The only way to create or change live departments, modules, and fields. It needs a preview, a matching revision, and the administrator password. | Customer |
| Binding | `SandboxBinding` | The map from a design item ID to the live department, module, or field that publish created. | Internal |
| History (Sandbox) | `SandboxVersion`, `versions`, legacy `?section=versions`, "Saved versions" | The list of design versions. A version kind is `checkpoint`, `published`, or `imported`. You can restore a version into the draft. | Customer |
| Organization template | `SandboxOrganizationTemplate`, "Start from a template" | A starting design for one kind of organization. Applying one replaces the draft. It is not a sample pack. | Customer |
| Department | `Department` | The top unit of the organization. It owns modules, one department Board, and dashboards. | Customer |
| Module | `Module`, "Data source" (OpenView, Platform, Boards record links) | One kind of record inside a department, for example "Orders". A module accepts new records while it has at least one active field. | Internal |
| Field | `Field`, `FieldType` | One value on a record. Types: text, long text, email, URL, number, decimal, integer (`int`), checkbox (`boolean`), date, date and time, select, user, relationship. | Customer |
| Record | `Record`, `Record.data` | One entry in a module. Its values are stored by field ID. | Customer |
| Batch update | `POST /api/records/batch-update`, `RecordBatchUpdate` | An explicit update of up to 100 selected records in one module, each with its own revision and one field or a pair of field changes. Each record is atomic; results separately report updated, stale, invalid, or forbidden items. It is not an update of every record matching a query. | Internal |
| Relationship | field type `relationship`, `RelationshipEdge`, UI kind `link`, "cross-department link" | A field that links records of one module to records of one target module, in the same or another department. Cardinality: one-to-one, one-to-many, or many-to-many. A person sees a link only when they can read both modules. | Customer |
| Record link | `BoardRecordLink`, "Record links" | A Board post or event that points to a record. It is not a relationship. | Customer |
| Trigger | `SandboxTrigger`, record trigger, `?rule=`, "rule", "automation" | A rule that changes a field on its own record when an event occurs. Events: record created, field changed, threshold crossed, schedule. **Status:** partially implemented. Only the set-field action publishes. Actions on other records or messages are deferred. | Customer |
| Automation | "Automation work is still pending" | The planned, wider form of a trigger that acts on other records or sends messages. **Status:** planned. Do not use "automation" for the set-field triggers that exist now. | Internal |
| Test | `SandboxTestRun`, `POST /sandbox/tests`, legacy `?section=simulation` and `preview`, "simulation" | A temporary run of the design against inputs that you type. It never creates records. The result says "Live workspace unchanged". | Customer |
| Simulation | — | The product idea behind Test: show how data moves through the design. It is not production automation. Use "Test" for the feature. | Internal |
| Live data | "live workspace" | The published departments, modules, and records that people use, as opposed to the design draft. | Customer |
| Lifecycle | `lifecycle`, `LifecycleOperation` | The controlled close, reopen, and purge of a department, module, field, record, file, or Board. | Internal |
| Close | `close` | Stop new work on a department, module, or field but keep its data. Close needs the typed name and a password challenge. | Customer |
| Reopen | `reopen` | Undo a close. Only Sandbox lifecycle items use "reopen"; other items use "restore". | Customer |
| Purge | `purge`, "Permanently delete", `LIFECYCLE_PURGE_ENABLED` | Remove an item and its owned data for good. Purge is enabled in new-installation examples; existing installations keep their required setting. Records support purge but not close. | Customer ("Permanently delete") |
| Impact | `impact`, `impact_digest`, `confirmation_name` | The preview of what a lifecycle action or publish changes. The request must send the digest back so that the server knows the person saw the current impact. | Internal |
| Password challenge | `LifecycleConfirmationChallenge` | A one-time check of the administrator password before a destructive action. Supabase Auth verifies the password; the challenge does not start an application session. | Internal |

## Boards

Boards are for communication. The Board scope decides who sees the content. Backend package: `app/systems/boards/`.

| Term | Also appears as | Meaning | Copy |
| --- | --- | --- | --- |
| Board | `Board`, `BoardScope` | A shared page of posts, events, and widgets. The scope is `company`, `department`, or `project`. | Customer |
| Company Board | scope `company` | The one Board for the whole organization. All active accounts read it; only administrators change it. "Company" is the scope name, not a word for the organization. | Customer |
| Department Board | scope `department` | The one Board for each department. Publish creates it, and it uses the department access level. | Customer |
| Project Board | scope `project`, `board_groups`, `BoardGroup` | A Board that an administrator creates. Access groups get a level on it through `board_groups` rows. | Customer |
| Post | `BoardPost`, `PostView` | A message on a Board. States: draft, scheduled, published, archived. | Customer |
| Post revision | `BoardPostRevision`, "Published revision", "Edit history" | An unchangeable copy of a post, made each time it is published. Readers can open earlier revisions. | Customer |
| Event | `BoardEvent`, "Calendar" | A dated item on a Board calendar. | Customer |
| Reminder | `event.reminders`, scheduled work kind `event-reminder` | A notification that the event author sets: at the start, 15 minutes before, or 1 day before. | Customer |
| Widget | `BoardWidget`, `DashboardWidget`, "tile" | A block on a Board overview or a dashboard that shows record data. Use "widget"; "tile" is an older name for the same thing. | Customer |
| Pin | `pinned` | Keep a post or widget at the top. Pinning needs `manage` on the Board. | Customer |

## OpenView

OpenView is for reading records and reports. Its content belongs to departments and modules, not to people. Backend package: `app/systems/openview/`.

| Term | Also appears as | Meaning | Copy |
| --- | --- | --- | --- |
| View | `?section=views`, `temporary-view`, "Unsaved view", legacy `?section=records` | A query over one module, shown as Table, Kanban, Calendar, or Timeline. It is not saved until you save it. | Customer |
| Saved view | `SavedView` | A view that is stored for the module. Every reader of the module sees it; `manage` on the module changes it. | Customer |
| Default view | `defaultViewId`, "Module default" | The one saved view that a module opens with. Making a new default clears the old one. | Customer |
| Dashboard | `Dashboard` | A page of widgets that belongs to one department. Each widget reads a module of that department. | Customer |
| Chart | `?section=charts`, `ChartDefinition` | A visualization of a module query. Unsaved editing and preview stay local; Save creates a shared saved chart. | Customer |
| Saved chart | `Chart`, `/api/charts`, widget `chart_id` | A revisioned query and presentation definition for one source module. Reading requires `read` on that module; creating, editing, archiving and restoring require `manage` on the chart's department plus `read` on its source module. Module-level `manage` alone is insufficient. It owns no materialized Record results; Dashboard and Board consumers recheck current source access. | Customer |
| Report | `Report` | A saved query recipe for one module that you run on demand or on a schedule. | Customer |
| Report run | `ReportRun`, "Run now" | One unchangeable result of a report. | Customer |
| Eligible readers | `ReportRunEligibleUser` | The module readers at the time of a report run. To open the run, a person must be an eligible reader and still read the module now. | Internal |
| Schedule | `ScheduledWork` kind `report-run`, "Create schedule" | A repeated time for a report run. A scheduled run uses the system actor. | Customer |

## Access

Access decides who can see and change what. Backend package: `app/systems/access/`. The one access function is `app/systems/access/policy/scope.py`.

| Term | Also appears as | Meaning | Copy |
| --- | --- | --- | --- |
| Person | `User`, `AccessUser`, "People" | One account in the installation. A person can belong to several organizations, and sees only the people of the current organization. Status: pending, active, or disabled. | Customer |
| Membership | `Membership`, `memberships` | The link between one person and one organization. It holds the account role, the status, the sponsor, and the guest end date. | Internal |
| Current organization | `X-Org` header, `active_org_id`, `?org=` | The organization that a request, a browser tab, or an event stream works in. The tab keeps its choice; without one, the session's active organization applies. | Internal |
| Organization owner | `owner_user_id`, `require_organization_owner` | The first administrator of the organization. Only this account or the installation owner changes the organization's security settings. | Internal |
| Installation owner | `PlatformOperator`, `platform_operators`, "operator" | The account that owns the installation. It sets installation-wide password and session rules and runs backups. On-premises, it is the first administrator. It gets no organization data from this role. | Internal |
| Person card | `PersonCardPopover`, `/api/users/{id}/card` | A read-only disclosure for a person identified by an authorized source, not a searchable directory. Guests see display name, job title and avatar only; authorized members/admins also receive contact details and biography. | Customer |
| Account role | `UserRole`: `admin`, `member`, `guest`; "Administrator", "Member", "Guest" | The role of a person in one organization, stored on the membership. An administrator manages everything in that organization only. A guest has a sponsor and an end date, and can only read. | Customer |
| Group | `Group`, `GroupMember` | A named set of people. Groups get access levels on departments, modules, and project Boards. | Customer |
| Access level | `AccessLevel`: `read`, `write`, `manage` | What a group can do on a department, module, or Board. `read` < `write` < `manage`. | Customer |
| Group access row | `GroupAccess` | One access level for one group on one department, or on one module of it. The module row overrides the department row for that group. | Internal |
| Effective level | `effective_levels`, `EffectiveAccess` | The level that a person has after all rows are resolved: the most specific row in each group, then the highest level across groups. No row means no access. | Internal |
| Invitation | `pending` user, `/auth/invitations` | An email that asks a person to set a password and join. | Customer |
| Password recovery | `/auth/recovery/*`, "Send recovery email" | The email flow that lets a person set a new password. | Customer |
| Email change | `POST /api/auth/me/email`, "Change email" | A current-password-verified request for confirmation at both the current and new addresses. Request acceptance does not change or reserve the saved email; only protected admission of the bound subject's current confirmed provider email updates it. See [confirmed email change](08-authentication-authorization.md#confirmed-email-change). | Customer |
| Email-change confirmation | `POST /api/auth/email/complete`, `/auth/email-change`, action type `email_change` | An explicit signed-out-browser use of a one-time email link. The first address's acknowledgment does not sign anyone in; final confirmation enters protected application admission and any required two-step verification. Provider success with a local conflict remains application-incomplete, without a new cookie or account merge. | Customer |
| Administrator recovery | `admin_recovery.py`, `operations/recover_local_admin.py` | An operator command that gives back access when no administrator can sign in. | Internal |
| Security recovery | `security_recovery.py`, `operations/recover_workspace_security.py` | An operator command that resets organization-wide sign-in security, such as two-step or IP rules. | Internal |
| Two-step verification | "MFA", "authenticator" | A second sign-in check with an authenticator app. Use "two-step verification" in customer copy. | Customer |

## Manage

Organization settings, audit/security events, backups and job monitoring. Backend package: `app/systems/manage/`.

| Term | Also appears as | Meaning | Copy |
| --- | --- | --- | --- |
| Organization settings | `WorkspaceProfile`, `/api/workspace`, Manage → Organization | The name, mark, contact details, time zone, and look of the organization. | Customer |
| Organization mark | `workspace_logo`, "logo" | The image that represents the organization in the app. | Customer |
| Audit log | `AuditLog`, `/api/audit-logs`, "Audit", "Record history" | The record of who changed what in application data. `AuditSession` writes it in the same transaction as the change. Alembic and direct SQL are outside it. | Customer ("Audit") |
| Security event | `SecurityEvent` | A sign-in or security action, kept in a table separate from the audit log. | Internal |
| Job | `/api/jobs`, Manage → Jobs, `JobResponse` | Administrator-visible work metadata for report runs, scheduled post publication, event reminders and backups. Manual Retry is available only for eligible failed work and is not automatic replay of an uncertain command. | Customer |
| Backup | `/api/backups`, "Backup history", "Encrypted export" | An encrypted copy of the installation data. **Status:** partially implemented. A guarded backup and manual restore exist; customer restore and automatic schedules are pending. | Customer |
| Updates & licensing | `updates`, `licensing` | The page for license state. **Status:** partially implemented. It shows that no license is required; it has no update check. Backup shows the server version from `/api/version`. | Customer |

## Platform

Shared services for every workspace. Backend package: `app/systems/platform/`. "Platform" is the name of this sidebar group only; do not use it for the product.

| Term | Also appears as | Meaning | Copy |
| --- | --- | --- | --- |
| File | `File`, file purpose `record_attachment`, `board_attachment`, `library_document`, `workspace_logo` | Metadata in PostgreSQL for bytes in the private Storage bucket. FastAPI checks access on each download. | Customer |
| File state | `awaiting_upload`, `uploading`, `ready`, `rejected`, `deleting`, `purged` | The upload and delete progress of a file. Only `ready` permits download. There is no virus-scan state. | Internal |
| File library | "Department file library", `purpose='library_document'`, `department_id`, `/platform?section=files` | The private files belonging directly to a department, outside any record or Board. Department read permits listing/download, write permits upload, and manage permits archive/reopen; module-only access grants none of these library rights. | Customer |
| Notification | `InAppNotification`, `NotificationKind` | A message in the app, for example a report run, a reminder, or a published design. | Customer |
| Scheduled work | `ScheduledWork`, `WorkKind`, `WorkState` | A queued background job: a report run, a scheduled post publish, or an event reminder. | Internal |
| Import & export | `record-import-api` | CSV import and export of records for one module. | Customer |
| Search | `?section=search` | Search across the records that a person can read. | Customer |
| Account | Platform → Account | The page for your own profile, sign-in sessions, and personal settings. | Customer |

## OpenComms

| Term | Also appears as | Meaning | Copy |
| --- | --- | --- | --- |
| OpenComms | `/comms`, `systems/comms`, `SampleComms`, "Comms" | Messages and channels. **Status:** sample only. It runs on browser-local sample state; the backend `comms` package is reserved and empty. Use "OpenComms" in all writing. | Customer |
| Comms sample state | `SampleProvider`, "Example" chip | Example conversations, preferences, and tools that are stored in the browser for one account. They are not application data and do not grant access. | Internal |

## Themes and appearance

| Term | Also appears as | Meaning | Copy |
| --- | --- | --- | --- |
| Organization look | `OrganizationTheme`, `ORGANIZATION_THEMES`, `workspace_profiles.theme`, "theme" | The theme that the organization uses for everyone: Slate (default), Whiteboard, Triplicate, or Stockroom. A look changes color, type, and materials only; layout, behavior, and words stay the same. | Customer ("look") |
| Appearance | `/settings/appearance`, `users.appearance` | The personal display settings of one person: color mode, text and display, and motion. | Customer |
| Color mode | "Theme" (Platform → Account), `openslate-theme` storage key | The personal light or dark choice. Use "color mode"; "theme" means the organization look. | Customer |

## Infrastructure and identity

| Term | Also appears as | Meaning | Copy |
| --- | --- | --- | --- |
| Application profile | `User` | OpenSlate's PostgreSQL-backed user record. It is explicitly bound to a Supabase Auth subject; provider email or metadata alone does not create application access. | Internal |
| Application session | `IdentitySession`, "sign-in session", "device session" | OpenSlate's server-side session state used for application session listing and revocation. FastAPI enforces revocation even if provider sign-out is unavailable. | Customer ("sign-in session") |
| Provider session | `provider_session_id` | The Supabase Auth session under an application session. It is not the application session. | Internal |
| Session revocation | — | OpenSlate's application-level denial of a previously issued session. It stays authoritative even when provider-side sign-out cannot complete. | Internal |
| Provider subject | — | The Supabase Auth user identifier explicitly associated with an OpenSlate application profile. | Internal |
| Authentication | — | Verification of who signed in. Supabase Auth performs provider identity and credential checks; this does not decide what a person may access in OpenSlate. | Internal |
| Authorization | — | FastAPI's decision about whether a bound, eligible profile may access an application route or resource under current OpenSlate roles, groups, and access levels. | Internal |
| Application schema | — | OpenSlate-owned tables and types managed by SQLAlchemy models and Alembic migrations. | Internal |
| Provider schema | — | Supabase-owned database objects, such as Auth or Storage metadata, which OpenSlate's Alembic migrations do not own. | Internal |
| `DATABASE_BOOTSTRAP_URL` | — | Operator-only Supabase database connection used to provision OpenSlate database roles and grants. | Internal |
| `MIGRATION_DATABASE_URL` | — | Owner connection used by Alembic for OpenSlate application-schema changes. | Internal |
| `DATABASE_URL` | — | Constrained `openslate_runtime` connection used by FastAPI and application workers. | Internal |
| Ready object | — | Immutable private Storage object in `openslate-ready`, written after file-type validation; FastAPI still authorizes each download. | Internal |
| Supabase Compose installation | — | One self-hosted Supabase and OpenSlate deployment with its own Compose project, credentials, networks, and persistent volumes. It is per client and can hold several organizations; it is not a hosted service. | Internal |
| Supabase Storage | — | Provider-managed object API and persistent volume for OpenSlate's private file bytes. FastAPI, not the browser, uses its privileged credentials. | Internal |
| Supabase Realtime | — | Provider WebSocket service for private organization channels (`org:<org_id>:…`). A client joins with a 5-minute FastAPI token; RLS on `realtime.messages` checks the membership at each join. Invalidations stay on SSE. | Internal |
| SSE invalidation | `/api/events`, `platform/events` | Authenticated opaque signal asking a client to refetch authorized application data through FastAPI. It does not include protected row snapshots. | Internal |
| `/api/ready` | — | Bounded component readiness report for Database, Auth, Storage, and SMTP configuration, all required; mail delivery, schema compatibility, and backup integrity need separate checks. | Internal |
| `WEB_ASSETS_ROOT` | — | Server-side path to the static frontend export served by FastAPI in production. | Internal |

## Sample data and delivery

These terms describe how the team fills an installation with realistic organization data and plans work. They are internal.

| Term | Also appears as | Meaning |
| --- | --- | --- |
| Sample pack | `OrganizationPack`, `operations/sample/packs/`, "pack" | The data for one example organization: people, departments, catalog, scenarios, and content. Harbor and School are the reference packs. |
| Pack contract | [sample-pack-contract.md](../plans/sample-pack-contract.md) | What each pack must supply so that the generic runner can exercise every control. |
| Sample run | `operations/seed_sample_data.py plan\|populate\|verify` | One run that writes a pack into an installation through the same APIs as the UI, as real users. It checks request shape, status, and end state. It does not check audit counts. |
| Run size | `SampleProfile`: `small`, `standard`, `large` | The amount of data in a sample run. For each module, Small is the Standard count divided by 5, rounded up; Large is Standard times 4. Each pack sets its own Standard counts. Do not call a run size a "tier". |
| Control | `plan_controls`, `operations/sample/controls/` | One UI action that a sample run sends through the API, for example "invite a person". |
| Expected refusal | `RejectionCase`, `expected_failures` | A request that a sample run sends on purpose and that the API must refuse. Use "refusal" in writing. |
| Phase (sample) | "Phase 0" to "Phase H" in the pack contract | One batch of controls added to sample runs. A phase is a delivery step, not a product feature. |
| Tier | "Tier 1", "Tier 2", "Tier 4" in [system-completion-tier-1.md](../plans/system-completion-tier-1.md) | One stage of the product completion roadmap. "Phase A" to "Phase D" inside that plan are stages of Tier 1, not sample phases. |
| Seed | `--seed` | The random-number seed of a sample run. It is not a name for sample data. |

## Testing and gates

| Term | Also appears as | Meaning |
| --- | --- | --- |
| Pre-push gate | `scripts/prepush.py --base <ref>` | The full check set that runs once, right before a push. It selects checks from the changed paths. |
| Focused test | — | A small test run for the changed files and their direct callers, used while work continues. |
| Disposable stack | Compose project `openslate-e2e-*` | A temporary Supabase stack that the test runner creates and removes. It is not the development stack. |
| Development stack | Compose project `openslate-supabase-local-*` | The one owned Supabase stack for daily development in a checkout. Keep it and its volumes. |
| Reset acceptance | `--reset-acceptance-only` | The check that the local application-data reset works on a disposable stack. |
| `isolated` / `http` / `fullstack` | Playwright projects | Playwright test layers. `isolated` runs without a dev server. `http` runs in a browser against the Next.js dev server. `fullstack` runs against real FastAPI and Supabase through `backend/tests/fullstack_runner.py`. |

## Same thing, several names

Each row is one concept. Use the word in **Write** in new docs, plans, and UI copy. The other names stay valid in existing code.

| Concept | Names in use | Write |
| --- | --- | --- |
| The customer and its whole system | organization, workspace (`WorkspaceProfile`, "Make this workspace feel like your organization"), company, business (`manage/businesses`), client, installation | **organization**. Use **installation** only for the deployed copy, and **company** only for the company Board scope. |
| One kind of record | module, data source (OpenView, Platform) | **module** in team writing. The in-app label is not decided: the UI says "module" in Import and "Data source" in OpenView. |
| A link between records | relationship, link, cross-department link | **relationship**. A **record link** is the different Board feature. |
| The Sandbox design area | Build, designer, Sandbox, design | **Build** for the section, **Sandbox** for the workspace. |
| A trial run of the design | Test, simulation, preview | **Test**. |
| The list of design versions | History, versions, saved versions, checkpoints | **History** for the section, **version** for one entry. |
| A rule on a record | trigger, record trigger, rule (`?rule=`), automation | **trigger**. Keep **automation** for the planned, wider feature. |
| A block of record data on a page | widget, tile | **widget**. |
| A stored module query | saved view, view, temporary view | **saved view** when stored, **view** when not. |
| The two-step sign-in check | two-step verification, MFA, authenticator | **two-step verification**. |
| The organization theme | look, theme, organization theme | **organization look**. |
| Personal light or dark | color mode, theme | **color mode**. |
| Messages and channels | OpenComms, Comms, comms | **OpenComms**. |
| A request that must fail | refusal, rejection, expected failure | **refusal**. |
| The size of a sample run | size, profile, Small/Standard/Large | **run size**. |
| A change without a person | system actor, workspace actor, "runs as the workspace" | **system actor**. |

## One word, several meanings

Each row is one word with more than one meaning. Add the qualifier in **Write** so the reader knows which meaning you use.

| Word | Meanings | Write |
| --- | --- | --- |
| workspace | (1) a sidebar group; (2) the whole organization in some UI and code; (3) the system actor; (4) the OpenComms settings dialog; (5) "live workspace", meaning published data | **workspace** for meaning 1 only. Use **organization**, **system actor**, **OpenComms settings**, and **live data** for the others. |
| session | (1) application session; (2) provider session; (3) `SandboxDocumentSession`, the loaded draft in the browser; (4) `AuditSession`, the database session that writes audit rows; (5) browser `sessionStorage` | **sign-in session** for 1, **provider session** for 2. Name the code type for 3 and 4. |
| group | (1) an Access group; (2) a project Board's `board_groups` row, which is an Access group with a level on that Board; (3) `group_by` in a query; (4) message grouping in OpenComms | **group** for 1. Say **Board access** for 2 and **group by** for 3. |
| history | (1) Sandbox History (design versions); (2) audit log, also shown as "Record history"; (3) post "Edit history" (post revisions); (4) "Backup history" | Say **design history**, **audit log**, **post revisions**, or **backup list**. Do not use "history" alone. |
| version / revision | (1) design version; (2) post revision; (3) the `revision` concurrency counter on the draft, groups, and Boards; (4) the software release (`GET /api/version`); (5) the document `schemaVersion` | **version** for 1 and 4, **post revision** for 2, **revision number** for 3. |
| test | (1) Sandbox Test; (2) automated test suites; (3) `ENVIRONMENT=test`; (4) disposable test stacks | **Sandbox Test** for 1. **test suite**, **test environment**, and **disposable stack** for the others. |
| sample | (1) browser-local example data (OpenComms, the "Example" chip); (2) organization data that a sample run writes through the real APIs | **example data** for 1, **sample data** for 2. |
| template | (1) Sandbox organization template; (2) OpenComms channel and message templates; (3) Supabase Auth email templates | Always add the qualifier: **organization template**, **channel template**, **email template**. A template is never a sample pack. |
| phase | (1) a sample-run control batch; (2) a stage inside the Tier 1 plan; (3) `PhaseName` end-of-run steps in sample code | **sample phase**, **Tier 1 phase**, or the code name. |
| event | (1) Board calendar event; (2) the SSE stream `/api/events`; (3) a trigger event; (4) a security event | **event** for 1. **SSE invalidation**, **trigger event**, and **security event** for the others. |
| export | (1) Platform CSV record export; (2) Manage encrypted export of a backup; (3) Sandbox design export (JSON); (4) Board configuration export; (5) audit CSV export | Name the source: **record export**, **backup export**, **design export**, **Board export**, **audit export**. |
| recovery | (1) password recovery; (2) administrator recovery; (3) security recovery; (4) backup restore | Use the full name from the [Access](#access) and [Manage](#manage) tables. |
| Manage | (1) the Manage workspace; (2) the `manage` access level | **Manage** (capital) for 1, **`manage` level** for 2. |
| Platform | (1) the Platform workspace; (2) the backend `platform` package; (3) a word for the product | Meanings 1 and 2 only. Never use "platform" for the product. |
| client | (1) a customer installation; (2) an HTTP client; (3) a sample-run login client | **installation** for 1. |
| archive / close / delete | (1) close: Sandbox departments, modules, and fields, data kept; (2) archive: Boards, published posts, events, views, dashboards, reports; (3) delete a record: soft, undone with restore (`DELETE /records/{id}`, `POST /records/{id}/restore`); (4) delete a never-published post: permanent; (5) purge: permanent | Use the verb of the item's own row above. Use **restore** to undo an archive or a record delete, and **reopen** to undo a close. Say **permanently delete** for 4 and 5. |
