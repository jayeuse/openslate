# System completion: Tier 2 plan

Base revision: `main` at `9e732b84`. Alembic head: `dfa5340b47ba`. OpenComms is out of scope.

Status: approved for delegation. The owner answered the Tier 2 questions on 2026-10-08. Section 7 holds the decisions. Each default in section 7 stands unless the owner edits the table before the affected slice starts. Section 11 is the execution order.

Amended 2026-10-08 after the first run stopped with 5 of 33 slices done. The amendment adds decisions D21–D26, section 11.8 (implementer decisions), and section 11.9 (resume order), and changes section 11.6. Two plan defects caused most blocks: sample executors were scheduled last although an existing guard requires them with each route, and the block rule did not let the implementer settle routine contract details.

Final acceptance ownership: the owner performs S32, S33, and fixes found during that acceptance. The implementation agent completes every code slice and S31, including D21 executors and per-slice checks, then hands off under section 11.10. The substantive S32/S33 requirements remain unchanged.

Per-slice testing amendment: the implementation agent may run substantially larger tests for an individual item or slice whenever needed to implement and verify its intended feature. Earlier references to focused checks are a starting point, not a ceiling on relevant regression, integration, or end-to-end testing. Final testing, fixes discovered during final acceptance, and the acceptance gate remain owner-owned.

The evidence comes from static reads of the source at the base revision. Nothing was executed. Section 9 lists the claims that are not tested yet.

## 1. Intent

Tier 1 removed the fake controls and made the installation manageable without a command line. Tier 2 makes every existing feature complete its full cycle before OpenComms starts:

1. People save, analyze, export, and edit data where they see it.
2. Screens stay current without a manual refresh. An open editor never loses typed text.
3. Each person owns a profile and sets how the system looks and behaves for them.
4. An administrator reads security events and job health in plain language.
5. Permanent delete works, with one consistent set of safeguards.
6. The documentation describes the current system.

Tier 2 adds no new product area. OpenComms, and the items in section 10, stay after Tier 2.

## 2. Baseline and changes since the owner's answers

The owner answered against an audit of 2026-10-05. Tier 1 then merged, so some items are now partly done. This plan contains only the remaining work.

| Owner item | Already delivered by Tier 1 | Remaining in Tier 2 |
|---|---|---|
| 14 Security events | A feed with filters and paging in Access › Security (S25) | Move it to a Manage › Audit tab. Render each event as a sentence. Label every event type. Use server search for the person filter. |
| 19 Paging | Server paging for People (S26) | Seven adapters that still load every page, three other loops, the Board groups picker, and the `post-authors` route |
| 21 Small items | The orphan `/access-restricted` route and the unused SVG files are deleted (`8aafecaa`) | Login error text, the root redirect, and the Help panel |
| 22 Cleanup | No dead sample code remains outside Comms | Misnamed shared files, and all stale documents |
| 13 Profile | Settings › Appearance with color mode, motion, shortcuts, text size, and density (S17, S18) | Everything else in W7 |

This plan replaces three Tier 1 decisions:

- **Tier 1 D4** (purge stays off). Permanent delete is now on by default (D1).
- **Tier 1 W2b** ("do not add personal timezone or week start"). These are now personal display settings only (D14).
- **Tier 1 D1 and S25** (security events in Access). The events viewer moves to Manage › Audit (D17).

Facts that shape the design:

- `PATCH /records/{id}` replaces all active field values. A partial body erases the fields it omits. A drag edit therefore needs a server-side merge (D10).
- The backend never delivers Board events. Every Board entity is in `_PRIVATE_INVALIDATION_ENTITIES` (`platform/events/models.py:11-29`). Dashboard events reach administrators only. Live updates therefore need a backend change (D8).
- Record export is admin-only and CSV-only (`records/query_router.py:47-48,128-147`). No Excel library is installed.
- Aggregation supports count, sum, and average, one dimension, and daily buckets only (`records/query_schemas.py:228`, `records/aggregation.py:147-199`). Records live in one JSONB column, and every field has a declared type. Aggregation works by the field type.
- Dashboard widgets and Board widgets use two different schemas (`openview/dashboards/schemas.py:22-65`, `boards/widget_schemas.py:16-39`). No saved-chart concept exists.

## 3. Workstreams

| ID | Workstream | Owner's item | Size |
|---|---|---|---|
| W1 | Naming cleanup and documentation update | 22 | 5–7 days |
| W2 | Login text, root redirect, Help panel | 21 | 4–5 days |
| W3 | Server paging for every list | 19 | 5–7 days |
| W4 | Live updates for Boards and Dashboards | 11 | 8–10 days |
| W5 | Permanent delete on by default, and the route bundle | 12, 20 | 7–9 days |
| W6 | Sandbox relationship lifecycle and the version cap | 17 | 3–4 days |
| W7 | Profile page and person card | 13 | 13–17 days |
| W8 | Security events in Manage › Audit | 14 | 3–4 days |
| W9 | Export from OpenView (CSV and Excel) | 15 | 6–8 days |
| W10 | Drag to edit in Kanban, Calendar, and Timeline | 16 | 8–11 days |
| W11 | Jobs status | 18 | 5–7 days |
| W12 | Analytics: saved charts, editors, richer aggregation, dashboard grid | 9, 10 | 18–25 days |

The sizes are engineering-day estimates, not measurements. The total is about 85–115 days.

## 4. Order of work

```
Phase A  Small and independent
            ├─ W1a naming cleanup
            ├─ W2a, W2b login text, root redirect
            ├─ W5  purge default and consistency → purge UI → route bundle
            └─ W6  Sandbox
            │
Phase B  Shared foundations
            ├─ W3  paging (backend, then pickers and lists)
            └─ W4a backend event delivery for Boards and Dashboards
            │
Phase C  Features
            ├─ W8  security events          (needs W3 pickers)
            ├─ W4b Boards live updates      (needs W4a)
            ├─ W4c Dashboards on TanStack Query and live (needs W4a)
            ├─ W11 jobs
            ├─ W9  export
            ├─ W10 drag edit                (batch route first)
            ├─ W7  profile (email change last)
            └─ W2c Help panel               (needs the W7 profile page)
            │
Phase D  W12 analytics (needs W4c)
            │
Phase E  W1b documentation update, final review
```

Phase A comes first because each workstream is small and touches few shared files. W3 and W4a come before the features that depend on them. W12 is last because it is the largest workstream, and it changes the dashboard that W4c converts. W1b is last because every earlier slice changes what the documents must say.

## 5. Workstream details

### W1. Naming cleanup and documentation update

#### W1a. Naming cleanup (item 22)

**Today.** No dead sample code remains outside Comms. Some live files still carry sample names:

- `components/systems/shared/helpers/sample-collections.ts` holds generic paging helpers. Live importers: `access/components/groups-view.tsx:30`, `access/components/security-panel.tsx:35`, `manage/components/audit-data.ts:6`.
- `components/systems/shared/components/ui.tsx:17,36,60,92` has comments that say "sample". Live Platform files use it.
- `components/sample-data-note.tsx` lives at the shell root, but only `comms/page.tsx:61` uses it.

**Work:**

1. Rename `sample-collections.ts` to `page-collections.ts`. Update its importers.
2. Correct the comments in `shared/components/ui.tsx`.
3. Move `sample-data-note.tsx` into the Comms folder.
4. Keep the storage key `openslate.sample.v1` and the `releaseAllLocalAttachments` import in `app-shell.tsx`. Comms needs both.

Do W3 before you remove any use of `loadAllAccessPages`, because W3 replaces those callers.

#### W1b. Documentation update (item 22)

**Owner's decision:** update every stale document. Do not delete.

**Conflict with a repository rule.** `docs/AGENTS.md:5` forbids review findings, dated snapshots, and test-run results in documents. Every file in `docs/reviews/` is a dated review. Decision D19 resolves the conflict: rewrite each document as "current state and remaining gaps", and remove the dated findings. Git history keeps the old text.

**Work, in this order:**

1. Root `AGENTS.md:44` and `docs/architecture/{README.md:88, 09:5, 17:48, 21:56}`: change the purge default (W5).
2. `docs/architecture/09-lifecycle-and-state-management.md`: relationship lifecycle (W6).
3. `docs/architecture/05-frontend-architecture.md`: add `/profile`, the Help panel, the root redirect, the Manage › Jobs tab, the Audit security-events tab, and the Platform department library.
4. Add the department library to the architecture documents. `files.purpose='library_document'` exists, but no architecture document names it.
5. Every new term (saved chart, job, batch update, person card) goes into `docs/architecture/21-glossary.md`.
6. `frontend/AGENTS.md`: add `/profile`. Update the event-stream rule at line 50 for the new listeners (W4).
7. `frontend/README.md`: remove "Retired File library links resolve to Search". The library exists.
8. `docs/sandbox-designer-template-test-plan.md`: the export schema is version 4, not 3 (`designs/schemas.py:53`). Cross-department relationships do not block publish. The menu label is "Start from a template".
9. `docs/dynamic-field-validation-test-plan.md`: 13 field types, not 9 (`sandbox/fields/models.py:17-30`). Rewrite the test list from the actual tests; 16 of the 34 cited names do not exist.
10. `docs/plans/`:
    - `access-functionality-plan.md`: Access has four views (Overview, People, Groups, Security). Remove the roles, rules, and service-identity rows.
    - `access-recovery-compatibility.md`: backup configuration is version 3.
    - `boards-openview-functionality-plan.md`: Boards and OpenView are server-backed. Boards has posts, not announcements.
    - `sample-pack-contract.md` and `sample-organization-packs.md`: Phase G passed on 2026-10-03.
    - `schema-redesign-plan.md`: count the tables from the migrations, not from `__tablename__`. Remove the 15 missing test paths.
    - `ui-equivalent-sample-data-plan.md`: record edit and the Platform file library exist.
    - `system-completion-tier-1.md`: mark the delivered slices. Mark D4 and the W2b "do not add" lines as replaced by this plan.
11. `docs/reviews/`: collapse the seven reviews into one document, `docs/reviews/known-gaps.md`, with the gaps that remain. Delete the seven originals after the collapse. Git keeps them. This is the only deletion in W1b, and D19 approves it.

**Acceptance.** Every claim in an edited document matches the code at the end of the run. Every link resolves.

### W2. Login text, root redirect, Help panel (item 21)

#### W2a. Login error text

**Today.** `app/login/page.tsx:41-47` shows specific text only for 401. Every other status shows "Check your connection".

**Work:**

1. Add an optional `retryAfter` (seconds) to `ApiError` in `lib/api.ts`, read from the `Retry-After` header.
2. Map the statuses:

| Status | Text |
|---|---|
| 401 | Keep the current text. |
| 429 | "Too many attempts. Try again in N minutes." Use generic text when no `Retry-After` exists. |
| 503 | "Sign-in is not available now. Try again later." |
| 403 `ip_not_allowed` | "Sign-in from this network is not allowed. Contact your administrator." |
| Network error | Keep "Check your connection". |

Keep the 429 text generic. It must not say whether the account exists.

#### W2b. Root redirect

The export is static, so the redirect runs in the client:

1. In `app/page.tsx`, call `getSessionStatus()` (`lib/auth-api.ts:80-100`).
2. When a session exists, call `router.replace(await workspaceStartRoute())`.
3. Hide the call-to-action buttons until the check ends, so a signed-in person sees no flash of "Sign in".
4. Do the same check on `/login`.

W7 adds a personal start page. After W7, `workspaceStartRoute()` reads it first.

#### W2c. Help panel

1. Add a "Help" button to `AppHeaderActions` in `app-shell.tsx:728`. It opens a Sheet.
2. The Sheet has three parts:
   - **This page.** A short guide for the current route: 3–6 short entries per page. Keep the text in one typed file, `components/help/page-guides.ts`, keyed by the routes in `workspace-navigation.ts`.
   - **Keyboard shortcuts.** Read them from a new registry, `lib/shortcuts.ts`. Move the ad hoc handlers in `designer.tsx:519-544`, `sandbox/page.tsx:710-732`, and `sandbox-canvas.tsx:870-942` to declare their keys in the registry, so the list cannot drift. When the person turned shortcuts off, show "Shortcuts are off. Turn them on in your profile."
   - **Contact your administrator.** Show `contact_email` and `contact_phone` from `GET /workspace`. A guest gets no contact fields (Tier 1 D9), so a guest sees "Contact the person who invited you."
3. The shortcut setting today gates only `?` and `0` in the designer. Make it gate every registered shortcut except the browser-standard undo and redo.

**Acceptance.** Each workspace page has a guide. The shortcut list matches the registered handlers. A guest sees no organization contact.

### W3. Server paging for every list (item 19)

**Today.** These adapters loop over every page, up to 20 pages of 100 (`access/state/pagination.ts:7-8,22-90`):

| Adapter (`access/adapters/access-queries.ts`) | Endpoint | Consumers |
|---|---|---|
| `userListOptions` (`:81-89`) | `GET /users` | `people-view.tsx:225-229`, `groups-view.tsx:149`, `overview-view.tsx:165`, `security-events-view.tsx:315` |
| `groupListOptions` (`:140-147`) | `GET /groups` | `people-view.tsx:205`, `groups-view.tsx:144`, `overview-view.tsx:166` |
| `memberCandidateListOptions` (`:150-157`) | `GET /member-candidates` | `groups-view.tsx:151` |
| `departmentListOptions` (`:159-171`) | `GET /departments` | `people-view.tsx:206`, `groups-view.tsx:145`, `person-access.tsx:77` |
| `moduleListOptions` (`:173-185`) | `GET /modules` | `groups-view.tsx:146`, `person-access.tsx:78` |
| `userSessionsOptions` (`:127-136`) | `GET /users/{id}/sessions` | `person-sessions.tsx:46` |
| `libraryDepartmentsOptions` (`platform/adapters/platform-queries.ts:51-65`) | `GET /departments` | `platform/components/files.tsx:128` |

Other loops:

- `openview/adapters/departments-api.ts:41-58` (10 pages).
- `openview/adapters/openview-queries.ts:76-92` `boundedItems` (10 pages): data sources, fields, views, record links.
- `openview/adapters/records-api.ts:209-231` (50 pages of relationships).
- `boards/hooks/use-live-widgets.ts:~265-285` (field catalog).
- `sandbox/state/api.ts:587-606` `listAllSandboxVersions` (no limit).
- `boards/components/server-backed-board-groups.tsx:112-130`: one page of 100 with no `has_more` check. Groups after the 100th are silently missing.

Every listed backend endpoint already accepts `limit`, `offset`, and `search`, except these:

- `GET /boards/{id}/post-authors` (`post_author_router.py:39`): capped at 500, no search, and the labels are usernames.
- `GET /audit-logs/options`: capped at 200 entity types and 200 actors, no search.

**Backend:**

1. Add `StandardListRequest` to `post-authors`. Return `display_name` with a fallback to `username`.
2. Add `search` to `audit-logs/options`.
3. Add the department name and module name to each access row in the `GET /groups` response, if the Groups list needs them for a server-paged row. Today `groupRows` joins three complete lists.

**Frontend:**

1. **Lists.** Groups uses server paging with the shared `TablePagination`, like `directoryPageOptions`.
2. **Pickers.** Make one search-as-you-type source for `SearchSelect`, backed by `GET /users?search=` and `GET /member-candidates?search=`. Use it in the People sponsor field, `invite-person-dialog.tsx`, `group-member-picker.tsx`, the security-events person filter, and the Groups member picker.
3. **Resolve by ID.** Keep a by-ID lookup, so a picker still shows the selected person, the sponsor of the selected person, and a deleted person. The search result must carry the "access ended" flag that `memberOptionsFromUsers` uses (`groups-view.tsx:~165-168`).
4. **Overview.** Use `userSummaryOptions` and server filters for the health cards.
5. **Board groups.** Use server search.
6. **Department and module pickers.** Use server search. Keep a by-ID lookup for the selected value.
7. **OpenView and Sandbox loops.** Replace them with "load more" or search where a person picks one item. For the Sandbox version list, page it in History (W6 adds the counts the banner needs).
8. Delete `loadAllAccessPages` when no caller remains.

**Acceptance.** No adapter or hook loops over every page. Every list uses the shared pagination control or a search picker. A picker with a selected value shows the correct label after reload.

### W4. Live updates for Boards and Dashboards (item 11)

**Owner's decision:** lists, feeds, calendars, and dashboards update in place. An open editor keeps the typed text and shows "Changed by someone else — review latest."

#### W4a. Backend event delivery

**Today.**

- Boards: the event hub never emits a Board entity. `event_for_entity` returns `None` for the private set (`events/models.py:126-127`), and `backend/tests/events/test_invalidation.py:298-321` asserts this.
- Dashboards: `dashboards` and `dashboard_widgets` are in no set. By code reading, `_can_receive` (`hub.py:~187-199`) delivers them to administrators only.

**Work (D8):**

1. **Boards: scoped delivery.**
   1. Add `board_ids` to `EventViewer` (`hub.py:49-59`). Fill it at reauthorization from a new reader-set helper next to `board_level` and `visible_board_clause` in `boards/access.py`.
   2. Add a `BOARD_SCOPED_ENTITIES` set in `events/models.py` for `boards`, `board_posts`, `board_events`, and `board_widgets`. The payload is `{entity, board_id}` only. Other Board child tables map to their Board through a resolver in `listeners.py`.
   3. `_can_receive` delivers a Board event only to an administrator or a viewer with that `board_id`.
   4. Add the Board IDs to `_access_signature`, so a membership change causes a resync.
2. **Dashboards: opaque delivery.** Add `dashboards` to the entity-only set that every authenticated person receives, like `departments`. The payload has no ID. The client refetches under its own access.
3. Keep reports in the private set.
4. **Tests.** Rewrite `test_invalidation.py:298-321` for the new rules. Add tests:
   - A Board reader receives the event.
   - A person without Board access does not receive it.
   - A dashboard event reaches a member as an entity-only event.

Pain point: one post save writes several audited rows, which can cause many events. Solution: `publish_invalidations` already removes duplicates in one commit (`publisher.py:19`). The client also waits 300 ms before a refetch (debounce).

#### W4b. Boards frontend

1. Add one shared hook, `shared/adapters/use-invalidation-refresh.ts`. It subscribes by entity and by Board or module ID, and returns a counter. It reuses `subscribeWorkspaceInvalidations` and its last-listener cleanup.
2. Add a `liveKey` for the posts feed and the calendar that is separate from `resource.detail.sequence`. A live event must not reset an open draft.
3. **Post editor.** `resolveEditorRefresh` (`post-editor-state.ts:270-319`) already keeps the draft when the revision changes. Change the notice text to "Changed by someone else — review latest". Show it after a live refresh, not only after a 409.
4. **Event editor.** On a live refresh that shows a newer event revision than the draft, show the same notice. Reuse `prepareBoardEventConflictRetry` and `loadLatestEvent` (`server-backed-board-calendar.tsx:851,870`).
5. Widget data already updates on record events (`use-live-widgets.ts:321-336`). Add `board_widgets` events so a widget change by a manager appears.

#### W4c. Dashboards frontend

1. Convert the dashboard list and detail loads (`server-backed-dashboards.tsx:324-356,433-475`) to TanStack Query. Follow the `query-cache-patterns` skill.
2. Subscribe to `dashboards` events and to `records` events for each widget's module.
3. When the draft is dirty, do not replace it. Show the inline notice with the existing "Discard draft and reload" action (`:1769-1774`).
4. Keep the `refreshCadence` timer. It now refreshes every visible widget, not only the active one.
5. Put new code in new files. `server-backed-dashboards.tsx` is already 2,643 lines.

**Acceptance.** Two browsers as different people: a published post, a changed event, and a changed dashboard appear in the other browser without a reload. An open editor keeps its text and shows the notice. A person without access to a Board receives no event for it.

### W5. Permanent delete and the route bundle (items 12 and 20)

#### W5a. Permanent delete on by default (item 20, D1)

**Today.** `LIFECYCLE_PURGE_ENABLED` is a required setting with no code default (`core/config/settings.py:102,254-260`). `.env.example:85` sets `false`.

**Work:**

1. Set `LIFECYCLE_PURGE_ENABLED=true` in `.env.example`.
2. Keep the setting required in `settings.py`. Existing installations keep their own value. Say this in the release note.
3. Change the test defaults to true: `backend/tests/config_support.py:24` and `backend/tests/fullstack_environment.py:25,39`. The tests for the disabled path inject their settings, so they stay valid.
4. Update root `AGENTS.md:44` and the architecture documents (W1b step 1).
5. Change the disabled-state text "pending retention approval" (`sandbox/lifecycle/router.py:97`) to "Permanent delete is turned off for this installation." Use the same text in `boards/lifecycle_router.py:88`, `platform/files/lifecycle_router.py:47,146`, and `purge.py:83`.

#### W5b. One rule for every permanent delete (D2)

**Today.** Two permanent deletes have weaker checks than the others:

- `DELETE /reports/{id}/permanent` (`openview/reports/router.py:271-298`) needs only archived-first and module manage. It has no admin check, no purge flag, no preview, no password, and no typed confirmation.
- `DELETE /boards/{id}/events/{eid}` (`event_router.py:379-398`) needs only archived-first.

**The rule.** A permanent delete requires all of these:

1. The person is an administrator.
2. `LIFECYCLE_PURGE_ENABLED` is true.
3. The item is archived first.
4. A preview shows what will be deleted.
5. The person enters their password, and types the item's name.

**Work:**

1. Add `purge/preview` and `purge` routes for reports and for Board events. Use the same shape and the same `require_fresh_exact_admin`, preview token, and password check as the Board and file routes.
2. Remove `DELETE /reports/{id}/permanent` and `DELETE /boards/{id}/events/{eid}`. No UI calls them. Tests do: update `frontend/tests/fullstack/sandbox-workspace.spec.ts:429` and `frontend/tests/isolated/contracts/boards-content-contract.spec.ts`, and remove the dead adapter `deleteBoardEvent` (`board-events-api.ts:355`).
3. Show the date of the last successful backup in every purge preview, so the administrator sees the recovery point before confirming.

#### W5c. Purge UI that is missing

1. **Board files.** Board purge needs every Board file purged first (`boards/lifecycle_router.py:150-153`), but no UI can purge a file. Add "Permanently delete" for archived Board files in the Board management sheet, using `files/lifecycle_router.py:109,129`. Without this, Board purge is a dead end.
2. **Reports.** "Permanently delete" on an archived report.
3. **Board events.** "Permanently delete" on an archived event in the archived-events list.

Reuse the existing lifecycle confirm dialog (`sandbox/components/lifecycle-dialog.tsx`, `boards` management purge) for all three.

#### W5d. Route bundle (item 12)

| # | Control | Work |
|---|---|---|
| a | Post pin and expiry | Add a "Pin to top" toggle (shown only to Board managers; the server returns 403 for others) and an "Expires on" date-time field to the post editor. Send `pinned` and `expiresAt` on create and update. **Backend:** pinned posts sort first in the default order (D3). Show an "Expires on" hint, and show expired posts to their authors as "Expired". |
| b | Unpublish | Add "Unpublish" to the post actions. It returns the post to draft and cancels its scheduled work. |
| c | Event delete | Done in W5c. |
| d | Report permanent delete | Done in W5c. |
| e | Invitation reconcile | Add "Finish sending invitation" in Access › People when `status=pending` and `invitation_sent_at` is null. It calls `POST /auth/invitations/{id}/reconcile`. This repairs an invitation whose email failed after the local row was created. |
| f | Sandbox export with history | Add an "Include version history" checkbox to the Sandbox export dialog. Show the version count and the note "Imported versions count toward the 50-version limit." |
| – | Widget `refresh` field | Stop writing it (`use-board-widget-management.ts:54`). Keep accepting it on import, and ignore it (D4). Live updates (W4) replace it. |

**Acceptance.** Each control works through the UI. Every permanent delete follows the rule in W5b. A project Board with files can be purged from the UI.

### W6. Sandbox (item 17)

#### W6a. Relationship lifecycle

**Today.** A published relationship is a `Field` of type `relationship`. The field lifecycle routes accept it by ID (`lifecycle/router.py:52-75`). `GET /sandbox/bindings` returns `kind="relationship"` with the field ID. The frontend ignores it:

- `SandboxLifecycleKind` excludes `relationship` (`state/lifecycle-api.ts:28`).
- `targetPath` maps department, module, and field only (`:46-56`).
- `bindingFor` returns nothing for a link (`designer.tsx:642-657`).
- `relationshipActions` offers only Edit and Delete (`sandbox-inspector-outline.tsx:296-322`).

**Work:**

1. Add `relationship` to `SandboxLifecycleKind`. Map it to `/fields/{live_id}`.
2. Confirm that `assertLifecycleResultFor` in `lib/lifecycle.ts` accepts `target_type=field` for a relationship binding. Fix it if not.
3. Add Close, Reopen, and Permanently delete to the relationship actions in the inspector. Purge uses the W5b rule.
4. Show the preview's impact: the number of record links that the close hides.
5. **Backend test.** Close, reopen, and purge a relationship field through the field routes.

#### W6b. Version cap (D18)

**Today.** The cap is 50 checkpoint and imported versions (`designs/service.py:31,311-322`). Published versions do not count. When the cap is full, Save checkpoint, Restore, Import, and Discard fail with 409 `version_limit`. The UI shows "This item changed. Refresh it and try again" (`lib/api-errors.ts:19-20`), which is wrong.

**Work:**

1. **Backend.** Add `POST /sandbox/versions/prune` with `expectedRevision`. In one transaction, it deletes the oldest checkpoint and imported versions until 40 remain. It never deletes a published version or the newest version. It returns the number deleted.
2. **Backend.** Return `mutable_count` and `limit` with the versions list.
3. **Frontend.** At 45 or more, show a banner in History and in the checkpoint dialog: "N of 50 versions used. Delete the oldest unpublished checkpoints to free space." The button calls prune after a confirm dialog.
4. **Frontend.** Map 409 `version_limit` to "Version history is full. Delete old checkpoints in History."

#### W6c. Delete text

Change `helpers/designer-impacts.ts:121-185`. For an item that is bound to a live item, say: "On publish, the live item closes. Its data is kept." Keep the current text for items that are not published.

**Acceptance.** A relationship can be closed, reopened, and purged from the inspector. The banner appears at 45. Prune frees space without touching published versions.

### W7. Profile page and person card (item 13)

**Owner's decision:** a dedicated profile page with four sections. Other people see a read-only card.

**Today.**

- Platform › Account has a theme select, the password form, and device sessions (`platform/components/account.tsx:254,281`).
- Settings › Appearance has color mode, motion, shortcuts (account), and text size and density (device).
- The `users` table has `email`, `username`, `display_name`, `job_title`, `theme_preference`, and `appearance` JSONB (`access/users/models.py:66-106`). It has no phone, bio, avatar, timezone, date format, or start page.
- `ck_users_appearance` (`models.py:51-59`) allows only the keys `motion` and `keyboard_shortcuts`.
- No self-service profile edit exists. `PATCH /users/{id}` is admin-only (`account_operations.py:202`).
- MFA enrollment exists only in Access › Security (admin) and the forced gate (`app-page.tsx:154-174`). A member who is not forced cannot enroll.
- The backend has no email-change support. Many paths require the local email to equal the provider email (`provider_actions.py:180,263,352`, `admin_recovery.py:69`, `security_recovery.py:78,190`, `users/security.py:145,205`, `invitation_provider.py:14`, `users/service.py:227`).

#### Page structure

Route: `/profile` (D13). `/settings/appearance` and `/platform?section=account` redirect to it. The header menu item "Account settings" becomes "Your profile".

| Section | Fields | Storage |
|---|---|---|
| Identity | Photo, display name, job title, phone, short bio (max 280 characters) | Account (new columns and the avatar file) |
| Sign-in & security | Email (change with confirmation), password, MFA enrollment and removal, active sessions | Provider and existing routes |
| Look & behavior | Color mode, reduce motion, keyboard shortcuts, start page after sign-in; text size and page density | Account; text size and density stay per device (Tier 1 D6) |
| Regional | Timezone, date format, time format (12 or 24 hour), first day of the week. Each has "Use organization default". | Account (`appearance` JSONB) |

#### Rules for personal regional settings (D14)

Personal regional settings change **display only**. They never change:

- Record windowing, aggregation buckets, and the workspace `today` (`records/windowing.py`, `records/aggregation.py`, `workspace/schemas.py:169-170`).
- Report run snapshots, which freeze text in the workspace timezone (`openview/reports/run_service.py:250,264`).
- Backup schedules, trigger timezones frozen at publish, and Board event timezones.
- Export cell text (W9 uses the workspace timezone and states it in the file).

Consequence: a record time can show 23:30 in the person's timezone and still sit in the next workspace day on the calendar. Label every surface that groups by workspace day with "Workspace timezone: …". `live-calendar.tsx:406` and `live-timeline.tsx:196` already do this. A personal first day of the week changes only where the calendar grid starts. Chart week buckets use the workspace setting.

#### W7a. Backend

1. **Migration:**
   - Add `users.phone` (`String(32)`, nullable) and `users.bio` (`String(280)`, nullable).
   - Widen `ck_users_appearance` to allow `start_page`, `timezone`, `date_format`, `time_format`, and `week_start`.
   - Add `user_avatar` to `ck_files_purpose_parent`, and add `users.avatar_file_id` (FK to `files`, nullable, `SET NULL`).
2. **Schemas.** Extend `AppearancePreferences` and `AppearancePreferencesUpdate` (`users/schemas.py:70-96`) with strict values:
   - `timezone`: an IANA name or null.
   - `date_format`: `organization`, `dmy`, `mdy`, or `ymd`.
   - `time_format`: `organization`, `12h`, or `24h`.
   - `week_start`: `organization`, `monday`, or `sunday`.
   - `start_page`: `automatic` or a workspace route key.
3. **Profile route and private self read (D27).** Add `PATCH /auth/me/profile` for `display_name`, `job_title`, `phone`, `bio`, and `avatar_file_id`. It is limited to the caller's own account and audited for actual edits. Extend only `AuthMeResponse` on existing `GET /auth/me` with nullable `phone`, `bio`, and `avatar_file_id`, so members and guests can reload their own values without shared access. Keep directory, candidate, and other-person response shapes unchanged; the Profile page reads private self values from this route, not a person card or an empty mutation.
4. **Avatar.** Model it on `workspace_logo`: PNG or JPEG, 2 MiB or less, `GET /users/{id}/avatar`, and purge of the old file after a replacement. The authenticated caller may read their own avatar without shared access; a different person requires the same visibility rule as their person card. Preserve private storage and file type, ownership, and readiness safeguards. Update `files/access.py:52` and `files/quota.py:33,41`.
5. **Person card.** Add `GET /users/{id}/card`. It returns `display_name`, `job_title`, and the avatar URL. For members and admins it also returns `email`, `phone`, and `bio`. A guest viewer gets name, photo, and title only. The caller must already be able to see the person: the person shares a module, a Board, or a group with the caller, or the caller is an administrator. Return 404 otherwise.
6. **MFA for everyone.** The `/auth/mfa*` routes already serve the caller. Confirm a member who is not forced can enroll and remove a factor.

#### W7b. Frontend page

1. Build `/profile` with the four sections. Reuse the existing Appearance cards and the Account panels; do not rebuild them.
2. Keep a live preview card for Look & behavior.
3. Update `workspace-navigation.ts`, the sidebar footer link, the header menu, and `app-breadcrumbs.tsx`.
4. **Formatting.** Add the personal settings to the date helpers in `lib/date-time.ts:70-113`. The rule: personal value first, then the organization value. Route the bypasses through the helpers: `mfa-flow.tsx:321`, `security-panel.tsx:145`, `access/helpers/people.ts:384,392`, `report-run-panels.tsx:96`, `security-events-view.tsx:171-181`, `account.tsx:107-113`, and `audit.tsx:~320`.
5. **Start page.** `workspaceStartRoute()` (`components/workspace-start.ts`) uses `start_page` when it is set and the person can open that page. Otherwise it keeps the current logic.
6. Update `lib/user-theme-preferences.ts` and `lib/appearance-preferences.ts` for the new keys.

#### W7c. Person card

1. Build one `PersonCard` popover. It opens from a person's name.
2. Attach it in Access › People, post authors, record assignees and user fields in OpenView, Board event authors, and Platform search results.
3. Change post author labels from username to display name (`post_author_router.py:77-79`, `server-board-post-feed-display.tsx:328,447`).

#### W7d. Email change (last slice of W7)

1. At the start of the slice, check the current Supabase Auth email-change behavior with Context7. Use secure email change: the provider sends a confirmation to the new address and to the current address.
2. **Backend.** Add `request_email_change` to `SupabaseAuthClient` (`core/integrations/supabase_auth.py`). Add `POST /auth/me/email` with the current password. Add an email-change template and its environment variables to the Supabase compose files and `.env.example`, like the invite and recovery templates (`infra/supabase/compose.yaml:81-84`).
3. **Frontend.** Add a landing page under `/auth/` for the confirmation link.
4. **Local email update.** Update `users.email` only after the provider confirms the change, during the next session admission that sees the new provider email. Review each equality check in the list above, so a confirmed change does not lock the person out.
5. Record a security event for the request and for the confirmation.

Pain point: this slice touches sign-in invariants in eight places. Solution: do it last in W7, cover each invariant with a test, and block the slice instead of weakening a check.

**Acceptance.** A member edits identity, look, and regional settings without admin help. A member enrolls MFA from the profile. The card shows the right fields for a member and for a guest. An email change completes and the person can sign in with the new address.

### W8. Security events in Manage › Audit (item 14)

**Today.** `SecurityEventsView` (`access/components/security-events-view.tsx`, 1,171 lines) is a table in Access › Security (`security-view.tsx:821`). It labels 8 event types (`:79-88`). Every other type shows "Other security event". The person filter loads every user.

**Work:**

1. Add a "Security events" tab to Manage › Audit (`manage/components/audit.tsx`, `manage/page.tsx:93,168`). Show the tab to administrators only. Department managers also see Audit, and `GET /security-events` is admin-only.
2. Remove the card from Access › Security. Put a link "View security events in Audit" in its place.
3. **Sentence list.** Replace the table rows with one sentence per event. Add a pure helper `securityEventSentence(event, names)` with one template per event type. Examples:
   - "Jay signed in from 10.0.0.4."
   - "3 failed sign-ins for jay@example.com from 10.0.0.4."
   - "Ana exported 120 records from Students as Excel."
   - "Mark reset MFA for Jay."
4. Write a template for every emitted type. The unlabeled types today include `identity.mfa.*`, `identity.session_revocation`, `identity.local_admin_recovery`, `identity.local_security_recovery`, `user.invitation*`, `file.download`, `records.export.authorized`, `records.aggregate_snapshot.authorized`, `lifecycle.record_purge`, `backup.export.download`, and `security.retention`. Add the types that Tier 2 creates (export, purge, retry, profile, email change).
5. Use the W3 search picker for the person filter.
6. Keep the outcome badge, the time, and the Details dialog. Keep the shared pagination.
7. Rewire the four props that `security-view.tsx` passes today (`active`, `admitted`, `pending`, `onReadChange`) to the Audit host.

**Acceptance.** Every event type that the backend emits has a sentence. No row shows "Other security event" for a known type. A department manager does not see the tab.

### W9. Export from OpenView (item 15)

**Owner's decisions:**

- An Export action is in the OpenView Views toolbar.
- Any person who can read the module can export.
- The file contains exactly what the current view and filters show.
- Every export is recorded.
- The formats are CSV and Excel.
- The Excel file always has a styled header, a frozen first row, filter buttons, fitted column widths, and typed cells.
- Options: a title and details row, columns and their order, an accent color, banded rows, and a totals row.

#### W9a. Backend

1. Add `XlsxWriter` to `backend/pyproject.toml` and `uv.lock`. It has no runtime dependencies.
2. **Request.** Extend `/records/export` with `ExportRequest(RecordQuery)`:

| Field | Values | Default |
|---|---|---|
| `format` | `csv`, `xlsx` | `csv` |
| `view_id` | saved view ID or null | null |
| `title` | text up to 120 characters, or null | null |
| `include_details` | bool | true |
| `include_record_id` | bool | false |
| `accent` | `theme`, `gray`, `none` | `theme` |
| `banded` | bool | false |
| `totals` | bool | false |

   The column order is the order of `definition.columns`.
3. **Access.** Replace `Admin` (`query_router.py:47-48`) with `Reader` and `Identity`. Replace `require_fresh_exact_admin` with `require_fresh_module_access(..., AccessLevel.READ)`, like `aggregate-snapshot` (`:94-100`). Update the two tests that assert 403 for members: `backend/tests/access/test_read_paths_integration.py:171-175` and `backend/tests/record_queries/test_export_snapshot_integration.py:22-28`. Mark decision D9 in `docs/plans/schema-redesign-plan.md:50` as replaced.
4. **Generator.** Create `records/export_xlsx.py`. Keep `export_snapshot` for the query and the caps (10,000 rows, 8 MiB). Add a typed cell function next to `format_cell`. Do not change `format_cell`, because Reports import it (`openview/reports/run_service.py:21-26`).
5. **Cell types:**

| Field type | Excel cell |
|---|---|
| `number`, `int` | Number. Format `0` for integers. |
| `decimal` | Number when the value survives a round trip through a float. Text otherwise. |
| `date` | Date with a date format |
| `datetime` | Date and time in the workspace timezone. The header says the timezone. |
| `boolean` | Boolean |
| `select`, `user` | Text label |
| `text`, `long_text`, `email`, `url` | Text. Wrap `long_text`. |

   Relationship fields cannot be columns today (`query_schemas.py:37-41`). Keep that limit.
6. **Formula safety.** Write every text cell with `write_string`. Set `strings_to_formulas` and `strings_to_urls` to false in the workbook options. Keep `safe_text` for CSV only, because a `'` prefix shows as a character in Excel.
7. **Title and details.** Build them on the server from trusted values: the person's name, the time in the workspace timezone, the module name, the view name (loaded through `view_id` with an access check), and a filter summary from the validated definition. Do not trust text from the client except `title`.
8. **Accent color.** Add a constant map from the theme ID to the light-mode `--action` hex: slate `#2563eb`, whiteboard `#1d5fb8`, triplicate `#1f4fbf`, stockroom `#1d5ac4`. Add a test that reads `frontend/src/app/globals.css` and `frontend/src/app/themes/*.css` and fails when a value differs. `gray` uses a neutral header. `none` uses bold text only. Header text is white on the accent; all four values pass AA.
9. **Totals.** Use `SUBTOTAL(109, …)` formulas, so the filter buttons change the total. Write the computed value as the cached result.
10. **Filename.** Use `<module>-<view or "records">-<YYYY-MM-DD>.<ext>`, made safe for file systems.
11. **Record.** Write the security event `records.export.authorized` when the response is built, not at a preview step. Store `{format, row_count, column_count, filter_count, view_id}`. Store field IDs and operators, never filter values; the metadata limit is 4096 bytes.

#### W9b. Frontend

1. Add an "Export" button to the Views action row (`server-backed-views-workspace.tsx:2788-2826`). Show it to every reader.
2. Build `ExportDialog`:
   - Format: CSV or Excel.
   - Columns: the current visible columns in table order, pinned first (`tableFields`, `:1013-1035`). The person can remove and reorder them.
   - Excel only: title, the details row, accent color, banded rows, and the totals row.
   - "Include record ID (for re-import)", off by default.
   - A short note: "Exports up to 10,000 rows. Your export is recorded."
3. Build `definition.columns` from the chosen columns, not from the draft definition, which can hold up to 100 queried columns. Reuse `serializeOpenViewQueryDefinition`.
4. **Platform › Import & export** stays admin-only for import. Its export calls the same route with `include_record_id: true`, because the import contract requires `Record ID` as the first column (`record-import-api.ts:190-199`). Update `frontend/tests/http/platform-refactor-journeys.spec.ts:492-514,758-856`.
5. Add the sentence for the export event (W8).

**Acceptance.** A member with read access exports CSV and Excel from a filtered view. The file has the same rows and columns as the view. The Excel file opens with the styled header, frozen row, filters, and correct types. A text value that starts with `=` stays text. A guest without access to the module gets 404.

### W10. Drag to edit (item 16)

**Owner's decisions:**

- Moves collect as a pending batch. A pending card is dimmed, and "Save changes" shows the count.
- "Save changes" saves the batch.
- When one move conflicts, the other moves save. The conflicting card shows "Changed by someone else — review".
- The navigation guard protects unsaved moves.

**Today.**

- The Kanban shows lane buttons and the cards of one selected lane only (`live-kanban.tsx:74-156,355-384`).
- Calendar day cells are not drop targets (`live-calendar.tsx:810`).
- Timeline bars are read-only images (`live-timeline.tsx:437-460`).
- No batch route exists. `PATCH /records/{id}` replaces all active values (`mutation_validation.py:205-207`) and returns 412 on a stale `If-Match`.
- The navigation guard has one slot (`workspace-navigation-guard.tsx:22-63`).
- No drag-and-drop library is installed.

#### W10a. Batch update route (D10)

1. Add `POST /records/batch-update`, with the outer body `{module_id, items}` and at most 100 items. Preserve the existing `{record_id, revision, field_id, value}` item for single-field callers. S19 adds an opt-in `{record_id, revision, changes: [{field_id, value}]}` item containing one or two distinct field changes for the same record; reject empty, oversized, duplicate-field, or mixed forms. Both forms retain one original revision and one item result.
2. For each item, in its own savepoint:
   1. Load the record with write access.
   2. Check the revision. A mismatch returns `stale` for that item.
   3. Merge only the explicit field change or changes into the stored data on the server. An opt-in multi-field item combines both changes before validation and keeps them in the same item savepoint. A failure changes neither field. The client never sends the full record.
   4. Validate the combined result with `validate_record_mutation`.
   5. Save once, enqueue the record event, and notify assignments, as PATCH does.
3. Return one result per item: `updated` with the new record, `stale`, `invalid` with the field error, or `forbidden`.
4. A failed item never rolls back another item.
5. Review the contract with the `fastapi-api-design` skill. Regenerate `contracts/openapi.json`.
6. **Tests:** partial success, a stale item, a required field set to empty, and a user field whose assigned user lost access. That last case fails today for any save of the record, so report it per item.

#### W10b. Frontend foundation

1. Add `@dnd-kit/core`. It has pointer, touch, and keyboard sensors, and screen-reader announcements.
2. Lift the pending moves into `server-backed-views-workspace.tsx`, keyed by record ID with the original record and revision. Preserve the single-field form for Kanban, Calendar, and Timeline end-only resize. S19 retains a Timeline start/end shift as one move with two explicit changes, one original revision, and one Save count. Kanban, Calendar, and Timeline receive this state as a prop; filter changes remount these components, so it must live above them.
3. Add "Save changes (N)" and "Discard" to the toolbar when moves are pending.
4. **Guard.** Extend the existing views guard (`:1474-1489`) and `confirmDraftDiscard` (`:1491-1501`) to include pending moves. Do not register a second guard. The dialog text names the kind of unsaved work: "You have 3 unsaved moves."
5. Add a `beforeunload` handler while moves are pending, like `server-backed-boards.tsx:484`.
6. Show drag controls only when `canWriteRecords` is true. Handle 403 by refreshing access.
7. **Non-drag path (WCAG 2.5.7).** Each card has a "Move to…" menu: a lane list for Kanban, a date picker for Calendar, and start and end pickers for Timeline.

#### W10c. Kanban

1. Show every lane as a drop target. For a `select` lane field, list all options from the field configuration (`domain/record-form.ts:27-45`), including options with no records.
2. Allow drags only when the lane field is `select`, `user`, or `boolean` (D11). For other lane types, hide the drag controls.
3. A drop on "Unspecified" sets null. A required field rejects this on save, and the card shows the error.

#### W10d. Calendar and Timeline

1. **Calendar.** Day cells are drop targets. For a `date` field, set the new date. For a `datetime` field, keep the time of day in the workspace timezone and convert to UTC. Undated records in the side list can be dropped onto a day.
2. **Timeline.** Make the bar interactive. Moving it shifts start and end by the same number of days and saves both atomically through the opt-in batch item in D10; never use sequential writes, duplicate record items, or full-record PATCH as a workaround. A handle on the end resizes the end only through the existing single-field form. The keyboard path uses the "Move to…" menu. Preserve the existing navigation guard, partial-failure UI, uncertain-result read refresh, and no automatic write retry.

#### W10e. Results

- A `stale` item keeps its card highlighted with "Changed by someone else — review". The review action opens the record inspector with the latest data.
- An `invalid` item shows the field error on the card.
- Announce the result in an `aria-live` region: "Saved 4 moves. 1 move needs review."

**Acceptance.** Kanban, Calendar, and Timeline accept drag and keyboard moves. Nothing saves before "Save changes". A conflict saves the other moves and flags one card. A record's other field values do not change.

### W11. Jobs status (item 18)

**Owner's decision:** one generic table in Manage › Jobs, and the last run on each report schedule. New job types plug in.

**Today.**

- `scheduled_work` (`platform/scheduling/models.py:40-133`) holds report runs, post publishing, and event reminders. It records state, attempts, the next attempt, and a failure code. It has no error text.
- Retries are automatic: 5 attempts with backoff (`service.py:35-37`). No manual retry exists.
- Only report failures create a notification. Post and reminder failures are silent.
- `backup_runs` (`manage/backups/models.py:53-156`) records backups. The Backup panel shows them.
- No route exposes `scheduled_work`. `ScheduleResponse` has `next_due_at` only.

#### W11a. Backend

1. **Registry.** Add `manage/jobs/registry.py`. Each job kind registers:
   - a label,
   - a query that returns rows in one shape,
   - a subject resolver (report name, post title, event title, backup name),
   - a retry function, or none.
2. **Version 1 kinds:** `report-run`, `post-publish`, `event-reminder` (from `scheduled_work`), and `backup` (from `backup_runs`). Record triggers and provider sign-out can register later without a schema change.
3. **Row shape:** `{kind, id, subject_label, subject_link, state, scheduled_for, last_attempt_at, next_attempt_at, attempts, failure_code, failure_label, can_retry}`.
4. **Routes:**
   - `GET /jobs`: admin only, `StandardListRequest`, filters for kind, state, and date.
   - `POST /jobs/{kind}/{id}/retry`: admin only, with `require_fresh_exact_admin`.
5. **Retry rules (D16):**
   - For a failed `scheduled_work` row: set `state='pending'`, `attempt_count=0`, `next_attempt_at=now`, and clear the lease. This reuses the row, because a report occurrence is unique on `(report_id, scheduled_for)`. A manual retry starts a new set of 5 attempts on purpose.
   - For a failed backup: queue a new manual run with a new idempotency key.
   - A row canceled with `source_unavailable` has no retry.
   - Record a security event `job.retry`. `scheduled_work` has no audit (`__audit_enabled__ = False`).
6. **Schedule.** Add `last_run: {state, finished_at, failure_label} | null` to `ScheduleResponse` (`schedule_schemas.py:88-104`).
7. **Failure labels.** Map each failure code to plain text in one place. Optional migration: add `scheduled_work.failure_detail` (`String(500)`) for a safe error summary. Never store exception text that can hold private data.

#### W11b. Frontend

1. Add a "Jobs" item to Manage (`workspace-navigation.ts`). Show it to administrators only.
2. The table has these columns: Job, Subject (linked), State badge, Last attempt, Next run, Attempts, and Problem. It has a Retry button and the shared pagination.
3. Filter by kind and state. A failed job shows first by default.
4. Show the last run under "Next due" in the report schedule controls (`report-schedule-controls.tsx:359-364`).
5. Link "View all backups" from a backup row to the Backup panel.

**Acceptance.** An administrator sees failed report, post, reminder, and backup jobs in one list, and retries them. A new job kind needs only one registry entry.

### W12. Analytics (items 9 and 10)

**Owner's decisions:**

- A full widget editor for Boards and Dashboards.
- Saved charts are objects that dashboards and Boards reference.
- A chart is visible to anyone who can read its module.
- New metrics: min, max, and distinct count.
- New date buckets: week, month, quarter, and year.
- Dashboards use a responsive grid with S, M, and L sizes.
- No cross-relationship aggregation and no pivot tables in Tier 2.

#### How aggregation works on modules

Each record stores its values in one JSONB column, keyed by field ID. Each field has a declared type. `field_expression` (`records/query.py:160-177`) casts the JSON value by that type: numeric types to `numeric`, `date` to `date`, `datetime` to `timestamptz` (read as UTC when no zone is present), and other types stay text. Aggregation then uses normal SQL on the cast expression. A new metric or bucket is a new SQL expression over the same cast. It needs no schema change.

Pain point: aggregating JSONB gets slower as a module grows, because only `ix_records_module_id` exists. Solution: keep the bucket and byte caps. Add an expression index only for a measured slow query (`docs/architecture/18-observability.md:98-104`).

#### W12a. Aggregation backend

1. **Metrics.** Widen `aggregation` (`query_schemas.py:228`) to `count | sum | average | min | max | distinct`. Validate the measure by metric:
   - `sum` and `average`: numeric.
   - `min` and `max`: numeric only (D26). Temporal min and max are deferred to section 10.
   - `distinct`: any field type except relationship.
2. **SQL** (`aggregation.py:53-61`). Use `min`, `max`, and `count(distinct …)`. Do not wrap `min` and `max` in `coalesce(…, 0)`. Order with `NULLS LAST`.
3. **Buckets.** Add `bucket: day | week | month | quarter | year` (default `day`) to `DateSeriesAggregateQuery`. Use `date_trunc` on the timezone-converted date. Week buckets follow the workspace `week_start`. `date_trunc` starts weeks on Monday, so Sunday needs a one-day offset.
4. **Caps.** Replace the 366-day window rule with a rule of at most 366 buckets. Keep the 10,000-bucket and 8 MiB snapshot caps. Remove `le=366` from `AggregatePaginationMetadata.limit` where the bucket rule replaces it.
5. **Empty buckets.** Make `AggregateDatum.value` nullable. Fill empty buckets with 0 for `count`, `sum`, and `distinct`, and with null for `average`, `min`, and `max`. Show null as "—" in tables and summary cards, as a gap in line charts, and as no bar in bar charts. An export cell for null is empty. Renderers must not convert null to 0 (D26).
6. **Batch snapshot.** Add `POST /records/aggregate-snapshots` with up to 12 queries. It uses one connection, checks access per query, and writes one security event. The dashboard grid uses it. Without it, a grid of 12 widgets writes 12 events and opens 12 connections on every refresh.
7. **Compatibility.** Every new field has a default, so stored widget configurations still validate with `extra="forbid"`.
8. **Frontend enums.** Update `analytics-api.ts:179,378`, `dashboards-api.ts:150,196,293,611,735,761`, `chart-query.ts:7,86`, and the 366-day checks in `server-backed-dashboards.tsx:170,231`.

#### W12b. Saved charts backend

1. **Package.** Add `openview/charts/` with models, schemas, and a router that mirror `openview/dashboards/`.
2. **Table `charts`:**
   - `id`, `department_id`, `module_id`, `name` (max 120), `chart_type` (`bar`, `line`, `pie`, `summary`, `workload`, `records`), `query` (JSONB, the existing snapshot or records query), `revision`, `is_deleted`, and the audit columns.
3. **Access (D6).** A person who can read the module can list and read the chart. A person with manage on the department can create, edit, archive, and restore it, like dashboards.
4. **Routes.** List (with search and paging), read, create, update with `revision`, archive, restore, and `GET /charts/{id}/usage`, which lists the dashboards and Boards that use it.
5. **References.**
   - Add `dashboard_widgets.chart_id` and `board_widgets.chart_id` (FK `RESTRICT`, nullable).
   - A widget has either an inline configuration or a `chart_id`, never both. Add a CHECK constraint.
   - Archiving a chart that is in use returns 409 with the usage list. The UI shows "Used in N places" and the list.
6. **Lifecycle.** Add charts to the department and module dependency checks (`sandbox/lifecycle/dashboard_dependencies.py`, `board_widget_dependencies.py`, `lifecycle/execution.py`, `department_ancestry.py`). A module purge must find chart references.
7. **Board export.** On export, write a chart-backed widget as an inline widget (`boards/portability_router.py:166-290`). A chart ID is not stable across installations.
8. **View-time access.** A Board widget that uses a chart still checks module read for each viewer. A Board reader without module read sees "You do not have access to this data."

#### W12c. Widget size and layout migration (D7)

1. Add `dashboard_widgets.size` with the values `S`, `M`, and `L` (default `M`).
2. Change Board widget size from `half | full` to `S | M | L`. The migration maps `half` to `M` and `full` to `L`. Board import accepts the old values and maps them the same way.
3. `_replace_widgets` (`dashboards/router.py:170-214`) compares `size` and `chart_id` as well as type and configuration.

#### W12d. Shared chart editor

1. Create `openview/components/chart-editor/` as one editor. Start from `ChartDefinitionForm` (`chart-definition-form.tsx:36-96`) and `chart-filter-controls.tsx`.
2. **Props:** the widget kind (`chart`, `workload`, `summary`, or `records`), the data-source catalog, and `value` and `onChange` of one normalized definition from `openview/domain/chart-query.ts`.
3. **The editor covers:**
   - the data source,
   - the chart type,
   - the dimension (group by),
   - the metric and measure field,
   - the date field, window, and bucket,
   - up to 10 filters,
   - top N,
   - a live preview.
4. Add a "Use a saved chart" picker. A widget can hold an inline definition or a saved chart.
5. Align the categorical field type lists. `chart-query.ts:19-27` includes `user`; `live-widget-query.ts:44-51` omits `user` and includes `boolean`. Use one list with both.
6. The Charts page, the Dashboard widget dialog, and the Board widget dialog all use this editor.

#### W12e. Charts page

1. Add "Save chart" and "Save as" to the Charts page. A saved chart has a name and lives in the module's department.
2. Add a saved-charts list with search, archive, restore, and the usage list.
3. Keep URL state for the open chart (`?chart=<id>`).
4. Remove the note "Chart settings are not saved" (`server-backed-charts.tsx:149`).

#### W12f. Dashboard grid and widget edit

1. Replace the one-widget selector (`server-backed-dashboards.tsx:1900-2065`) with a responsive grid:
   - L spans the full row. M spans half. S spans a third.
   - Below 768 px, every widget spans the full row.
2. Each tile loads through the batch snapshot route.
3. Order stays the stored `position`. Move with "Move earlier" and "Move later" in the tile menu. Drag is not required.
4. Add "Edit widget" to each tile. It opens the shared editor with the widget's definition. Changes go into the dashboard draft and save with the dashboard revision.
5. Add "Add from saved chart".
6. Put the grid and editor in new files.

#### W12g. Board widget editor

1. Replace the summary-only create (`use-board-widget-management.ts:38-58`) and the name-size-pin edit with the shared editor. Every widget type can be created and fully edited.
2. Map the Board configuration (`fields`, `filters`, `metric`, `visualization`) to and from the normalized definition. Add an explicit aggregation field to `BoardWidgetConfig`, so the frontend no longer infers count from `metric === null`.
3. Replace the hand-built Board charts (`server-backed-board-widgets.tsx:150-420`) with `OpenViewChartPreview`, so one renderer draws every chart.

**Acceptance.**

- A saved chart appears on a dashboard and on a Board. One edit updates both.
- A member without module read sees the access message, not the data.
- Min, max, distinct count, and every bucket return correct values in tests against PostgreSQL. Week buckets follow the workspace setting.
- A dashboard shows all its widgets at 1440 px and 390 px.
- Every widget type can be created and edited on Boards and on Dashboards.

## 6. Migrations

Tier 2 adds these Alembic revisions on the head `dfa5340b47ba`. Add one revision per slice, in the slice's own commit.

| Slice | Change |
|---|---|
| S06 | None (version prune uses existing tables) |
| S08 | None (list filters and lookups use existing columns) |
| S13 | `scheduled_work.last_attempt_started_at` and `scheduled_work.finished_at` (D24); optional `scheduled_work.failure_detail` |
| S20 | `users.phone`, `users.bio`, `users.avatar_file_id`; widen `ck_users_appearance`; `user_avatar` in `ck_files_purpose_parent` |
| S24 | Email-change state, only if the provider flow needs a local pending column |
| S26 | `charts` table; `dashboard_widgets.chart_id` and `size`; `board_widgets.chart_id`; Board widget size `half/full` → `M/L`; inline-or-chart CHECK constraints |

Edit CHECK constraints by hand. Alembic does not compare them.

Each route change also needs these updates:

- Regenerate `contracts/openapi.json`.
- Update `frontend/api-route-manifest.json`.
- Update the contract fixtures.

## 7. Decisions

The owner answered the Tier 2 questions on 2026-10-08. Rows marked "Owner" are the owner's answers. Rows marked "Default" are recommended values from the traces. To change one, edit this table before the affected slice starts.

| ID | Decision | Accepted value | Source | Slice |
|---|---|---|---|---|
| D1 | Permanent delete default | On for new installations (`.env.example`, test defaults). The setting stays required, and existing installations keep their value. Replaces Tier 1 D4. | Owner | S03 |
| D2 | Safeguards for every permanent delete | Admin only, purge flag, archived first, preview, password, typed name. Report and event deletes move to this rule. | Owner + Default | S03 |
| D3 | Meaning of "pinned post" | Pinned posts sort first in the default order and keep the badge | Default | S05 |
| D4 | Board widget `refresh` field | Stop writing it. Accept and ignore it on import. | Default | S05 |
| D5 | Analytics scope | Full editors, saved charts, min/max/distinct, week to year buckets. No pivot tables and no cross-relationship aggregation. | Owner | S25–S30 |
| D6 | Chart and dashboard visibility | Follows module read access. No new sharing model. | Owner | S26 |
| D7 | Widget sizes | S, M, L for both Dashboards and Boards. Board `half` → M, `full` → L. | Owner + Default | S26 |
| D8 | Live-update delivery | Boards: scoped to Board readers (`board_ids` on `EventViewer`). Dashboards: opaque entity-only event to all authenticated people. | Default | S10 |
| D9 | Live-update behavior | Lists update in place. Open editors keep the text and show "Changed by someone else — review latest". | Owner | S11, S12 |
| D10 | Drag-edit save path | Existing `POST /records/batch-update`, at most 100 items, one revision check/savepoint/result per item. Preserve single-field callers; S19 adds an opt-in form with up to two explicit distinct field changes merged and validated atomically. A failed item changes neither field; other items may succeed. Keep authorization, outer transaction, audit/event/assignment behavior and existing bounds. No new endpoint or full-record replacement. | Default; atomic Timeline extension approved by owner on 2026-10-09 | S17, S19 |
| D11 | Drag-edit scope | Batch, then Save. Partial success with per-card conflict flags. Kanban lanes for `select`, `user`, `boolean` only. Timeline move and end resize. `@dnd-kit/core`. "Move to…" menu as the non-drag path. | Owner + Default | S17–S19 |
| D12 | Export access and formats | Any module reader. CSV and Excel through XlsxWriter. Record each export. Options: title and details, columns, accent, banded rows, totals, record ID (off). | Owner + Default | S15, S16 |
| D13 | Profile route | `/profile`. Account and Appearance redirect to it. | Default | S21 |
| D14 | Personal regional settings | Display only. They never change windowing, aggregation, `today`, report snapshots, triggers, backups, or exports. Replaces the Tier 1 W2b "do not add" line. | Owner + Default | S20, S21 |
| D15 | Person card content | Name, photo, title for everyone. Email, phone, bio for members and admins. No department (no source column). | Owner + Default | S22 |
| D16 | Job retry | Admin only. Resets the failed row for `scheduled_work`; queues a new run for backups. A manual retry starts a new set of 5 attempts. No retry for `source_unavailable`. | Default | S13 |
| D17 | Security events location | Manage › Audit, admin-only tab. Access › Security links to it. Replaces the Tier 1 location. | Owner | S09 |
| D18 | Version cap | Banner at 45. Prune deletes the oldest checkpoint and imported versions down to 40, never published versions. | Owner + Default | S06 |
| D19 | Stale documents vs `docs/AGENTS.md:5` | Rewrite each document as current state and remaining gaps. Collapse the seven reviews into `docs/reviews/known-gaps.md` and delete the originals. | Default. This departs from the owner's answer ("update them all"), because `docs/AGENTS.md:5` forbids dated review findings in documents. | S31 |
| D20 | Sample run coverage | Extend the Harbor Small and School Small runs to call the new routes through the same APIs as the UI | Default | S32 |
| D21 | When sample executors are written | In the same slice that adds a frontend-called route. `test_frontend_route_coverage.py:38-48` requires an executor and a `SEEDER_ROUTES` entry for every frontend operation, and `DEFERRED_ROUTES` must stay empty. S32 only runs the live Small profiles. | Default (amendment) | every route slice |
| D22 | Backend extensions for S08 paging | `GET /access/groups`: filters `without_access`, `without_members`, and optional UUID `member_id`; sort `member_count`; search also matches department and module names. `member_id` narrows the existing visible group set without changing permissions or the paged response. `GET /users` (admin) and `GET /member-candidates` (manager): an `ids` filter with at most 100 IDs. Admin `GET /users?ids=` also returns deleted people with their `deleted` state. `MemberCandidateResponse` adds `access_ends_at`. `GET /boards/{board_id}/post-authors`: an optional `ids` filter with at most 100 UUIDs, intersected with the existing Board-visible published-author query and account eligibility rules, including existing publication-expiry exceptions; permissions and the paged response stay unchanged. Use it for known visible/selected post authors, independently of the picker search page. `GET /sandbox/versions`: `search` (label and note) and `kind` filters. Overview counts read the filtered `total` with `limit=1`. A manager whose selected member is not returned sees "Former member". | Default (amendment); membership and author ID filters explicitly approved by owner on 2026-10-08 | S08 |
| D23 | Dashboard refresh cadence | The interval counts from the end of the previous fetch. It pauses while the page is hidden and while the draft is dirty. On return, it refreshes once at once if a full interval passed. Use TanStack Query `refetchInterval` with `refetchIntervalInBackground: false`, not a custom timer. Change the read-count expectations in the cadence test to match this definition; this defines the behavior and does not weaken the test. S12 gets a new budget of three fixes. | Default (amendment) | S12 |
| D24 | Job timestamps | Add nullable `scheduled_work.last_attempt_started_at` (set when a worker claims the row) and `scheduled_work.finished_at` (set on success, failure, or cancel). Existing rows stay null and show "Not recorded". A manual retry clears `finished_at` and keeps `last_attempt_started_at`. Backups use `backup_runs.started_at` and `finished_at`. `last_run.finished_at` on a schedule reads `finished_at`. | Default (amendment) | S13 |
| D25 | Export with no columns | Return 422 `export_no_columns` when no column remains after `include_record_id`. The export dialog requires at least one column. | Default (amendment) | S15, S16 |
| D26 | Temporal min and max | Deferred to after Tier 2. In Tier 2, `min` and `max` take numeric fields only. Null display is defined in W12a step 5. | Default (amendment); reduces D5 | S25 |
| D27 | Private self-profile read and own avatar | Extend only existing `GET /auth/me` / `AuthMeResponse` with nullable `phone`, `bio`, and `avatar_file_id`. Permit authenticated own-avatar reads without shared access. Preserve other-person card/avatar visibility, guest field omission, directory/candidate payloads, private storage and file safeguards. Self-only profile edits remain audited and reload through `GET /auth/me`. | Owner approved on 2026-10-09 | S20, S21 |

## 8. Possible bugs found during the traces

Test each one first, then fix it in the named slice.

1. **Misleading version-limit message.** A full version history shows "This item changed. Refresh it and try again." (`lib/api-errors.ts:19-20`). Fix in S06.
2. **Report permanent delete has the weakest safeguards** of any permanent delete. Fix in S03.
3. **Board purge is a dead end** when the Board has files, because no UI purges a file. Fix in S04.
4. **A half-created invitation cannot be resent or revoked.** Resend needs `supabase_user_id` and revoke needs `invitation_sent_at`. Fix in S05 with the reconcile action.
5. **A pin has no effect on order.** Fix in S05 (D3).
6. **Post-publish and reminder failures are silent.** S13 makes them visible in Jobs. A notification for them is out of scope.
7. **Dashboard events reach administrators only** (by code reading). Fix in S10.
8. **Six date displays bypass the workspace format helpers.** Fix in S21.
9. **A record with an assigned user who lost access cannot be saved at all.** Every PATCH fails with 422 (`mutation_validation.py:210-248`). S17 reports it per item. Changing the rule is out of scope.
10. **The Board groups picker silently drops groups after the 100th.** Fix in S08.

## 9. Not verified

- All five traces are static reads at `9e732b84`. No test, build, or browser run was done.
- XlsxWriter behavior is from memory: table support in `constant_memory` mode, and `SUBTOTAL` cached values. Check it with Context7 at the start of S15.
- dnd-kit keyboard and touch behavior is not tested in this app.
- The Supabase secure email-change flow is not checked against the installed GoTrue version.
- The claim that dashboard events reach administrators only comes from reading `hub.py`. No test exercises it.
- The sizes are estimates.

## 10. After Tier 2

The order stays: Tier 2, then OpenComms, then the work after OpenComms. The work after OpenComms includes:

- Trigger actions beyond "Set field", and triggers that follow relationship links.
- Notification preferences and digests.
- Presence.
- Conversation search.
- Email delivery of reports.
- Pivot tables and aggregation across relationships.
- Min and max over date and datetime fields (D26).
- In-place backup restore, if the installer is not ready earlier.

## 11. Execution

### 11.1 Rules for the whole run

- Work in the main checkout on one branch, `codex/system-completion-tier-2`, made from `main` at `9e732b84` or later. Do not use a worktree.
- Make one commit for each slice. Use a Conventional Commit message, for example `feat(records): add batch update route`.
- Do not push, open a pull request, or rewrite history. The owner performs S32 and S33, including the canonical pre-push gate once without pushing. The implementation agent must not execute those final acceptance stages. A push needs the owner's approval.
- Keep the scope to this plan. The plan approves the listed migrations, endpoints, dependencies (XlsxWriter, `@dnd-kit/core`), and schema changes. Anything else needs the owner's approval.
- Section 7 is binding. For a detail that section 7 does not settle, apply section 11.8. A slice is blocked only when section 11.8 does not let you decide.
- Keep Comms working. Do not edit `frontend/src/components/systems/comms/**`, except where a slice names a Comms file.
- Keep the designed UI. Extend the current components and tokens. Do not replace a designed page with a plain form.
- Write one migration for each slice that changes the schema. Run `uv run alembic upgrade head` and `uv run alembic check`.
- After a route change, regenerate `contracts/openapi.json` and update `frontend/api-route-manifest.json`.
- Use the skills named in root `AGENTS.md`: `sdd-workflow` at each slice start, `tdd-workflow` before behavior changes, `verification-loop` for checks, `fastapi-api-design` for each new route, `postgres-patterns` for each migration, `query-cache-patterns` for TanStack Query work, `react-frontend-patterns` for UI, and `webapp-security-review` for S03, S10, S15, S17, S20, and S24.
- Record the run in `.agent-runtime/system-completion-tier-2.md` (template: `.agents/orchestration/RUN.md`). Update it after each slice. Keep per-slice verification and expand it when needed under section 11.2; moving S32/S33 ownership does not skip those checks. Record out-of-slice failures under "Known issues for acceptance" instead of fixing them.

### 11.2 Definition of done for one slice

A slice is done when all of these are true:

1. The behavior in the slice's row and in its workstream section exists.
2. New behavior has tests: pytest for the backend, and a Playwright `isolated` or `http` test for the frontend.
3. The tests needed to verify the intended slice behavior and its affected boundaries pass. The agent may run broader relevant regression, integration, and end-to-end batches, including a larger relevant suite when needed; verification is not limited to the changed files and their direct callers.
4. The backend changes pass `uv run ruff check .` and `uv run mypy app operations`. The frontend changes pass `npm run check`.
5. A slice that changes UI has screenshots at 1440×900 and 390×844, in light and dark mode. The screenshots match the request and `DESIGN.md`.
6. A `review` worker found no unresolved defect in the diff.
7. The slice is committed, and the run record shows the evidence.

Choose test breadth to give sufficient control over implementing the feature, and record why a broader run is needed. Batch by coherent work unit, use sustainable concurrency, and reuse passing evidence while its inputs remain valid. This permission expands per-slice verification; it does not transfer S32/S33, final testing, or fixes found during final acceptance to the implementation agent.

### 11.3 Slices

Do the slices in this order. A slice starts only when the slices it depends on are done.

| Slice | Content | Section | Depends on |
|---|---|---|---|
| S01 | Rename misnamed shared files and comments | W1a | – |
| S02 | Login error text, root redirect | W2a, W2b | – |
| S03 | Purge on by default; one rule for every permanent delete (report and event purge routes); backup date in purge previews (D1, D2) | W5a, W5b | – |
| S04 | Purge UI for Board files, reports, and Board events | W5c | S03 |
| S05 | Route bundle: pin and expiry with pinned-first order, unpublish, invitation reconcile, Sandbox export with history, widget `refresh` (D3, D4) | W5d | S03 |
| S06 | Relationship lifecycle UI, version prune and banner, version-limit message, delete text (D18) | W6 | S03 |
| S07 | Paging backend: `post-authors`, `audit-logs/options`, group rows | W3 backend | – |
| S08 | Paging backend extensions (D22), then paging frontend: lists, search pickers with by-ID lookup, Board groups, post authors, loops; delete `loadAllAccessPages` | W3, D22 | S01, S07 |
| S09 | Security events in Manage › Audit, sentences for every type (D17) | W8 | S08 |
| S10 | Backend event delivery for Boards and Dashboards (D8) | W4a | – |
| S11 | Boards live updates and editor notices (D9) | W4b | S08, S10 |
| S12 | Dashboards on TanStack Query, live updates, draft notice | W4c | S10 |
| S13 | Jobs backend: registry, list, retry, schedule last run, job timestamps (D16, D24) | W11a | – |
| S14 | Jobs UI, schedule last run in report controls | W11b | S13 |
| S15 | Export backend: XlsxWriter, reader access, options, cell types, accent map, record (D12) | W9a | – |
| S16 | Export dialog in OpenView; Platform export update | W9b | S09, S15 |
| S17 | Batch update route (D10) | W10a | – |
| S18 | Drag foundation and Kanban (D11) | W10b, W10c | S17 |
| S19 | Calendar and Timeline drag, results; atomic two-field batch item extension | W10a, W10b, W10d, W10e, D10 | S18 |
| S20 | Profile backend: columns, appearance keys, profile route, avatar, person card route | W7a | S03 |
| S21 | `/profile` page, redirects, personal formatting, start page, MFA for members (D13, D14) | W7b | S02, S20 |
| S22 | Person card in People, posts, assignees, events, search (D15) | W7c | S08, S21 |
| S23 | Help panel and shortcut registry | W2c | S21 |
| S24 | Email change | W7d | S21 |
| S25 | Aggregation backend: metrics, buckets, nullable values, batch snapshot route | W12a | – |
| S26 | Saved charts backend, widget references, size migration, lifecycle, Board export (D6, D7) | W12b, W12c | S25 |
| S27 | Shared chart editor | W12d | S25 |
| S28 | Charts page save and load | W12e | S26, S27 |
| S29 | Dashboard grid, widget edit, saved-chart widgets | W12f | S12, S26, S27 |
| S30 | Board widget editor and one chart renderer | W12g | S26, S27 |
| S31 | Documentation update (D19) | W1b | all code slices |
| S32 | Owner: run the Harbor Small and School Small profiles with the executors that earlier slices added (D20, D21) | 11.6 | all code slices |
| S33 | Owner: review the full branch diff, run the pre-push gate without pushing, and write the final acceptance report | 11.7 | all |

Out of scope for this run: OpenComms and everything in section 10.

### 11.4 When to stop

Keep working until every code slice and S31 is committed or blocked. S32 and S33 belong to the owner and are not implementation-agent work. Do not stop to report progress, and do not ask for confirmation between slices.

**Fix these yourself within the active slice. They are never a reason to stop:**

- A process that you started holds a port or a lock.
- A dev server, the API, or a test server does not start.
- A dependency is missing from `node_modules` or the uv environment.
- A test is flaky, or a check fails.

Diagnose the cause, then fix it within the active slice. Try at least three different fixes. Record each attempt in the run record. Do not fix failures outside that slice; record the failing command, file:line, and evidence under "Known issues for acceptance" for the owner.

**Block one slice.** A slice is blocked when one of these occurs:

- The slice needs a decision that section 7 does not cover, and section 11.8 does not let you make it.
- The slice needs a change outside this plan.
- The same check still fails after three different fixes.

Record the blocked slice, with its evidence, in the run record. Then continue with the next slice that does not depend on it.

**Stop the whole run only when one of these occurs:**

- No ready code slice or S31 remains: every remaining assigned slice is blocked or depends on a blocked slice, or all assigned work is complete. Write the section 11.10 handoff; do not advance into owner-owned S32/S33.
- The Docker daemon or the Supabase stack is down, and `./scripts/dev.py db` does not recover it.
- Required credentials or secrets are missing.
- The next step needs an action that root `AGENTS.md` reserves for the owner: data deletion, volume reset, discarding user edits, rewriting history, or a push.

Before you stop, record a checkpoint in the run record: the branch, HEAD, changed files, the finished slices, the blocked slices with evidence, and the next action.

### 11.5 Servers

`next dev` allows only one dev server in each checkout, because the server holds a lock in `frontend/.next/`. The Playwright `http` project starts its own `next dev` on port 3104 through `npm run dev` with the synthetic environment.

1. Do not keep the real frontend (`npm run dev`, port 3000) running while Playwright tests run.
2. Before you start any Next server, check for one with `pgrep -fl "next dev"` and `lsof -nP -iTCP:3000,3104 -sTCP:LISTEN`. Stop each Next server that this run started.
3. For tests, start no frontend server. The Playwright configuration starts one.
4. For screenshots, start the real frontend with `npm run dev`, take the screenshots, then stop the server before the next test run.
5. Keep the Supabase stack and the API (`uv run python -m app --reload`, port 8000) running for the whole run.
6. Never stop a process that this run did not start, unless it holds the Next lock in this checkout and no other session uses it.

Correct: `Screenshots done; stopped next dev on 3000; ran tests/http/openview-export.spec.ts.`
Wrong: `next dev on 3000 still running; started Playwright; lock error; stopped the run.`

### 11.6 Sample run coverage

Each slice that adds a frontend-called route also adds its sample executor and its `SEEDER_ROUTES` entry, in the same commit (D21). The route-coverage guard then passes at every slice. At S32, the owner runs the two live Small profiles with all of these executors. The implementation agent must not run either profile or the guarded reset.

The executors cover the routes that Tier 2 adds, through the same APIs as the UI:

- export (CSV and Excel),
- batch update,
- saved charts and chart-backed widgets,
- the batch snapshot route,
- job list and retry,
- the profile route and the person card,
- version prune,
- the report and event purge routes.

Each covered operation needs an executor and a check of its status, response shape, and end state. Do not count audit rows. At S32, the owner runs the two Small profiles separately, with the guarded reset between them. Standard stays outside this run.

Keep credentials and passphrases private. Do not fabricate request journals or audit rows, and do not insert sample data directly into the database.

### 11.7 Final verification (owner-owned S33)

The owner performs final testing, this full-branch review and final gate, and owns fixes found during final acceptance. The implementation agent must not run `scripts/prepush.py`, the final full coverage gate, or the full-branch acceptance review. Larger relevant tests, including fullstack or smoke scenarios when needed to verify an active slice, are permitted under section 11.2; they do not count as performing or completing S33. Per-slice tests, static checks, and independent slice reviews remain required.

Use the hardware-appropriate rules from Tier 1 section 11.7:

- Keep every assertion, every required suite and scenario, the 90% coverage thresholds, the isolation and cleanup guards, and the no-push boundary.
- Measure a small selection before you choose worker concurrency.
- Use `python3 scripts/prepush.py --base <base-ref> --serial --coverage-stacks 1` when the machine needs it.
- Record the actual runtimes. Total duration alone does not fail a complete passing gate.

The final report lists:

- the finished slices,
- the blocked slices with evidence,
- the checks that were deferred or not run, which count as unverified,
- the follow-ups.

### 11.8 Implementer decisions

Section 7 cannot list every contract detail. For a detail that section 7 does not settle, make the decision yourself when it is one of these:

- validation of degenerate or empty input,
- the display of null, empty, or missing values,
- field, parameter, and error-code names,
- the test technique, fixtures, and clock control,
- the source of a derived value from existing columns.

Pick the most conservative option that matches an existing pattern in this repository. Record it in the run record under "Implementation decisions", with the pattern you followed. Then continue.

Block the slice only when the decision needs one of these:

- a new permission, or a change to who can see or change data,
- deletion of data,
- a change to an existing public request or response shape that this plan does not list,
- work outside the slice's workstream.

Correct: `S15: zero columns → 422 export_no_columns, following the 422 style of query_schemas.py validators; recorded; continued.`
Wrong: `S15: zero-column behavior is not in section 7; slice blocked.`

### 11.9 Resume order (after the first run)

The first run stopped at `0aac35b`. The branch is not mergeable at that commit: S07 changed `GET /boards/{id}/post-authors` to a paged envelope, and the frontend adapter still expects an array, so the Boards posts feed does not load (`.agent-runtime/system-completion-tier-2/S11/blocker.md`).

Resume in this order:

1. Commit this amendment.
2. S08 first. It repairs the posts feed.
3. S03. Apply `.agent-runtime/system-completion-tier-2/S03/parked-work/full.patch` with `git apply --3way`. Regenerate `contracts/openapi.json` and `frontend/api-route-manifest.json` from the current code; do not keep the parked copies of these generated files. Add the purge executors (D21). Rerun the S03 focused tests and the route-coverage guard before you claim them green.
4. S12, S13, S15, S25, and S18 are independent of each other. Do them next, in any order. For S12, apply its parked work the same way and use the D23 budget.
5. Then follow the dependencies in section 11.3 through the remaining code slices and S31. Hand off under section 11.10 before owner-owned S32 and S33.

Do not reuse evidence from parked work. Rerun the checks on the reconciled code.

### 11.10 Handoff to acceptance

The owner performs S32, S33, and fixes found at that stage. The implementation agent completes every code slice and S31, including D21 sample executors, the route-coverage guard, and each slice's tests at the breadth needed under section 11.2, static checks, screenshots and independent review. Do not weaken or delete S32/S33 requirements.

Do not repair a failure outside the active slice. Add it to "Known issues for acceptance" in `.agent-runtime/system-completion-tier-2.md`, with the failing command, file:line and evidence. Preserve an honest distinction between completed slice checks and deferred final acceptance.

When no code slice or S31 remains to do, write a "Handoff to acceptance" checkpoint containing:

- branch and HEAD;
- the commit for each finished slice;
- blocked slices with evidence;
- implementation decisions made under section 11.8;
- known issues for acceptance;
- parked work that was never reconciled;
- checks deferred to S32 and S33.

Stop every Next and test server the agent started. Leave the development Supabase stack and API running. Commit only the assigned slice work and leave the working tree clean; preserve any unresolved task work with its evidence rather than discarding it. The final message is the handoff summary, not a release-readiness claim. Do not execute the Small profiles, guarded reset, pre-push or final full coverage gate, or full-branch acceptance review on the owner's behalf. Any broader per-slice fullstack or smoke evidence remains distinct from the owner's final acceptance runs.
