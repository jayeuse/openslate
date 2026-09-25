# Boards and OpenView functionality audit and implementation plan

## 1. Executive assessment

Audit source: `main` at `5c190f44c67f438486e6e87089de4d56404827c5`.
The source checkout was clean. This report was created in the isolated
`plan/boards-openview-functionality` worktree.

Authentication is real, but Boards and most OpenView business data are still
account-scoped browser state. Boards has no registered backend behavior.
OpenView has a reusable saved-view API, but its frontend does not call it;
dashboards, charts, reports, audiences, refresh and schedules remain local.
Board file metadata survives within the sample snapshot, while file bytes do
not survive a reload.

The static Impeccable detector reported no deterministic violations. Source
review still found broken cross-page URLs, lost preview context, placeholder
refresh/schedule behavior, incomplete reduced-motion coverage, inconsistent
touch targets and several controls whose labels overstate persistence or
authorization. No browser, application, test or database behavior was executed
during the audit.

Product decisions for implementation:

- Preserve the ten global backend capabilities.
- Add FastAPI-enforced, per-Board `view`, `edit` and `manage` access.
- Scheduled announcements, reminders and reports deliver inside OpenSlate only.
- Implement and accept durable OpenView saved views first.

## 2. Complete control inventory

Statuses describe the pinned source, not proposed implementation.

### Boards

| ID | Location and label | Current behavior and status | Intended outcome and proposed behavior | Recommendation | Dependencies and backend readiness | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| CTRL-B01 | Loading, Retry, Retry refresh, notices | Implemented for local runtime | Preserve last-good server data and expose actionable retry | **Keep** | Backend missing | `frontend/src/components/systems/boards/page.tsx:134-155,765-795` |
| CTRL-B02 | Board switch, department/status/favorites filters, reset | Simulated local filtering and URL selection | List only authorized Boards; keep filters transient and selection in URL | **Keep** | Board list API missing | `boards/page.tsx:518-639` |
| CTRL-B03 | New/Manage board, archive, restore, permanent delete | Simulated lifecycle | Durable create/archive/restore; permanent deletion through lifecycle planning | **Keep** | Backend/lifecycle missing | `boards/page.tsx:640-747,809-839,1206-1243` |
| CTRL-B04 | Edit, Save, Cancel, Settings, Add widget | Simulated draft with navigation guard | Keep draft local; save with revision conflicts and retain on failure | **Keep** | Board update API missing | `boards/page.tsx:203-216,844-884` |
| CTRL-B05 | Overview, Calendar, Announcements | Implemented URL navigation | Preserve order and Board context | **Keep** | Not required | `frontend/src/components/workspace-navigation.ts:37-48` |
| CTRL-B06 | Refresh summaries/widget refresh | Placeholder timestamps only | Rename to Refresh data and refetch authorized records | **Clarify or rename** | Records reusable; invalidation mapping required | `boards/page.tsx:432-466,887-904`; `openview/components/widgets.tsx:656-677` |
| CTRL-B07 | Widget add/pin/reorder/duplicate/remove/settings | Simulated; shared with OpenView | Persist validated module/field UUID configuration without rewriting `WidgetSurface` | **Keep** | Board persistence missing | `openview/components/widgets.tsx:191-1007` |
| CTRL-B08 | Linked records, add/remove/open | Simulated; emits invalid `section=records` | Persist unique placements; use `/openview?module=...&record=...` | **Keep** | Placement API missing | `boards/page.tsx:982-1067,1370-1448` |
| CTRL-B09 | Blank/Template/Import/Private board creation | Simulated | Validate portable templates/imports; private means creator plus admins | **Clarify or rename** | Board/template API missing | `boards/components/administration.tsx:61-286` |
| CTRL-B10 | Board settings and visible roles | Simulated local policy | Persist metadata and authoritative role-view grants | **Keep** | Scoped ACL and department membership missing | `boards/components/administration.tsx:289-417` |
| CTRL-B11 | Preview as, permissions, Exit preview | Simulated; loses Board/section | Server-calculated access preview preserving URL context | **Keep** | Access preview missing | `boards/page.tsx:749-761,1165-1169` |
| CTRL-B12 | Duplicate/export/import/template tools | Simulated local utilities | Persist versioned structure-only templates/configuration | **Move to advanced** | Template API missing | `boards/components/administration.tsx:526-615` |
| CTRL-B13 | Activity | Synthetic entries | Sanitized Board-scoped projection of existing audit rows | **Keep** | Audit exists; projection missing | `boards/components/administration.tsx:616-651` |
| CTRL-B14 | Calendar navigation/search/Agenda/Month/New event | Simulated | Query durable events by date window; prefer Agenda on compact screens | **Keep** | Event API missing | `boards/components/calendar.tsx:1830-1941` |
| CTRL-B15 | Event reminders/actions/supporting information | Reminders are page-local | Persist reminder/lifecycle actions; display only real supporting content | **Clarify or rename** | Worker/notification/event API missing | `boards/components/calendar.tsx:551-849` |
| CTRL-B16 | Event editor and recurrence | Simulated with bounded validation | Persist timezone-safe series, audiences, links and files | **Keep** | Events/files require changes | `boards/components/calendar.tsx:1161-1365`; `boards/domain/content.ts:112-167,302-458` |
| CTRL-B17 | Announcement feed, Drafts, Archive, filters | Simulated | Query authorized durable lifecycle states | **Keep** | Announcement API missing | `boards/components/announcement-feed.tsx:529-721` |
| CTRL-B18 | Announcement actions/read/bookmark | Simulated | Persist shared lifecycle plus personal read/bookmark state | **Keep** | Announcement/personal APIs missing | `boards/components/announcement-feed.tsx:832-1088` |
| CTRL-B19 | Draft/Publish/Schedule/Preview editor | Scheduling advances only while UI runs | Background publication with immutable published revision | **Keep** | Publication worker missing | `boards/components/announcement-feed.tsx:1091-1345` |
| CTRL-B20 | Everyone/author/role/department/user audiences | Simulated, fail-closed locally | Enforce active backend identities and memberships | **Keep** | Identity/role reusable; department membership missing | `boards/components/content-fields.tsx:51-114` |
| CTRL-B21 | Attachments and record/external links | Partial; bytes are in-memory | Reference authorized ready Platform files and safe URLs | **Keep** | Files existing but requires Board purpose/associations | `boards/components/content-fields.tsx:139-446`; `boards/adapters/files.ts:32-143` |

### OpenView

| ID | Location and label | Current behavior and status | Intended outcome and proposed behavior | Recommendation | Dependencies and backend readiness | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| CTRL-O01 | Views/Dashboards/Charts/Reports | Implemented URL navigation | Preserve section order and safe URL identifiers | **Keep** | Not required | `workspace-navigation.ts:66,182` |
| CTRL-O02 | Data source | Simulated hard-coded modules | Load active backend modules/fields using UUIDs | **Keep** | Existing and reusable | `openview/page.tsx:665-840` |
| CTRL-O03 | Search/Clear | Local filtering | Search allowlisted requested text/select fields server-side | **Keep** | Record query requires changes | `openview/page.tsx:1403,1688` |
| CTRL-O04 | Filters and AND/OR | Local, maximum eight | Map all operators to typed predicates; preserve limit | **Keep; clarify limit** | Query requires changes | `openview/components/filter-editor.tsx:74-319` |
| CTRL-O05 | Sort and Group | Local complete sample | Stable backend sort/group results | **Move to advanced** | Grouped query missing | `openview/page.tsx:2004,2584` |
| CTRL-O06 | Six layouts | Implemented on sample rows | Preserve every layout with bounded pages/windows/groups | **Keep** | Record/grouped query changes | `openview/page.tsx:1889`; `openview/components/gantt.tsx:192` |
| CTRL-O07 | Layout configuration | Local presentation state | Persist separately from record query | **Move to advanced** | SavedView changes | `openview/page.tsx:2697` |
| CTRL-O08 | Saved view selector/save | Local only | Connect `/api/views`; retain unsaved drafts locally | **Keep** | Existing but requires changes | `openview/page.tsx:1256`; `openview/adapters/controller.ts:381` |
| CTRL-O09 | Rename/Duplicate/Delete view | Local commands | Merge into View actions; archive/restore | **Merge** | Restore/write auth missing | `openview/page.tsx:1805`; `openview/adapters/controller.ts:428-457` |
| CTRL-O10 | Set/Unset module default | Local mapping | Persist current-user default across devices | **Keep; clarify personal scope** | Preference API missing | `openview/page.tsx:2077` |
| CTRL-O11 | Reset changes/Reset OpenView | Global copy understates scope | Keep view reset; enumerate destructive global reset | **Clarify or rename** | Existing commands require server adapters | `openview/page.tsx:2417`; `openview/adapters/controller.ts:813` |
| CTRL-O12 | Inspect/Previous/Next/pagination | Local read-only | Real records with filtered-order navigation and offset paging | **Keep** | Existing and reusable | `openview/page.tsx:3138,3968` |
| CTRL-O13 | Copy safe link | Implemented | Keep identifier-only URLs | **Keep** | Not required | `openview/page.tsx:4061` |
| CTRL-O14 | Dashboard select/create/duplicate | Local | Durable revisioned lifecycle | **Keep** | Missing | `openview/components/analytics.tsx:757-966` |
| CTRL-O15 | Dashboard name/audience/refresh | Audience/refresh are previews | Authoritative audience; visible-page refetch cadence | **Move to advanced** | Missing | `openview/components/analytics.tsx:1050-1106` |
| CTRL-O16 | Add four widget types | Local, max 12 | Query live records/aggregates after save | **Keep** | Aggregate API missing | `openview/components/analytics.tsx:1124-1444` |
| CTRL-O17 | Widget settings/actions | Local draft | Persist validated UUID references and shared component contract | **Keep; move advanced settings** | Missing | `openview/components/widgets.tsx:271-1004` |
| CTRL-O18 | Recompute now | Placeholder timestamp | Rename Refresh now and perform refetch; hide until connected | **Clarify or rename** | Query adapter required | `openview/components/widgets.tsx:297-327,656-677` |
| CTRL-O19 | Dashboard save/reset/default/delete | Local | Revision save, personal default, archive/restore | **Keep** | Missing | `openview/components/analytics.tsx:1168` |
| CTRL-O20 | Chart source/type/dimension/metric/aggregation | Local | Server aggregate query; chronological date-line ordering | **Keep** | Aggregate API missing | `openview/components/analytics.tsx:1594-1658,1862-1917` |
| CTRL-O21 | Chart date/filter/top/legend/value settings | Local | Preserve validation; move presentation settings to Advanced | **Move to advanced** | Aggregate API missing | `openview/components/analytics.tsx:1965-2037` |
| CTRL-O22 | Chart Save/Reset | Tab-local | Current-user preference API | **Keep; clarify personal scope** | Missing | `openview/components/analytics.tsx:2082` |
| CTRL-O23 | Chart/Data table/CSV/Print | Local export | Complete authorized data with table alternative | **Keep** | Export requires changes | `openview/components/analytics.tsx:2104-2260,2612-2731` |
| CTRL-O24 | Report new/duplicate/template/source | Local | Durable recipes; ephemeral unsaved draft | **Keep** | Missing | `openview/components/analytics.tsx:2896-3070` |
| CTRL-O25 | Report fields/filter/sort/group/totals | Local | Preserve core fields; move advanced shaping controls | **Move to advanced** | Query/report APIs missing | `openview/components/analytics.tsx:3079-3222` |
| CTRL-O26 | Schedule/timezone/audience | Placeholder | Generate scheduled in-app report runs and notifications | **Clarify or rename** | Worker/runs/notifications missing | `openview/components/analytics.tsx:3224-3254,3300-3308` |
| CTRL-O27 | Report Save/Reset/Delete | Local | Revision save and archive/restore | **Keep** | Missing | `openview/components/analytics.tsx:3260-3290,3462` |
| CTRL-O28 | Report CSV/Print | Local | Complete authorized exports; scheduled CSV snapshots | **Keep** | Export/run support requires changes | `openview/components/analytics.tsx:3343-3412` |
| CTRL-O29 | Loading/Retry/pending/invalid/empty states | Local runtime states | Last-good server data and actionable recovery | **Keep** | Pattern reusable | `openview/page.tsx:737-964` |
| CTRL-O30 | Audience controls | Presentation metadata | Enforce private/everyone/role/user visibility | **Clarify or rename** | Artifact audience schema missing | `openview/domain/model.ts:471-514,743-813` |
| CTRL-O31 | `openview.view/edit` claims | Proposed locally but unenforced | Use existing `records.read/write` plus artifact ownership/audience | **Remove authoritative claims** | Existing RBAC reused | `access/domain/controller-utils.ts:36-58`; `backend/app/systems/access/users/permissions.py:9-20` |
| CTRL-O32 | Board record deep link | Incorrectly connected | Omit section; accept `records` temporarily as legacy alias | **Clarify or rename** | Frontend contract fix | `boards/page.tsx:1025-1029`; `openview/page.tsx:936-964` |

## 3. Recommended simplifications and layout effects

- Preserve navigation, section order, primary panels and editors.
- Merge saved-view lifecycle actions into one View actions menu. Capability
  remains available at the cost of one extra click for infrequent actions.
- Move sort/group/layout, audience/refresh, chart presentation and report
  scheduling under existing Advanced/Settings affordances.
- Rename timestamp-only refresh actions once connected; hide them before then.
- Rename global reset and enumerate affected artifacts.
- Default compact Boards view to Agenda while retaining Month.
- Add a semantic data table to dashboard charts.
- Apply global reduced-motion handling and consistent 44px targets.
- No larger redesign is required or authorized.

## 4. Functional specifications and backend readiness

### Authorization

- Keep the ten global capabilities.
- OpenView reads require `records.read`; mutations require `records.write`.
- Board reads require `records.read`; Board mutations require `records.write`.
- A Workspace Access denial of Record data wins on every surface, including
  OpenView queries, Board Record pickers/widgets, and Report runs and downloads.
  Report generation rechecks the policy after snapshot capture. Board grants
  and content audiences remain additional, independent checks.
  Boards additionally enforce per-Board view/edit/manage grants. Administrators
  and the creator manage; manage implies edit/view; edit implies view. Identity
  rules outrank role/everyone, deny wins at equal priority, and explicit view
  denial prevents higher actions; default deny. Board managers may use a
  bounded grantee chooser that exposes only active IDs and display labels.
- Board content audiences support everyone, author, role, user and department.
- Disabled/deleted/unresolved identities and memberships fail closed.
- Board managers do not bypass event or announcement audiences; Dashboard owners
  do not bypass widget audiences when those are introduced.
- Report owners do not bypass a Report audience for viewing runs or exports.
- An administrator must restore or permanently delete an archived or soft-deleted
  Board before detaching its department.

### Contracts

- Repair `/api/views`: correct write authorization, presentation/audience,
  restore, revision-checked archive and structured stale conflicts.
- Extend typed record queries with AND/OR, not-equal/suffix, allowlisted search,
  grouped results and aggregate queries.
- Preserve complete interval Timeline behavior by mapping start/end and optional
  deadline/progress field IDs in presentation; derive dates from live values.
  Date-line charts show every day in a bounded window in chronological order;
  hide Top results for that mode rather than truncating its time axis.
- Add `/api/dashboards`, `/api/reports`, report runs and OpenView preferences.
- Retain report-run snapshots until the Report is permanently deleted. Block
  source-record purge while a retained run snapshot references that record.
- Add `/api/boards` plus events, announcements, placements, templates,
  grants/access-preview, personal state and reminders.
- Board import/export uses a strict, size-bounded portable v2 configuration,
  not sample-only IDs or live database IDs. Resolve named active modules and
  fields by expected type before an atomic private Board create; fail the
  whole operation when a reference is unavailable. Exclude grants, audiences,
  placements, content and files from portable configuration. Export and
  duplicate only widgets visible to the acting manager. Translate a v1 sample
  export only where its source can be resolved, otherwise show a safe error.
- Board personal state persists favorites and one home Board per user; the
  current section remains URL state. Archived favorites remain stored, and an
  archived home is ignored until restored. Reads recheck current Board access.
- Board event series keep all-day dates distinct from timed UTC instants with
  an IANA timezone. Bound recurrence expansion to an inclusive calendar window,
  skip months missing the anchor date, choose the earlier offset in a repeated
  local hour, and shift a nonexistent local hour forward. Content-audience
  checks precede calendar counts and reminder eligibility, including for
  Board managers. Event attachments wait for the Board-file association choice;
  links can be added independently.
- Add current-user notifications.
- Keep direct JSON, route-local errors, framework `422`, offset pagination and
  explicit revision conflicts. Do not add feature-only ETag conventions.
- Require bounded idempotency keys for publication and manual report runs;
  use unique occurrence keys for scheduler work.
- SSE remains opaque invalidation only; clients refetch without discarding drafts.

## 5. Database ownership, isolation and proposed migrations

Phase 0 must complete before any database operation:

1. Give the worktree a unique non-secret instance identity.
2. Use a dedicated Compose project, container, network and volume.
3. Assign unique service ports, file root, log root and local credentials.
4. Record redacted ownership evidence under ignored `.agent-runtime/`.
5. Set and verify PostgreSQL `cluster_name`.
6. Automatically compare configured and live host/port/database/user/cluster,
   plus container/volume ownership, before every mutating process.
7. Add a per-database Alembic advisory lock.
8. Provision roles and initialize source history; verify starting head and drift.
9. Keep tests on runner-owned disposable PostgreSQL instances.

Supabase project IDs, hosted linking, Supabase Auth/Storage and shadow databases
are inapplicable. OpenSlate uses vanilla PostgreSQL, FastAPI Identity and private
filesystem bytes.

Migration order:

1. Additive SavedView presentation/audience and personal defaults.
2. OpenView dashboards, reports, preferences, report runs, the minimal durable
   Report scheduler, and current-user notification storage needed by Phase 3.
3. Boards, grants, widgets, placements, templates and the minimal Board file-purpose/association extension needed for B21.
4. User-department membership, events, announcements/revisions, links and personal reminders.
5. Extend scheduler work kinds and notification delivery for Board content.
   Update lifecycle/reset ownership alongside each affected table, not in a
   deferred final migration.

## 6. Phased implementation plan

| Phase | Outcome / controls | Changes | Acceptance |
| --- | --- | --- | --- |
| 0 | Isolation prerequisite | Worktree-owned services, target guard and migration lock | Every wrong/unknown target fails before mutation; isolated head recorded |
| 1 | CTRL-O02-O13, O29, O32 | Connect real modules/records/views/defaults/restore and fix URLs | Authorized user saves, reloads, updates, defaults, archives and restores a view; stale writes retain draft |
| 2 | CTRL-O04-O07, O12, O20-O23 | Group/aggregate queries, six live layouts and complete exports | Group counts/exports are correct; all layouts use bounded authorized data |
| 3 | CTRL-O14-O19, O24-O30 | Durable dashboards/reports/preferences and in-app report runs | Artifacts survive reload; refresh refetches; scheduled run creates one snapshot/notification |
| 4 | CTRL-B02-B13, B21 foundation | Board CRUD/ACL/widgets/placements/templates, Board-scoped file reserve/list/download and activity | Users see and mutate only authorized Boards; preview matches real access; Board files cannot bypass ACL |
| 5 | CTRL-B14-B21 completion | Durable calendar/announcements/reminders/background publication; attach files and links to content with content-audience checks | Schedules/reminders execute once with correct timezone and audience; content attachments never reach broader Board viewers |
| 6 | Shared state and polish | SSE, error recovery, touch/reduced-motion/mobile/copy cleanup | Existing structure remains recognizable and no placeholder claims remain |

## 7. Test requirements and acceptance criteria

No tests were executed during the audit. Implementation requires:

- Focused backend and PostgreSQL integration tests for authorization, audience,
  concurrency, audit, lifecycle, files and scheduler races.
- Query tests for every operator, logic, search allowlist, pagination, grouping
  and aggregates.
- Migration guard, clean-install, source-head upgrade, preservation, privileges,
  drift, advisory-lock and recovery-limit tests.
- Frontend isolated tests for adapters, URL compatibility, drafts, conflicts,
  loading/failure and legacy decoders.
- Isolated desktop/mobile browser acceptance with keyboard, focus, 200% zoom,
  dark mode and reduced motion.
- One relevant stable batch per work unit, then the canonical pre-push gate once
  the complete implementation is stable.

## 8. Integration handoff requirements

Provide source/final commits and revisions, every migration dependency and
object, redacted isolation proof, API/OpenAPI changes, ACL precedence, file and
lifecycle mappings, exact check results, skips/blockers and concurrent heads.
Combined clean-install and upgrade tests run in a fresh integration database.

## 9. Assumptions, limitations and unresolved questions

- Scoped Board ACL, in-app scheduling and OpenView-saved-views-first are approved.
- Unsaved drafts remain local; saved artifacts are server-backed.
- When a Views URL has no module, select the first active catalog module in
  stable server order; show an empty state when no active module exists.
- No email, external calendar, push service, Supabase, deployment, merge or push.
- Existing browser sample data is not silently imported as authoritative data.
- Current runtime UI and test status were unverified during the audit.
- Board managers and Dashboard owners do not bypass narrower content/widget
  audiences. Private-only Dashboard work remains unchanged by this decision.
- An administrator cannot detach a department from an archived or soft-deleted
  Board; restoration or permanent deletion is required first.
- Archiving a Report retains its run snapshots. They remain until permanent
  Report deletion, and physical source-record purge remains blocked while a
  retained run references the record.
- Broadening a Report audience grants newly eligible readers access only to
  future runs. A retained run must remain restricted to the audience in force
  when that run was created, and a reader must also satisfy the current Report
  audience; Report owners have no bypass.
- Permanently deleting an archived announcement also deletes its immutable
  published revisions; archived announcements retain those revisions until
  permanent deletion.
- Each uploaded Board file belongs to exactly one Board. Cross-Board file reuse
  is not supported; each file may be attached to only one Event or Announcement
  content item within that Board. Attachment reads require that content audience.
- Permanently purging a Board file is blocked while an Event or immutable
  published Announcement revision still links it; do not silently remove those
  content links. A file can be purged after its links are removed or its linked
  content is permanently deleted.
- Move a pending reminder with its changed Event occurrence; cancel it when
  that occurrence is removed. Published Announcement inbox delivery targets
  people eligible for that content at publication, without manager bypass.
- Physical Record purge is blocked while Board Event or Announcement content
  links to it. External HTTP(S) links remain independent of that rule.
- A Board user with EDIT but not MANAGE may browse only bounded, minimal active
  user, role and department choices needed to target their Event or Announcement.
- A server-calculated workspace `today` field is approved as an additive
  Workspace response field for accurate 30-day Board line widgets;
  the staged renderer must show those lines as unavailable until a trusted
  workspace date is supplied.

## 10. Recommended first implementation slice

Complete Phase 0, then connect real OpenView modules, fields, record queries and
SavedView persistence. Include personal defaults, archive/restore, stale-write
recovery and the Board-to-OpenView URL fix. Accept this slice only after focused
backend/frontend tests, isolated migration upgrade proof and desktop/mobile
browser verification.

## Audit artifacts

- Branch: `plan/boards-openview-functionality`
- Worktree: `/Users/ceejayferuelo/.codex/worktrees/boards-openview-functionality/openslate`
- Source commit: `5c190f44c67f438486e6e87089de4d56404827c5`
- Report: `docs/plans/boards-openview-functionality-plan.md`
