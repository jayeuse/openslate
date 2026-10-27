# Boards: the team space (relayout)

> **Status: approved by the owner (2026-10-26); build started.** Three owner rounds are folded in: the first answers (sidebar, budget, BE3), round 2 (Announcements, the calendar references, Kanban and Gantt on boards, OpenView loses three layouts, record-date sources), and its three addenda (readability, the board-owned Kanban, the Gantt name and layout). The final answers approve BE7 (the board Kanban) and BE8 (record-date sources). The owner's decisions are fixed; the other decisions were delegated and are recorded in the Decisions tables, each with what it removes. Comps of the novel parts are in `.impeccable/mocks/boards/` (renders in `.playwright-mcp/boards-relayout/comp/`). Base revision `6a5d1b9a` (main).
>
> Inputs: the UX analysis (`.agent-runtime/boards-relayout/ux-analysis.md`, BF-1 to BF-30, BR1 to BR33), the critique (`.impeccable/critique/2026-10-26T07-22-36Z__frontend-src-components-systems-boards-page-tsx.md`, 19/40), the Boards baseline (`.playwright-mcp/boards-relayout/baseline/`), the OpenView layout baseline (`.playwright-mcp/openview-relayout/baseline/V5-{kanban,timeline,calendar}-1440.png`), and four owner references (a Fantastical month, an Outlook week, a Jira board, and a "Q1 Launch Timeline" Gantt).

## Owner answers (2026-10-26)

- **Sidebar: variant A.** Each department group holds Dashboard, **Announcements**, then its modules. The Boards group holds My calendar, Company, the project boards, and All boards. The h1 board switcher goes.
- **Budget: the cold Comms target rises by 1,000 bytes** (548,000 → 549,000) for the Boards group, with the full project-board list; the change gets a ledger row, as the Departments section's did. **Not needed (P1, 2026-10-26):** the widget removal freed about 2,400 bytes, so the target stays 548,000. Measured locally: 544,191 after P0, 544,945 with the Announcements row, crumbs, and static rows, and 544,994 with the project rows and their reader.
- **BE3 approved:** the next-event field on the per-board calendar read.
- **Round 2 and its addenda:** recorded under Direction and as BR47–BR83.

## Direction (owner, 2026-10-26; fixed)

1. Boards become the **team space**. The Overview and its record-summary widgets go **fully**: interface, API, and data (the `board_widgets` table, by a migration). Board export, import, and duplicate (portability) go too: they carried only widgets. Department dashboards hold counts and charts.
2. Each board keeps its calendar. **My calendar** combines the events of every board the person can read. One new backend read across boards is approved for it.
3. **No comments** on posts in this relayout.
4. **Rename.** A department's board is its **Announcements**: the department group reads "Dashboard · Announcements · modules". Company and project boards use the same word in their page titles. My calendar and the Boards group keep their names.
5. **Calendar look.** A **Month like Fantastical** and a **Week like Outlook**, plus Upcoming, on every board's Calendar tab and on My calendar. An event takes its calendar's department mark; Company and project calendars are neutral ink; a record source uses its department's mark in an outlined chip.
6. **Kanban and Gantt on every board.** Every board has the tabs **Posts · Calendar · Kanban · Gantt**. The Kanban is the board's own: **stages** that board managers own, and **cards** of two kinds that writers own, **objectives** and **record cards**. The Gantt shows every card by its start and due dates. (Addendum 2 replaces round 2's "set to one module" model. Addendum 3 renames Timeline to **Gantt**.)
7. **OpenView loses Kanban, Calendar, and Timeline entirely.** The module page's Layout menu keeps Table, Grid, and Gallery. Saved views that use the three layouts are **deleted by a migration**.
8. **Record dates as calendar sources.** A board calendar and My calendar can add a module's date or datetime field as a source; its records appear on their dates beside events. The board's **card due dates** are one more source.

**Purpose of the move (owner).** People do not use OpenView's Kanban, Timeline, and Calendar well. They are hidden (module page › Layout menu › choose a layout), and they are hard to read. Boards puts them in plain sight as tabs beside Posts. So the move is not a port: **all three are redesigned for readability**, and only behavior moves.

### How the three briefs fit together

| Brief said | Holds now as |
| --- | --- |
| "Move only the behavior: record moves, Save changes, drag, the window and grouped reads" (addendum 1) | With board-owned stages, Boards needs **no grouped read and no record moves**. What moves: the drag and keyboard-drag pattern (`@dnd-kit/core`, already used), the Save-changes staging pattern (for Gantt dates), and the **window read** (`/records/window-query`, `adapters/window-api.ts`) for record-date sources. `domain/record-moves.ts`, the record-move Save bar, and their tests go with the OpenView layouts (data safety B). |
| A record card "opens the record's sheet, the same sheet OpenView uses" and a card opens "a right sheet … with Move to stage, Archive, and the record menu" | Both hold in BR64: a record card opens the OpenView record sheet with one board tab first, "On this board", which holds Move to stage and Archive card. |
| Drag "staged with Save changes" (addendum 1) and "feel like Trello" (addendum 2) | BR65: a Kanban move saves at once with an Undo toast; Gantt drags and resizes stage with Save changes. |
| A Kanban "set to one module" (round 2) | Replaced by addendum 2 (BR60). |
| "Timeline" | Renamed **Gantt** everywhere (addendum 3, BR49). |

## Sidebar (decided: variant A)

| Part | Simulated gzip bytes | Notes |
| --- | --- | --- |
| Announcements row in each department group | +70 | One item in `renderGroup` items (`app-navigation.tsx:510–523`), one href helper, one current check (`department-navigation-model.ts`) |
| Breadcrumb "Sales › Announcements" | +35 to 50 | One branch in `ModuleCrumbs` (`app-breadcrumbs.tsx:97–106`) |
| Static rows: My calendar, Company, All boards | +18 | They replace Overview, Posts, Calendar in `workspace-navigation.ts:43–55` |
| Project-board rows from the board-list cache | +175 | The `ProfileCrumb` pattern: the shell reads the cache `/boards` fills, by key |
| A small reader that loads the board list when the group opens on another route | +125 | A lazy chunk; only its loader counts on a cold `/comms` load |
| `board_widgets` leaves the live-event list (P0) | −10 to −15 | `workspace-event-source.ts:13` is in the Comms manifest |
| **Total** | **+420 to 520** (simulated 419) | |

Method: the changes were written as minified code into the built shell chunks (`frontend/out/_next/static/chunks/2rx8t0l6w1ibl.js`, `29a7z9qwnmtgs.js`, `1iisnp8jrjs32.js`) and compressed with zlib level 9, as `comms-js-budget.spec.ts` measures. It is an estimate, not a build.

**Budget plan (P1).** The target was to become 549,000; P1 measured it unneeded (see Owner answers), so it stays 548,000. Measure before the row lands, then after each step: (1) the number after P0, locally and in CI; (2) the Announcements row, the crumb, and the static rows; (3) the project rows and their reader. Each step records its bytes.

**Pain point:** the department group grows by one row (Sales has 6 rows). **Solution:** only the current department opens (DA3).

## Outcome

A person opens a board from the sidebar and sees, in the slim grammar, its posts, its calendar, its Kanban, or its Gantt, each one tab away. They know their level from one chip. They find a scheduled post where it will appear. They see the next event even when the month is empty, and read every event title at 1280. On the Kanban they see what is in each stage at a glance and move a card in one drag. On the Gantt they see the plan without reading. My calendar shows what is next across all their boards and their own record sources.

**In scope.**

- The `/boards` page: the header and tabs, Posts, Calendar (Month, Week, Upcoming), Kanban, Gantt, My calendar, All boards, and Board settings, with their sheets, dialogs, menus, empty and no-access states, 390px layouts, and words.
- The sidebar rows (variant A).
- The widget and portability removal; the OpenView layout removal and the saved-view migration.
- The backend rows in the go-ahead table.

**Out of scope.**

- Comments on posts (direction 3).
- New post or event features (reactions, read receipts, RSVP).
- Automations that move cards, card templates, card dependencies, and recurring cards.
- Changing a record from Boards by drag (BR79).
- Other pages, except the shell rows, the breadcrumb, and OpenView's Layout menu.

**Preserved behavior.**

- `backend/app/systems/boards/access.py` stays the source of truth: admins manage every board; every member reads the Company board; guests are capped at read; module-only write gives read on the department board (BR34).
- Posts, events, board lifecycle, and the live stream behave as today (drafts, schedule, publish, notifications through `post_inbox.py`, series, reminders, files, links, record links, archive, restore, purge).
- OpenView's Table, Grid, and Gallery keep their saved views, grouping, filters, and exports.
- **URLs.** `/boards` opens the Company board's Posts. `?board=<id>&section=posts&post=<id>` (`platform-search-api.ts:91`, `notification-kind.ts:41`) opens the post; `?board=<id>&section=calendar&event=<id>` (`platform-search-api.ts:93`, `notification-kind.ts:46`) opens the event's sheet. `section=overview` opens Posts. New: `?department=<id>`, `section=all|my-calendar|kanban|gantt`, `view=month|week|upcoming`, `card=<id>`, and `show=`. An OpenView address with `layout=kanban|calendar|timeline` opens Table.

## Baseline

| Measure (`ho-admin`, Company board) | Overview | Posts | Calendar (Oct, empty) | Calendar (Nov) | Event editor |
| --- | --- | --- | --- | --- | --- |
| Document scroll at 1440×900 | 1499px | 0 | 84px | 180px | 1226px |
| First content at 1440 | y=333 | first post y≈423 | grid y=441 | grid y=441 | form y=405 |
| Document scroll at 390×844 | 2321px | 505px | 0 | 2013px Agenda, 620px Month | 1123px |
| Horizontal overflow at 390 | none | none | none | Month grid 593px in 390 | none |
| Controls at 1440 | 44px | 44px | 44px | 44px | 44px |
| Cold API requests on `/boards` | 50 (admin), 41 (manager, no-access); the Overview's share is 16 | | | | |

Critique: **19/40**, four P1s. `systems/boards` uses `slim-ui`, `PageHeader`, `DialogFrame`, `DisabledReason`, and `StatusWord` zero times.

**OpenView's three layouts (baseline `V5-*-1440.png`, code at `6a5d1b9a`):**

| ID | Finding |
| --- | --- |
| LF-1 | They are hidden: a person reaches them only through the module page's Layout tabs, under about 700px of controls. |
| LF-2 | Each opens on a sentence with no control: "Choose an active queried field to load Kanban lane counts.", "Choose active queried start and end DATE or DATETIME fields…", "Choose an active queried DATE or DATETIME field…". The fields are chosen in Layout settings, elsewhere. |
| LF-3 | The Kanban is not a board: a grid of lane buttons with counts, and below it the selected lane's cards in a 2–3 column grid (`live-kanban.tsx:742–790`). Cards carry field-name labels (`<dt>`/`<dd>`, `:243–252`), blue underlined names (`:220`), and a separate drag-handle button and Move menu (`:345–381`). |
| LF-4 | The Timeline is a list with one track per record (`live-timeline.tsx:576`), no shared date axis, "Window starts" and "Window ends" date inputs, the deadline as a text line, and progress as "Progress: n%" text beside a bar (`:671–690`). |
| LF-5 | The Calendar has a Month and a List scale, date inputs for its window, and helper prose ("Undated time defaults to workspace-local 00:00.", `live-calendar.tsx:810`). |

## Findings (Boards)

Evidence for each row is in the analysis.

| ID | Pri | Finding | Fixed by |
| --- | --- | --- | --- |
| BF-1 | P1 | The sidebar lists sections, not boards; the h1 picker is a filter form | BR1–BR5, BR47 |
| BF-2 | P2 | Two stacked headers and an intro sentence before content | BR6, BR50 |
| BF-3 | P2 | The Board menu mixes five jobs; four sheets; three close patterns | BR26 |
| BF-4 | P2 | Not still pages (Overview 1499px, event editor 1226px) | BR8, BR21 |
| BF-5 | P2 | Pre-slim 44px controls at 1440 | BR38, all phases |
| BF-6 | P2 | Unknown board: a Retry that cannot succeed | Role states |
| BF-7 | P3 | The board list and the open board are read three times each | P1 proof |
| BF-8 | P1 | The Overview is the default; two roles land on "Widgets unavailable" | FN1, BE1 |
| BF-9 | P1 | Drafts and scheduled posts never show on the Posts page | BR10 |
| BF-10 | P1 | The post dialog has no actions | BR12 |
| BF-11 | P2 | Tall cards, link-styled authors, "GMT+8" on every row, a search card | BR11 |
| BF-12 | P2 | "Post editing is unavailable" reads as a fault | BR6, BR34 |
| BF-13 | P2 | The post editor puts rules first and Publish below the fold | BR13 |
| BF-14 | P1 | The calendar opens on an empty current month | FN2, BR43, BE3 |
| BF-15 | P1 | At 390 the month grid is 593px wide | BR59 |
| BF-16 | P2 | The event editor replaces the calendar | BR21 |
| BF-17 | P2 | One event has two detail surfaces | BR20 |
| BF-18 | P2 | Agenda repeats every occurrence as a full card | BR19 |
| BF-19 | P2 | Month cells spend a line on "1 event" and cut titles | BR54, BR55 |
| BF-20 | P2 | "My events" collides with My calendar | BR16, BR44 |
| BF-21 | P3 | "Current Board revision N" | BR21 |
| BF-22 | P2 | Manage Board: Save at rest, a cleanup tool in the main panel, an editable name the sync undoes | BR27 |
| BF-23 | P2 | Preview access: the title twice, four controls for one choice | BR28 |
| BF-24 | P3 | Activity is a fourth sheet | BR29 |
| BF-25 | P2 | Configurations carry only widgets | BE1 |
| BF-26 | P3 | New project board does not take the person to the next step | BR30 |
| BF-27 | P2 | At 390 the first post starts at y≈607 | BR31, BR32 |
| BF-28 | P2 | No board shows the viewer's level | BR6 |
| BF-29 | P2 | Module-only write gives read with no reason | BR34 |
| BF-30 | P3 | Capitalised common nouns and engineering words | P6 |

## Data safety (read before any phase)

Two parts delete data: the board widgets (A) and the saved OpenView views of three layouts (B). Part C lists what the new Kanban adds to purge and reset. Every path was checked at `6a5d1b9a`.

Caution: do not run either migration on an installation without a backup. The deleted rows cannot come back without one. Follow `infra/supabase/RESTORE.md` for the backup step.

### A. Board widgets and portability (BE1)

| Area | Path | Change |
| --- | --- | --- |
| Model and table | `boards/models.py:131–166` (`BoardWidget`, `board_widgets`; foreign keys to `boards`, `modules`, `charts`, all `ondelete="RESTRICT"`) | Remove the model; the migration drops the table |
| Model registry | `core/database/model_registry.py:15` | Remove the import |
| Routes | `main.py:56, 63, 375, 380`; `boards/widget_router.py` (6 operations), `widget_schemas.py`; `portability_router.py` (`GET /{board_id}/configuration`, `POST /import`, `POST /{board_id}/duplicate`), `portability.py`, `portability_queries.py`, `portability_schemas.py` | Delete: 9 operations on 7 paths |
| Board purge | `boards/lifecycle_router.py:20, 66` | Remove `BoardWidget` from the child models |
| Board activity | `boards/activity_router.py:25, 45, 58–62, 131–138`; `activity_schemas.py:20`; frontend `adapters/board-tools-api.ts:49` | Remove the widget kind and its query branch (BE5) |
| Chart usage | `openview/charts/service.py:298–351`; frontend `openview/adapters/charts-api.ts:255` | Charts count dashboard widgets only; usage loses `kind: "board"` |
| Sandbox purge | `sandbox/lifecycle/board_widget_dependencies.py` (whole file); `batch_dependencies.py:21–22, 159–170, 311, 314, 431, 447–449`; `department_board_dependencies.py:12, 31, 45, 226`; `execution.py:16, 64, 168` | Board widgets no longer block a purge |
| Audit attribution | `manage/audit/department_ancestry.py:14, 45` | Remove `BoardWidget`; past rows keep their stored department |
| Live events | `platform/events/models.py:83`; frontend `shared/adapters/workspace-event-source.ts:13` | Remove `board_widgets` |
| Purge review words | frontend `shared/lifecycle-purge-review.tsx:14` | Remove the label |
| Audit words | frontend `manage/domain/audit-rules.ts:117` | **Keep**: Manage › Audit still lists past widget rows |
| Row-level security | `migrations/versions/f5a100021193_organization_row_level_security.py:35` | History; the policy drops with the table |
| Reset | `operations/reset/models.py:25, 184, 253`; `tests/reset_application_data/test_reset_table_parity.py` | Remove `board_widgets` |
| Sample runs | `population/boards.py:155–207, 335–360, 387`; `population/content.py:156, 263`; `population/workflow.py:41`; `controls/board_widgets.py`; `controls/boards.py:38–40, 345–354`; `controls/board_execution.py:125, 178`; `controls/charts_consumers.py`; `controls/charts_receipts.py:126`; packs `harbor/__init__.py:232` (48), `school/__init__.py:184` (44) | Remove widget seeding, controls, and counts |
| Frontend | `systems/boards/`: `server-backed-board-widgets.tsx`, `server-backed-board-widget-management.tsx`, `hooks/use-live-widgets.ts`, `hooks/use-board-widget-management.ts`, `adapters/board-widgets-api.ts`, `domain/widget-editor.ts`, `domain/live-widget-query.ts`, `server-backed-board-portability.tsx`, `hooks/use-server-board-portability.ts`, `adapters/board-configuration-api.ts` (about 4,600 lines); `use-server-boards.ts:65–67`, `workspace-navigation.ts:48` | Delete; the default section becomes Posts |
| API contract | `contracts/openapi.json`; `backend/tests/contracts/test_openapi_snapshot.py` | Refresh |

**Data effect.** Every board widget row is deleted (Harbor 48, School 44). Charts that only board widgets used become deletable; modules and fields that only board widgets referenced become purgeable. Board Activity stops showing past widget rows; Manage › Audit keeps them. **An installation loses** the counts, lists, and charts on board Overviews and the board configuration files; department dashboards hold the same counts and charts. **Downgrade** recreates an empty table.

### B. OpenView's Kanban, Calendar, and Timeline (BE6)

| Area | Path | Change |
| --- | --- | --- |
| Wire values | `openview/views/schemas.py:17` (`layout: Literal[…, "kanban", "calendar", "timeline", …]`), `:25–31` (`date_field_id`, `timeline_start_field_id`, `timeline_end_field_id`, `timeline_deadline_field_id`, `timeline_progress_field_id`, `date_range`, `scale`); frontend `adapters/views-schemas.ts:24–26, 260–267, 293–341` | `layout` keeps `table`, `grid`, `gallery`; the seven fields go. `group_by_field_id` stays (Table, Grid, and Gallery group with it, `saved-view-advanced-controls.tsx:254–256`). |
| Saved views | table `saved_views` (`presentation` JSON; no table references `saved_views` by foreign key) | The migration **deletes** every view whose `presentation->>'layout'` is `kanban`, `calendar`, or `timeline`, archived ones included, and **strips the seven keys** from every remaining view. `ViewPresentation` is `extra="forbid"`, so a remaining view that kept a key would fail to read. A deleted default view leaves its module on the built-in default. |
| Address state | frontend `domain/temporary-view.ts:139–142`, `adapters/views-serialization.ts` | `layout=kanban|calendar|timeline` in an address opens Table; owned by `tests/isolated/openview/url-state.spec.ts` |
| Frontend code | `components/live-kanban.tsx` (954), `live-timeline.tsx` (810), `live-calendar.tsx` (1,896), `domain/record-moves.ts` (185), the record-move Save bar and its owner state in `server-backed-views-workspace.tsx` (`:1700–1900`, `:3270–3300`, `:3560–3620`), the calendar and timeline settings in `saved-view-advanced-controls.tsx` (`:383–410`), `layout-menu.tsx` (six items), `adapters/window-api.ts` callers in the workspace; `records-api.ts:213` (the frontend `batch-update` caller) | Delete. `window-api.ts` stays for Boards record sources. The backend `/records/batch-update` route stays: sample controls and catalog tests use it. `/records/grouped-query` stays for grouped Table, Grid, and Gallery. |
| Sample packs | `packs/harbor/content_data.py:32` and `packs/school/content_data.py` (`_LAYOUTS`); `population/openview.py:273–290`; counts `harbor/__init__.py:237` (`"views": 36`), `school/__init__.py:189` (`"views": 42`) | `_LAYOUTS` keeps three; Harbor seeds 18 views, School 21 |
| Backend tests | `tests/views/test_presentation_contracts.py`, `tests/views/test_contracts.py`, `tests/operations/sample/population/test_sample_openview.py`, `tests/operations/sample/controls/test_sample_control_openview*.py`, `tests/operations/sample/packs/test_school_content.py`; a new migration test | Update; the migration test checks deletion, stripping, and an untouched Table view |
| Frontend tests | deleted: `http/openview-kanban-moves.spec.ts` (12), `http/openview-date-moves.spec.ts` (14), `isolated/openview/record-move-receipts.spec.ts` (3); trimmed: `http/openview-views-api.spec.ts` (the Kanban, Calendar, and Timeline cases near `:3741`, `:4031`, `:4104`, `:4453–4690`, `:4910`, `:5035`, and the layout parameters), `isolated/openview/views-api.spec.ts`, `isolated/openview/window-api.spec.ts` (kept for the window read) | Every removed assertion gets a ledger row |
| OpenView specs | `docs/specs/openview-department-pages.md` DA11 and DA20; `docs/specs/openview-relayout.md` OD4 and OD8 | DA11 and DA20 are marked superseded with a pointer here; OD4 and OD8 are reversed by the same decision (BR77) |

**Data effect.** Every saved view of the three layouts is deleted (Harbor 18 of 36, School 21 of 42: one per layout per department). Remaining views lose only the calendar and timeline settings they could not use. Audit rows of the deleted views stay. **An installation loses** those saved views. The replacements are a board's Kanban and Gantt (board data, not views) and calendar record sources (BR57). **Downgrade** restores the schema values, not the rows.

### C. What the new Kanban adds to purge and reset (BE7)

- A board purge deletes its stages, cards, labels, checklist items, and card files and links.
- A record or module purge **lists and removes** the record cards that point at it (`sandbox/lifecycle/board_card_dependencies.py`). It never blocks: the widgets' `RESTRICT` keys blocked purges, and this spec does not repeat that. (Correction found in P0: `board_record_link_dependencies.py` does block a source purge today, and record links keep that behavior.)
- Reset lists the new tables (`operations/reset/models.py`); the table-parity test checks them.

## Fix-now rows (land in P0)

| ID | Fix | Proof |
| --- | --- | --- |
| FN1 | The Overview 404s that blank the panel for `ho-manager` and `ho-noaccess` disappear with the widgets: a bare `/boards` opens Posts. **This is the removal's first proof.** | An HTTP journey: a cold `/boards` as a non-admin reader sends no `/widgets`, `/records/query`, or `/fields/<id>` request and shows the posts; a hands-on check as both accounts |
| FN2 | The empty current month points to the next event ("No events in October · Next: Mon, Nov 2"), using BE3 | An isolated test of the words; an HTTP journey; comp `calendar-empty-1440.png` |

## Decisions

### Adopted from the analysis (ui-ux-pro-max)

The analysis holds the full text. "Refined" and "superseded" name the later decision.

| ID | Decision | Removes |
| --- | --- | --- |
| BR1 | Each department group shows its board row after Dashboard, linking to `/boards?department=<id>`; the row reads **Announcements** (BR47) | Department boards in the h1 picker |
| BR2 | The Boards group: My calendar, Company, active project boards by name, All boards; project rows from the board-list cache, and a small reader when the group opens on another route | The static Overview, Posts, Calendar items; the popover picker |
| BR3 | All boards (`section=all`): search, Active · Archived, 40px rows with mark or kind glyph, name, kind word, and level chip; New project board for admins | The popover's search, selects, Reset filters, pager, and empty messages |
| BR4 | Breadcrumbs: "Sales › Announcements"; "Boards › Company", "Boards › <project>", "Boards › My calendar", "Boards › All boards" | "Workspace › Boards › Overview/Posts/Calendar" |
| BR5 | The collapsed rail's Boards button opens the sidebar with the group open; the drawer shows the same rows | — |
| BR6 | One `PageHeader`: the page title (BR47) with the `DepartmentMark` before a department's, the level chip (Read, Post, Manager; only Manager tinted), an Archived chip when archived, one meta line; the tab's one primary; a quiet Board settings for managers. Refined by BR50. | The icon tile, the h1 picker, the section h2 and intro, the header Refresh, the Board menu |
| BR7 | Refresh follows the live stream; refreshing or a failed refresh shows in the meta line | Banners; the Refresh button |
| BR8 | From 1280px the page is still; only panels scroll | Document scroll at 1440 |
| BR9 | `section`: `posts` (default), `calendar`, `kanban`, `gantt` with a board; `all` or `my-calendar` without; `overview` opens Posts | The Overview default |
| BR10 | Posts: list and reading pane from 1024px; search, Filters (Author), Sort; writers and managers get Published · Scheduled · Drafts (plus Archived for managers) | The search card, "More filters", the Manage posts sheet |
| BR11 | Two-line list rows; pinned first; the whole row opens the post; compact pager | The cards, "Open post", the underlined author, "GMT+8" on every row |
| BR12 | Reading pane: title, one meta line, a quiet Edit, a More post actions menu; Files, Links, and Linked records only with items | The centered dialog; empty "Attachments" |
| BR13 | The post editor in the shared dialog frame; Publish (primary) with Schedule…; one consequence line; "Publishing…" then a toast | The editor sheet and its list; six helper sentences |
| BR14 | Archive a published post confirms with one consequence line; Restore acts at once with a toast | — |
| BR15 | Empty states teach with the same layout and name the scope's reason | Text-only empties |
| BR16 | One calendar toolbar row; Show: All · Created by me · Archived. Refined by BR51. | The full-width search, "Event lists", "0 occurrences", "My events" |
| BR17 | ~~The 320px day pane.~~ Superseded by BR51–BR52. | — |
| BR18 | The empty current month points forward. Refined by BR43. | An empty grid that looks like an empty board |
| BR19 | Upcoming: from today forward, grouped by day, Show later; a series shows its repeat once per row | Per-occurrence cards |
| BR20 | One event sheet (the record sheet grammar) for every view and for `?event=`; "Close event" | The deep-link dialog |
| BR21 | The event editor in the shared dialog frame, Title, then When; it opens on Title; conflict: "Someone changed this event first." | The inline editor; "Current Board revision N" |
| BR22 | My calendar at `section=my-calendar` over every active board the person reads | — |
| BR23 | ~~Company and project events carry the board name as a muted word, with no new palette.~~ Revised by BR53. | — |
| BR24 | A board whose events fail to load shows it in the calendar list ("not loaded · Retry"); the rest still show. Refined by BR52. | One failure blanking the calendar |
| BR25 | New event from My calendar (BR35) | — |
| BR26 | Board settings: one sheet with Details · Access · Activity | Three sheets and the Board menu |
| BR27 | Details: label-left rows; a department board's name is read-only; Advanced last; Archive asks once; Restore is neutral | The typed name on Archive; the red Restore |
| BR28 | Access: read-only summaries; project groups per row; Check a person | The preview sheet and its four controls |
| BR29 | Activity: 40px audit sentence rows | The Activity sheet and its cards |
| BR30 | New project board in the dialog frame; after Create, Board settings opens on Access | The creation sheet |
| BR31 | Phone header: two short rows, then the tabs | The wrapped header |
| BR32 | Phone Posts: list or post, with Back | The 607px offset |
| BR33 | ~~The phone calendar opens on Upcoming.~~ Revised by BR59. | The 593px grid |

### Delegated decisions (first round)

| ID | Decision | Removes |
| --- | --- | --- |
| BR34 | Module write on part of a department keeps read on its department board (`access.py:73–76`); the level chip's description says "Posting needs write access to Sales." Pain point: a team that works only in modules cannot post. Solution: an admin gives that group a department-level Write row. | A silent read level |
| BR35 | New event from My calendar shows only when the person can post on at least one board; the editor's first field is **Board**, with the consequence line "Everyone who reads Sales sees this event." | — |
| BR36 | No "Coming up" list beside Posts; the Calendar tab and My calendar answer "what is next" | — |
| BR37 | Board settings is one sheet; Preview access becomes Check a person | Four sheets |
| BR38 | Posts use the slim controls; the reading pane sets the message at the reading measure (DESIGN Body: 24px line, at most 672px; the Profile Bio's 65ch) | 140-character lines |
| BR39 | Scope: every critique issue and every analysis P1 and P2; the P3 words land in P6 | — |
| BR40 | ~~The Posts · Calendar switch in the header actions.~~ Superseded by BR50. | — |
| BR41 | A department board's address is `/boards?department=<id>`; a `?board=<id>` arrival is replaced with it once the board is read, so the shell reads the URL alone | A board read in the shell |
| BR42 | ~~Two-line titles on quiet days.~~ Superseded by BR55. | — |
| BR43 | The empty-month status: "No events in October · Next: Mon, Nov 2 →", one button named "Next: Mon, Nov 2, go to the next event"; "No upcoming events" when there is none. **Refined (fix lane 1):** the status sits at the center of the empty month grid, not in the toolbar, so the toolbar stays one row at 1280 and 1440; after Next, the new period's title takes focus. A month or week that a search or hidden calendars emptied says so instead (`No events match "x"` · Clear search; "1 calendar hidden" · Show all). | A second Go-to control; a status that wraps the toolbar |
| BR44 | "Created by me" filters occurrences by author in the browser; Archived (managers) is a list from the existing events read | `/events/mine` as a calendar read |
| BR45 | ~~The meta line names the kind first.~~ Revised by BR47: the title carries the word, and the meta line says who reads and posts ("Sales roles read and post", "Everyone reads · admins post", "3 groups · members post"). | — |
| BR46 | Phones name the month short ("Nov 2026"). Its neutral-dot rule is revised by BR59. | A cut month name |

### Owner round 2 and its addenda, with the decisions they needed

| ID | Decision | Removes |
| --- | --- | --- |
| BR47 | **(Owner) Announcements.** The department row reads **Announcements**. Page titles read "<owner> announcements": "Sales announcements", "Company announcements", "Fleet Reliability announcements". Crumbs mirror the sidebar ("Sales › Announcements", "Boards › Company"). My calendar, All boards, Board settings, and the Boards group keep their words. **Pain point:** "Announcements" names one of four tabs. **Solution:** the tabs carry the meaning; "Team" is a fallback name the owner can pick later with no layout change. | "Board" as a second word beside Dashboard |
| BR48 | **(Owner) Purpose: plain sight and readability.** Kanban, Calendar, and Gantt are tabs beside Posts and are redesigned; only behavior moves (see "How the three briefs fit together"). | The Layout-menu path to them (LF-1) |
| BR49 | **(Owner) "Gantt" is the name** of the fourth tab everywhere: tab, URL (`section=gantt`), words, and tests. | "Timeline" |
| BR50 | **Tabs under the title** on every board: Posts · Calendar · Kanban · Gantt, each with its icon. Four views do not fit the title row at 1280 with a long project title. The tab's primary sits in the title row: New post, New event; Kanban and Gantt have none (cards are added in their stage, BR62). | BR40's switch in the actions |
| BR51 | **(Owner) Month, Week, Upcoming** on every board's Calendar tab and on My calendar (`view=`). | The day pane; the Month · Upcoming switch |
| BR52 | **The left rail** (Outlook): the mini month and the calendar list with a checkbox per calendar and source, from 1440px. Below 1440 it folds into a Calendars button in the toolbar (a popover), so month cells keep their width at 1280. Hidden calendars are a per-viewer convenience in browser storage. A failed read shows in its row ("not loaded · Retry"). | The Boards filter popover; the Show-boards chips |
| BR53 | **(Owner) Calendar colors.** An item takes its calendar's department mark (`--dept-n`, the Same Department Rule). Company and project calendars are neutral ink. Record sources take their module's department mark, **outlined**. Card due dates take the board's color, **outlined with "Due"** before the title. No new palette. The name stands beside the color in the calendar list, the accessible name, the tooltip, and the sheet. **Conflict:** in a month cell the name is not beside each chip, which the Name Beside Color Rule asks for; this extends the rule's dense-row exception (names in the accessible text, one click away). Impeccable records the exception in DESIGN.md. | BR23's uncolored chips |
| BR54 | **Month anatomy (Fantastical).** A timed event: ink title, a 3px rule in its color, the time right-aligned in muted ink, no fill. An all-day or multi-day event: a tinted pill that runs across its days and continues into the next week. The week number sits inside Monday's cell ("W45 2"). Weekends and outside days are muted. Today's number is an ink pill. "+n more" opens the day in a popover. **Conflict:** Fantastical draws titles in colored text, which fails AA for some hues; ink text with the color as the rule keeps AA. (Owner, 2026-10-27) The shape follows the event's timing only: an all-day event is a pill, and a timed event is a rule. There is no per-event Important or Routine style. | The week-number column; colored text |
| BR55 | **Legible at 1280.** A title takes two lines while its day still has room for the items below it; the time stays right-aligned on the first line. Measured on the comps: month cells are 128px wide at 1440 (rail open) and 140px at 1280 (rail folded); chips are 122px and 134px. | One-line titles cut on every day |
| BR56 | **Week anatomy (Outlook).** Hours down the left (6 AM–9 PM; it opens at 7 AM and scrolls), an all-day row, blocks sized by duration with the title, the time, and the location, overlaps side by side, and the current-time line. **Conflict:** the references draw "now" and "today" in red or blue; danger and action each have one meaning, so the line and today's mark are ink. | — |
| BR57 | **(Owner) Record-date sources.** A board manager adds sources to a board calendar; a person adds their own to My calendar. A source is one module and one date or datetime field, up to 5 per board and 5 per person, saved on the server (BE8). Records come from the window read. A viewer sees only the sources whose module they can read (the Same Answer Rule). A source's row menu: Hide, Remove (who added it), Open records without a date (the module page with that filter), and Add to My calendar (a copy). A record chip opens the record sheet. | OpenView's Calendar layout |
| BR58 | **(Owner) Card due dates as a source.** A board calendar lists "Cards · Due" (that board's cards with a due date). My calendar lists "My cards · Due" (cards assigned to the person on every board they read): one read, not one per board. | — |
| BR59 | **Phones.** Month is a compact grid with calendar-colored dots (each day's rows under the grid name the calendars). Week becomes a **day list**: a 7-day strip with dots, then the selected day's items in time order with time ranges; the time grid needs 768px. Phones open on the day list for today. | Upcoming as the phone default; the neutral dots |
| BR60 | **(Owner) The board's own Kanban.** One Kanban per board, with stages and cards that belong to the board. It replaces round 2's one-module setting. | OpenView's Kanban grouped by a choice field |
| BR61 | **Stages (managers only).** "Add a stage" sits at the end. A stage header opens its menu: Rename, Color, WIP limit, Move left or right (or drag the column), Sort cards (Manual, Due date, Newest, Title), and Archive stage (its cards move to a chosen stage, or are archived with it). Over its WIP limit, the count reads "9 / 8" in warn and a warn rule underlines the header. | — |
| BR62 | **(Owner) Cards: objectives and record cards.** "Add a card" at the bottom of each stage opens an inline composer: type a title for an objective, or choose **Find a record**, which searches the modules the person can read. Writers (anyone who can post on the board) add, edit, move, and archive cards; readers view and open them. | — |
| BR63 | **Record cards.** A record card shows its module name with the record icon, the record's name, up to two of the module's first fields as plain text, and the record's status as a chip. Its start and due are prefilled from the record's first date and datetime fields (the person picks when there are several); after that they belong to the card. Moving it changes only the board. A person who cannot read the record sees a **locked card**: a lock and "No access to this record", no name (BD6, BD15). It keeps its place and counts in its stage. Writers may move or archive a locked card; nobody opens it. | — |
| BR64 | **Card sheets.** An objective opens a right sheet in the record sheet grammar: the title, one meta line (stage · due), Move to stage, a More card actions menu (Copy link, Archive), a named close, and tabs Details (label-left rows: Assignee, Start, Due, Labels, Description, Checklist), Files, Linked records, Activity. A record card opens **the OpenView record sheet** (DA18) with one tab first, **On this board** (Stage, Card start, Card due, Labels, Assignee, Archive card), then the record's own tabs; its More record actions menu adds "Open in Quotes". | A second record surface |
| BR65 | **Save model.** A Kanban move saves at once and shows "Moved to Sent · Undo" (the Four Moments Rule: a reversible one-step action gets a toast with Undo). A Gantt drag or resize is staged with Save changes, because a plan often moves several bars; the staged bar shows its old place dashed. | Staged record moves on a Kanban |
| BR66 | **The Kanban looks drawn on a whiteboard.** The board surface reads the canvas tokens (`--canvas-background` with the `--canvas-grid` dots), so the Whiteboard look shows a real whiteboard and Slate stays Slate. It gets **its own skin place, `data-skin="board-surface"`,** that each look frames as it frames the canvas: `[data-skin="canvas-frame"]` cannot be reused, because it also resets the text size (`font-size: calc(1rem / var(--device-text-scale))`, found on the comp) and would ignore the person's text-size setting. Stages are drawn, not filled: the name over a 2px rule in the stage's color. Cards sit on it as notes (the surface, a rule edge, `--card-lift`). **Conflict:** a handwriting face or a texture would break the Don'ts and the Look-Only Rule; the canvas tokens keep the feel in every look. | Filled lane panels |
| BR67 | **Kanban readability.** The stage header: color dot, name, count (and the WIP limit). Cards: the title in ink; labels as named chips; one fact line (due date, in warn when overdue; checklist "3/5"); the assignee avatar. No field-name labels. Stages scroll on their own; the board scrolls sideways only when the stages do not fit; a long stage shows 25 cards, then the rest in pages of 25 ("25 of 41 · Show 16 more"). Drag: the lifted card takes the raised lift and a focus-color edge; the target stage tints and shows a dashed slot where the card lands. Keyboard: Space lifts, arrows move, Space drops, Escape cancels; the card menu has Move to stage (WCAG 2.5.7). An empty stage shows its drop target. | The lane-button grid, labeled fields, blue link names, the drag-handle button (LF-3) |
| BR68 | **Kanban toolbar.** Search, a people filter (avatars, "+3"), Labels, Due (Overdue, This week), and Group by (None, Assignee, Label). Grouping draws swimlanes, each with a sticky name row across the stages. Filters are per viewer, in the URL. | — |
| BR69 | **Stage and label colors** use the five chart series (`--chart-1` to `--chart-5`): categorical tokens with no signal meaning. The name always stands beside the color. Department hues and the four signals stay out, except warn for a WIP overrun, an overdue date, or an unsaved Gantt change (its meaning). **Conflict:** DESIGN.md has no label palette; the chart series are its only categorical tokens. The contrast guard gets the new pairs (ink on each tint). | — |
| BR70 | **Labels** are board-defined: managers create, rename, color, and remove them from the Labels filter menu ("Edit labels…"); writers apply them. | Labels managed far from where they are used |
| BR71 | **Phone Kanban:** one stage at a time with a stage switcher (a scrolling segmented control with counts); a swipe also changes the stage. Drag is off on phones; the card sheet has Move to stage. | Sideways board scroll on phones |
| BR72 | **(Owner) Gantt columns are dates:** a month header row, then a week row ("W1"–"W4" by the week's place in its month at Quarter zoom; the week's start date at Week and Month zoom). Dotted lines mark the weeks, solid lines the months. Zoom: Week, Month, Quarter; Quarter is the default, as in the reference. **Amended (Gantt review, 2026-10-27):** at Quarter a month with 3 or more days in view shows its short name ("Oct") above its weeks, so a trailing "W1" reads as the next month's first week; a name keeps only its line when its days are too narrow for it. At Month and Week the start-date labels read from their week line; W labels stay centered. Week zoom adds a day row (each day's number) and faint dotted day lines. | Per-record tracks without a shared axis; the window date inputs (LF-4) |
| BR73 | **(Owner) Gantt rows are cards:** the name on the left (sticky) in muted ink, the bar from start to due, and no text inside card bars. A record card's name carries the record icon. Each group (a stage by default; an assignee or a label) has a bold header row with a **summary bar** in neutral ink from the earliest start to the latest due, its name inside; as in the reference, its darker leading segment is the group's checklist completion. A card with only one date draws a one-day bar on it. | Text in every bar |
| BR74 | **(Owner) Gantt color and progress.** A bar takes its card's first label color (chart series tint). A **darker leading segment** shows an objective's checklist progress; record cards have none. A legend at the top right lists the labels in use. **Conflict:** the brief's "neutral action tint" for a bar with no label would give action a second job; the design system wins, and such a bar is a neutral ink tint, lighter than the summary bar. **Shading (Gantt review, 2026-10-27; owner, impeccable):** one rule in every look, less ink reads lighter. The summary body is `--ink-muted` at 28% and its done segment 60%; a card bar with no label is `--ink-muted` at 14%; a label bar keeps its series at 52% and its full-strength checklist segment. Every bar has a 1px inset edge that holds 3:1 against `--card` (WCAG 1.4.11): `--ink-muted` for the summary and a bar with no label, the full series for a label bar, and for `--chart-2`, under 3:1 on light cards, `color-mix(in oklab, var(--chart-2) 80%, var(--ink))` (lowest 3.93, Triplicate light). The edge, the staged warn ring and the drag lift are one `box-shadow`. The group name keeps the 28% body behind it over the done segment, because ink on the 60% segment falls under 4.5:1 in three dark looks (lowest 3.80, Whiteboard dark). | The deadline marker (the due date is the bar's end) |
| BR75 | **Gantt behavior.** A today line in ink; drag a bar to move it, or drag its end to change the due date, staged with Save changes; with a focused bar, arrows move it a day and Shift+arrows change the due date. Cards without a start or a due date are listed under **Unscheduled** at the end, with "Add dates" for writers. Headers and names are sticky; Zoom and Group by sit in the toolbar. | — |
| BR76 | **Phone Gantt:** the bars stay, and only the panel scrolls sideways; names keep a 120px sticky column; phones open at Month zoom. The page never scrolls sideways. A tap on a row (44px) opens the card; drag is off on phones, so bars are not targets there; the card sheet changes dates. **Note (Gantt review, 2026-10-27; owner):** on phones the Gantt panel is at most the screen height under the header (`100dvh` less the 56px header) and scrolls inside, so the date axis stays on top while the rows scroll; a writer opens an Unscheduled card by tapping its row too. Pain point: on a long board the Save bar sits below the panel, a page scroll away. Possible solution, for a later decision: a save bar sticky at the bottom on phones. | A second phone layout to learn |
| BR77 | **(Owner) OpenView keeps Table, Grid, Gallery.** The Layout menu lists three; Group by stays for them; an address with `layout=kanban|calendar|timeline` opens Table. Supersedes DA11 (the six-layout menu), DA20 (layout empty states), OD4, and OD8. | Three layouts, their settings, and their empty states |
| BR78 | **(Owner) Saved views of those layouts are deleted** by a migration (data safety B). | Those saved views |
| BR79 | **Boards never change a record by drag.** A record card's stage and dates are the board's; a record-source chip is not draggable. Pain point: OpenView moved a record's status or dates by drag. Solution: the record sheet's Edit, or the module page (Group by shows records by status). | Drag-to-change-record (capability map) |
| BR80 | **Who sees Kanban and Gantt:** every reader of the board. With no stages, a manager sees a setup state that teaches by its layout ("Start with To do · Doing · Done" or "Add a stage"); others see "No stages yet · Board managers add stages." | — |
| BR81 | **Card activity** reads the audit log (as board Activity does, BR29), not a new table: every card change already writes an audit row, and a second log can disagree with it. | A second activity store |
| BR82 | **Board settings gains no Kanban or Gantt settings:** stages live in their headers, labels in the Labels menu, zoom and grouping in the toolbar. | Settings far from their effect |
| BR83 | **The record sheet is shared, not copied:** the OpenView record sheet (`live-record-inspector.tsx`) moves to a shared place that both OpenView and Boards import. | A second record sheet to maintain |

### Role states

| Account | Company board | Their department board | A project board | Kanban and Gantt | Observed or inferred |
| --- | --- | --- | --- | --- | --- |
| `ho-admin` | Manager | Manager | Manager | Stages, labels, cards | Company observed; rest inferred |
| `ho-manager` | Read | Manager (no Delete forever) | Per group level | Stages and cards on their department board | Company observed; rest inferred |
| `ho-writer` | Read | Post with a department write row; Read with module-only write | Per group level | Cards where they post | Company observed; rest inferred |
| `ho-reader` | Read | Read | Read | View and open | Company observed |
| `ho-guest` | Read | Read (capped) | Read (capped) | View and open | Company observed |
| `ho-noaccess` | Read | — | — | View on the Company board; locked record cards for records they cannot read | Company observed |

| Where | Reason text |
| --- | --- |
| Company board, Read | "Only admins post on the Company board." |
| Department board, Read | "Posting needs write access to Sales." |
| Project board, Read | "Posting needs write access through one of this board's groups." |
| Guest anywhere | "Guests can read only." |
| Archived board | The Archived chip; "Archived boards are read-only." |
| A stage menu, writer | Not shown; the header reads as text. "Board managers add stages." in the setup state. |
| A record card the viewer cannot read | "No access to this record" (no name) |
| Unknown or unreadable board, post, event, or card | "This board is not available." over "It may have been removed, or you may not have access." with Go to Company board; no Retry |

## Where each capability goes

**Boards today**

| Today | After |
| --- | --- |
| Overview widgets; Manage widgets | Removed (BE1); department dashboards |
| Configurations: export, import, Duplicate board | Removed (BE1) |
| Board picker | Sidebar rows (BR1, BR2) and All boards (BR3) |
| Manage Board; groups; Preview access; View activity | Board settings › Details, Access, Activity (BR26–BR29) |
| New project Board | All boards primary (BR30) |
| Posts feed, post dialog, post editor, Edit drafts, Manage posts | List and reading pane; state filter; editor dialog (BR10–BR14) |
| My events, Archived events | Show: Created by me, Archived (BR16, BR44) |
| Day card; `?event=` dialog; inline event editor | Event sheet and editor dialog (BR20, BR21) |
| Month and Agenda | Month, Week, Upcoming (BR51–BR56) |
| — | My calendar; record-date sources; card due dates; Kanban; Gantt |

**OpenView's three layouts**

| Capability | Home, or recorded removal |
| --- | --- |
| Kanban: lanes by a choice field, with server counts | **Removed** from OpenView (BR77). Records grouped by status: the module page's Group by on Table, Grid, or Gallery. Team work in stages: the board's Kanban (BR60). |
| Kanban: drag a card to change its choice | **Removed** (BR79). The record sheet's Edit, or Table. |
| Kanban: lane paging, card fields, card size | Group paging on the module page; card fields and size on Grid and Gallery. On a board: stage paging (BR67) and record cards' two fields (BR63). |
| Kanban: staged moves with Save changes, per-record errors | **Removed** with record moves; board moves save at once (BR65) |
| Timeline: records by start and end fields | **Removed** from OpenView. On a board: add record cards; their dates prefill from the record (BR63) and show on the Gantt. |
| Timeline: deadline and progress fields | **Removed**: the due date is the bar's end; progress is an objective's checklist (BR74) |
| Timeline: shift or resize a record's dates | **Removed** (BR79); the card's dates move on the Gantt (BR75); the record's own dates change in its sheet |
| Timeline: unscheduled records | The Gantt's Unscheduled list (BR75) |
| Timeline: window dates | Gantt navigation and zoom (BR72) |
| Calendar: records by a date field | A record-date source on a board calendar or My calendar (BR57) |
| Calendar: Month and List scales; range | Month, Week, Upcoming (BR51) |
| Calendar: undated records | The source menu's "Open records without a date" (BR57) |
| Calendar: drag a record to another day | **Removed** (BR79); the record sheet's Edit |
| Saved views of the three layouts | **Deleted** (BR78) |

## Backend changes needing your go-ahead

| ID | Change | Status | Contract | Cost |
| --- | --- | --- | --- | --- |
| BE1 | **Remove board widgets and portability** end to end (data safety A) | **Approved** (direction 1) | 9 operations on 7 paths go; `BoardActivityKind.WIDGET` and chart usage `kind: "board"` go; the live entity goes; one migration drops the table | About 15 app files; 7 backend test files deleted (51 tests); about 20 edited; 10 frontend files and 7 spec files deleted (71 tests); 9 contract cases; the OpenAPI snapshot |
| BE2 | **One read across boards for My calendar:** `GET /api/boards/occurrences?window_start&window_end&search&board_id…&limit&offset` over the active boards the person reads; each item carries its event and board | **Approved** (direction 2) | The 42-day window; the 500-series and occurrence limits apply **per board** and come back as a per-board status | A route beside `event_router.py:214`; about 8 tests; one frontend adapter and contract case |
| BE3 | **`next_occurrence`** on `GET /{board_id}/events/occurrences`, and per board in BE2 | **Approved** (owner answer) | The first occurrence after `window_end` over the same candidates, with a 366-day bounded lookahead (`event_occurrences.py:11`); null when none or over the limit | About 60–100 lines; about 4 tests in `test_event_occurrences.py` (16) and `test_event_occurrence_routes.py` (3) |
| BE4 | A department filter on the board list | **No change needed** | It exists: `boards/schemas.py:30`, `boards/router.py:152`; responses carry `level` | None |
| BE5 | Past widget rows in board Activity | **Consequence** | Board Activity lists a widget row only while its widget exists (`activity_router.py:131–138`); Manage › Audit keeps them | Part of BE1 |
| BE6 | **Remove OpenView's Kanban, Calendar, Timeline;** delete their saved views; strip seven presentation keys (data safety B) | **Approved** (direction 7) | `ViewPresentation.layout` keeps three values; seven fields go; `/records/window-query`, `/records/grouped-query`, and `/records/batch-update` stay | One migration and its test; `views/schemas.py`; sample packs (views 36 → 18, 42 → 21); about 6 backend test files; frontend about 4,000 lines deleted (three layouts, record moves); 29 HTTP and isolated tests deleted and about 20 trimmed; the OpenAPI snapshot |
| BE7 | **The board Kanban** (stages, cards, labels, checklists) and its reads for the Gantt and calendar | **Approved** (owner answer, 2026-10-26) | See the sketch below | About 6 tables in one migration; about 22 operations; about 2,000 backend lines and 80 tests; about 3,500 frontend lines (Kanban, Gantt, card sheets) and their tests; a Harbor and School demo Kanban |
| BE8 | **Record-date sources:** `board_calendar_sources` (`board_id` or `user_id`, `module_id`, `date_field_id`, `position`; at most 5 per owner) with `GET/POST/DELETE /api/boards/{board_id}/calendar-sources` (managers write, readers read the sources they can read) and `GET/POST/DELETE /api/me/calendar-sources` (per person and organization) | **Approved** (owner answer, 2026-10-26) | Records come from the existing window read, one per visible source and month; a field purge removes its sources (listed, never blocking) | One table and migration; about 6 operations; about 300 lines and 15 tests |

### BE7 sketch (approved)

**Tables** (all with `org_id`, row-level security, `created_at`, `updated_at`, `revision`, and the audit mixin):

| Table | Columns | Rules |
| --- | --- | --- |
| `board_stages` | `board_id`, `name`, `color` (`chart-1`…`chart-5` or null), `wip_limit` (null or ≥ 1), `card_sort` (`manual`, `due`, `newest`, `title`), `position`, `archived_at` | Unique active position per board; at most 20 active stages |
| `board_cards` | `board_id`, `stage_id`, `kind` (`objective` or `record`), `title` and `description` (objectives), `module_id` and `record_id` (record cards), `assignee_id`, `start_on`, `due_on` (dates), `rank` (order inside a stage), `archived_at` | `kind` decides which columns are set (a check); a record card's `record_id` follows the record-link purge pattern; one active card per record per board |
| `board_labels` | `board_id`, `name`, `color` (`chart-1`…`chart-5`), `position` | Unique name per board; at most 20 |
| `board_card_labels` | `card_id`, `label_id` | Unique pair |
| `board_card_checklist_items` | `card_id`, `text`, `done`, `position` | At most 50 per card |
| `board_attachments`, `board_record_links` (existing) | a new `card_id` | The exclusive check grows from two targets (event, post) to three |

**Routes** (under `/api/boards/{board_id}`, except where noted):

- Stages: `GET /stages` (with active card counts per stage, counted as the viewer), `POST /stages`, `PATCH /stages/{id}`, `PUT /stages/order`, `POST /stages/{id}/archive` (`cards: "move" | "archive"`, `target_stage_id`).
- Cards: `GET /cards?stage_id&assignee&label&due&search&limit&offset` (paged per stage), `POST /cards` (an objective, or a record card by `record_id`), `GET /cards/{id}`, `PATCH /cards/{id}` (fields, stage, rank, dates; with the revision), `POST /cards/{id}/archive`, `POST /cards/{id}/restore`, and `POST /cards/batch-dates` for the Gantt's Save changes, with per-card results (`updated`, `stale`, `forbidden`) in the `/records/batch-update` grammar.
- Labels: `GET/POST /labels`, `PATCH/DELETE /labels/{id}`. Checklist: `POST /cards/{id}/checklist`, `PATCH/DELETE /checklist/{item_id}`, `PUT /cards/{id}/checklist/order`.
- Files and record links: the existing attachment and record-link routes with a card target.
- Across boards: `GET /api/boards/cards/due?assignee=me&from&to` for My calendar's "My cards · Due".

**Access.** Managers own stages and labels; writers (post level) own cards; readers read. A record card's summary (name, two fields, status) is computed **per viewer at read time**; a viewer who cannot read the record gets `locked: true` and no record fields. Record summaries are never cached across viewers. Creating a record card needs read on the record.

**Around it.** New live entities `board_stages`, `board_cards`, `board_labels` in `BOARD_SCOPED_ENTITIES`; `AuditSession` on every mutation (card activity reads it, BR81); board purge and record or module purge as in data safety C; reset lists; sample packs seed a demo Kanban on Sales announcements (5 stages, about 12 cards, 3 labels) with pack counts.

### Recorded during P0 (2026-10-26)

- **Migrations:** `4e015d0fb2ab` (widgets removed), `b7e2c4a9d1f3` (Kanban), `c3f8d2e6a1b7` (calendar sources).
- **Kanban writes lock the board row but do not bump `board_revision`.** A drag must not make a post or event editor stale. Card files and record links reuse the post attachment routes, which bump both revisions, so the client refetches the card after a file or link change.
- **Record card summary:** the module's title field; the first live choice field as the status; the first two plain-text fields with a value. A locked card returns `{locked: true}` with no record or module id.
- **Files and record links belong to objectives only** (`card_objectives_only`); a record card's files and links are its record's.
- **Sources cap:** the 5-source limit counts sources the viewer cannot see, so a manager may be refused below 5 visible sources. The refusal names no module. Personal sources publish no live event.
- **`GET /api/boards/occurrences` pages at 100** (the shared pagination cap), so My calendar pages through a busy month.

### Recorded during P4a (2026-10-27)

Choices the code forced that the rows above leave open; each is the smallest that fits DESIGN.md.

| Choice | Removes |
| --- | --- |
| The Kanban reads the board's **complete** active card list (pages of 100 to the end, a 5,000-card guard) and filters, sorts and pages in the browser. A drop's `position` is an index into the stage's whole order, which a filtered or paged read cannot give. The Gantt (P4c) reuses the read. | Per-stage server pages and filters |
| A drop's place is the unfiltered index of the visible card below the slot; with no card below, the card is appended. A stage sorted by Due date, Newest or Title has no manual places: a drop appends and the sort draws it. Title sort runs in the browser (the server has no title sort). | — |
| The people filter holds one person (the server's `assignee` is one id). | Several people at once |
| Group by Label puts a card in the lane of its first label in board order. Grouped, a card drops only in its own lane (a lane is the card's assignee or label, which a move never changes); Add a card sits at the foot of each stage. Phones never group. | A card in two lanes |
| Stage settings open in a popover from the stage header (labeled fields cannot live in `role="menu"`); Move left and Move right are the keyboard path for column order (WCAG 2.5.7). | — |
| A record card's dates: the record's date and datetime values in field order (a datetime is its day in the workspace zone); one value is the due date, two or more prefill start with the first and due with the second, and the person picks from selects. | — |
| Until the card sheets (P4b), opening a card names it in the address (`card=<id>`) and shows a read-only summary popover; `openKanbanCard` in `server-backed-board-kanban.tsx` is the one function P4b replaces. A locked card never opens; a `card=` link to a card the viewer cannot open says "This card is not available." | — |
| (Owner, review) "Add a card" and the page line ("25 of 41 · Show 16 more") follow the last card as one block. On a long stage the block sticks to the stage's foot; on a short stage it sits under the last card. The drop cell keeps the stage's full height. Stages are 12rem to 17rem wide. | Add a card pinned to the foot of a short stage |

### Recorded during P4b (2026-10-27)

Choices the code forced in the card sheets; each is the smallest that fits DESIGN.md.

| Choice | Removes |
| --- | --- |
| **Gap closed (P4d): the assignee picker** lists the board's readers from `GET /api/boards/{board_id}/people`, searched on the server and read 100 at a time. | The stopgap list of the viewer, assigned people and post authors |
| The record sheet body (`shared/components/record-sheet.tsx`) is shared; its header is each page's own. A record card's header has the module eyebrow ("Quotes · record card"), the record's name and meta line, Edit and More record actions from the shared body, and "Close card". The comp's "From the quote" block is not drawn: the Details tab holds the record's fields. | A second record body |
| Copy link in either sheet copies the card's board address (`board`, `section=kanban`, `card`), never the viewer's filters. | — |
| Inside a sheet, saves and moves are announced inline ("Due saved.", "Moved to Done."), with no toast (Request feedback). Archive card closes the sheet, so it keeps the board's Undo toast. | Toasts under an open sheet |
| A pick (assignee, stage, a date, a label) saves on the card's latest revision; a typed edit (title, description) keeps the revision it began from, advanced only by the viewer's own saves, so another person's change in the meantime shows "Someone changed this card first." and the card is read again. Saves run one at a time. Dates save on leaving the field or on Enter. | Silent overwrites |
| A checklist tick shows at once; Move up and Move down in each item's menu order it (WCAG 2.5.7). | Drag-only checklist order |
| A `card=` link to an unknown, unreadable, locked or archived card opens the sheet with "This card is not available." over "It may have been removed, or you may not have access."; only a failed read (not a refusal) offers Retry. | The P4a toast |

### Recorded during P4c (2026-10-27)

Choices the code forced in the Gantt; each is the smallest that fits DESIGN.md.

| Choice | Removes |
| --- | --- |
| A zoom's period is a calendar unit, as on the Calendar tab: Quarter shows the whole weeks that touch the quarter ("Q4 2026"), Month the weeks that touch the month ("October 2026"), Week the anchor's week and the two after it. Previous and next step a quarter, a month, or a week; the period is the viewer's own and not in the address. The comp's Month (six weeks from the week before today) is not kept; the panel scrolls today into view instead. | A window that moves with today |
| A day is the panel's width shared by the days, never under 6px (Quarter), 14px (Month) or 40px (Week); below that the panel scrolls sideways. Names are 248px, 120px on phones. | — |
| A month with under a week in view keeps its solid line but no name, so names never overlap; a month's name stays at the panel's left edge while its days are in view. **Replaced at Quarter by the BR72 amendment (Gantt review).** | — |
| Each row has one control: on desktop the bar (writers drag it or its end, and move it by keyboard; Enter or a click opens the card for everyone), or the name while the bar is out of view; on phones the 44px row. A locked record card has none, and its bar is neutral. Bars are 24px tall (the WCAG 2.5.8 floor) in 40px rows. **Gantt review:** on a phone a writer's Unscheduled row has two targets, the 44px row (opens the card) and Add dates (BR76 note). | Two tab stops per card |
| The tints are the comp's: a label bar is its chart series at 52% with the checklist segment at full strength; a bar with no label is ink-muted at 34%; the summary bar is ink-muted at 16% with a hairline and its 36% segment. In dark looks the no-label bar reads lighter than the summary, as BR74 says; in light looks it reads darker, and the summary keeps its rank by its height, hairline and bold name. A staged bar takes a 2px warn ring (an unsaved change asks for attention). **Tints replaced by the BR74 shading (Gantt review); the warn ring stays.** | — |
| Group progress counts checklist items across the group's objectives (done ÷ total), not the mean of each card's share. A group with no dated card is left out. | — |
| Save changes sends at most 100 cards (the route's limit); a 101st change waits with "Save these changes first: one save holds 100 cards." A forbidden result carries no reason on the wire, so it reads "This card is no longer on this board, or you cannot read its record." Stale and forbidden cards leave the staged set and the board is read again; a failed request keeps every change. Results show inline above the save bar (Request feedback); "Dates saved." is announced. **Gantt review:** the 101st change is a warning (`role="status"`), not an error; after a save "Dates saved." and after Discard "Changes discarded · Undo" take the save bar's place in one muted line until the next change, and Undo restores the discarded set with its first revisions. A drag or an arrow key stops a bar at the window's edge with one day in view, and an arrow key there says why. A bar's name and tooltip add its first label and, while staged, ", unsaved, was <old dates>". | — |
| Phones group by stage and hide Group by, as the comp draws them; zoom is kept in the address on every size. | — |
| "Add dates" opens the card sheet with its first date field (Start, or Card start on a record card) focused. | — |

### Recorded during P6 (2026-10-27)

Choices the brief and comps left open; each is the smallest that fits DESIGN.md.

| Choice | Removes |
| --- | --- |
| BR31 on phones: row 1 is the mark, the title and the level chip; the title wraps as many lines as it needs and is never cut. Row 2 is Board settings (44px icon) and the tab's primary. The meta line ("Sales roles read and post", "Every board you can read.", "4 boards") shows from 640px only; a refresh error still shows. The comp's settings icon on row 1 and its cut title are not kept (the brief wins). | A cut title; a third header row on phones |
| Words: board, record, event, and workspace are lower case inside a sentence; "Boards" (the workspace) and "Board settings" keep their capital because they start a label. The glossary's Term column still writes "Board"; it does not set UI case. | "This Board is archived", "No linked Records." |
| Purge reads **Delete forever** (BR20, BR27): the Advanced block and its heading, a file row, an archived event; the final buttons name their object ("Delete board forever", "Delete file forever", "Delete event forever"), and the typed name and password stay. The shared purge review (`lifecycle-purge-review.tsx`, used by OpenView and the Sandbox) keeps its own words. The glossary still says "permanently delete" for purge (rows Purge and archive / close / delete). Owner decision (2026-10-27): Boards keeps "Delete forever"; the glossary, DESIGN.md and the shared purge review follow in a separate change. | "Permanently delete", "Confirm permanent deletion" |
| Gantt: the Today chip sits in the month row over its line, so it covers no week label. On the first two or three days of a month it can sit over the start of that month's name. | The chip over W labels |
| Gantt: "No dates" and the out-of-view hints sit on the card fill above the grid lines. | A line through the text |
| The card sheet's title field is a plain input in the sheet title's type (18px, weight 600), with an edge only on hover and focus, so the slim field skin does not make it a 32px, 14px field. | The small-field look |
| **(Owner, final review D1) Board groups save at once**, as DESIGN's Access grants list does: adding a group, changing its level and Remove each send the whole set with the board revision. The row says "Saved." or its error; Remove leaves "Removed <group> · Undo"; a stale revision says "Someone changed this board first." and reads the groups and the board again. With no staged draft, Close needs no guard for groups. | "Save groups", "Discard changes" and staged group rows |
| (Owner, final review D2) One set of level words: the group select says Read, Post, Manager (the values stay `read`, `write`, `manage`), a manager who is not an admin reads the level chip, and the hints say what each level adds on posts, events, cards, stages and labels. | Read · Write · Manage beside the chip's Read · Post · Manager |
| Final review choices: one sheet width, 40rem (the OpenView record sheet and the card sheet), for the event, card and settings sheets; the record-link select is "Module"; Check a person cannot tell a guest from a member, so every Read reason adds "Guests read only."; after Remove, focus goes to the next row, else the row before, else Add a group. | 34rem and 42rem sheets; "Data source" |

## Comps

Comps draw the novel parts only, in Slate dark with Harbor content and the sidebar's Announcements rows. Serve them over HTTP from `.impeccable/mocks/boards/` (`python3 -m http.server <port>`). They reuse the OpenView comp kit (`openview.css` as a symlink, the icon sprite with calendar, Kanban, and Gantt icons, and the `_next`/`app-out` links to the app's tokens). New classes start with `bd-`.

| Comp | Switches |
| --- | --- |
| `posts.html` | `?reader=1`, `?reason=1` |
| `calendar.html` | `?view=week`, `?view=upcoming`, `?empty=1` |
| `my-calendar.html` | `?view=week`, `?partial=1` |
| `kanban.html` | `?stagemenu=1`, `?drag=1`, `?card=objective`, `?card=record`, `?reader=1`, `?setup=1` |
| `gantt.html` | `?zoom=month`, `?staged=1` (a resized bar with Save changes) |

| Render | Shows | Why this is easier |
| --- | --- | --- |
| `posts-1440.png` | Sidebar A with the Announcements row; the title row, the four tabs, Posts with the state filter and the reading pane | A board is one click away and named; drafts and scheduled posts sit where they will appear (BF-1, BF-9) |
| `posts-reader-1440.png` | A reader: the Read chip and "Posting needs write access to Sales." | The level says why there is no New post, instead of "Post editing is unavailable" (BF-12) |
| `posts-390.png` | Phone: the title row with the settings icon, the primary, the tabs, and the first post on the first screen | The first post was at y≈607 (BF-27) |
| `kanban-1440.png` | Five stages drawn on the board surface; objectives and record cards; one locked card; "6 / 5" over its WIP limit; Add a card and Add a stage | Stages sit side by side with their counts; OpenView showed one lane at a time under a grid of lane buttons (LF-3) |
| `kanban-1280x720.png` | The same at 1280×720; only the board scrolls | Still page at the smallest desktop |
| `kanban-stagemenu-1440.png` | The stage menu: name, color, WIP limit with its overrun line, sort, Move left or right, Archive stage | Every stage control is on the stage itself |
| `kanban-drag-1440.png` | A card mid-drag: the lifted card, the tinted target stage, the dashed slot; the Undo toast of the last move | The drop target is obvious; OpenView moved cards with a handle button or a menu (LF-3) |
| `kanban-compose-1440.png` | The inline composer: a card title or Find a record | Both card kinds start from one place |
| `kanban-card-objective-1440.png` | The objective sheet: Move to stage, label-left details, checklist with progress | — |
| `kanban-card-record-1440.png` | The record sheet with "On this board" first, the board-only consequence line, and the quote's own facts | The record keeps one sheet; the board's controls sit on its first tab |
| `kanban-390.png` | Phone: the stage switcher with counts, one stage's cards | No sideways board on a phone |
| `gantt-1440.png` | Quarter zoom: months and W1–W5, dotted weeks, solid months, two stage groups with summary bars, label colors, progress segments, one record card, the today line, Unscheduled | One shared axis; nothing to read inside bars; OpenView had a track per record, date inputs, and progress as text (LF-4) |
| `gantt-1280x720.png` | The same at 1280×720; only the panel scrolls | Still page at the smallest desktop |
| `gantt-390.png` | Phone: Month zoom, 120px sticky names, bars that scroll inside the panel | The page never scrolls sideways |
| `calendar-month-1440.png` | Month with the rail: week numbers in Monday's cell, ink titles with color rules and right-aligned times, multi-day pills, a record source (outlined) and card due dates (dashed) | Titles read on two lines; the empty grid and the "1 event" lines are gone (BF-14, BF-19, LF-5) |
| `calendar-month-1280x720.png` | Month at 1280×720 with the rail folded into Calendars; "+n more" where a day is full | Legible at 1280 (BR55) |
| `calendar-week-1440.png` | Week: hours, the all-day row, blocks by duration, overlaps side by side, the now line | Time of day shows as position, not text |
| `calendar-week-1280x720.png` | Week at 1280×720 | — |
| `calendar-empty-1440.png` | October empty: "No events in October · Next: Mon, Nov 2 →" | An empty month no longer looks like an empty board (BF-14) |
| `calendar-month-390.png` | Phone Month: the 7-column grid that fits 390, colored dots, the selected day's items | The grid was 593px wide (BF-15) |
| `calendar-week-390.png` | Phone Week as a day list: the 7-day strip and the day's items | — |
| `my-calendar-month-1440.png` | My calendar Month: 12 board calendars in the list, My cards, one record source | Every board's dates in one place, each named in the list |
| `my-calendar-week-1440.png` | My calendar Week: blocks name their calendar | Sales and Purchasing share violet; the names tell them apart |

Measured on the renders: no document scroll at 1440×900 or 1280×720 on any desktop comp; no page-level sideways scroll at 390; targets at 390 are at least 44px, except Gantt bars, which are not targets on phones (BR76).

**Described, not drawn** (known patterns): the Board settings sheet; the post and event editors (the shared dialog frame); the event sheet; Archive and Delete dialogs; All boards (the Access row grammar); the Gantt and Kanban group-by swimlanes; the "+n more" day popover; the record-source picker (a framed dialog with Module and Date field selects).

## Phases

Each phase ends with tests that fail first, one code review, targeted screenshots (no sweep; the owner checks the live app), and the budget spec when the shell changes. A hands-on feature pass follows each phase that changes what people see.

| Phase | Content | Proof (tests that own it) | Exit |
| --- | --- | --- | --- |
| **P0** Backend | BE1 with FN1 (and the frontend Overview removal); BE2; BE3; **BE7 and BE8** (they gate P4 and P5) | BE1: the migration test; `charts/test_usage.py`, `charts/test_widget_reference_races.py`, `lifecycle_integration/test_chart_*`, `boards/test_activity.py`, `test_lifecycle.py`, `test_permanent_delete.py`, `reset_application_data/test_reset_table_parity.py`; deleted widget and portability tests (51). BE2 and BE3: a new test file and `test_event_occurrences.py`, `test_event_occurrence_routes.py`. BE7: route, access (manager, writer, reader, guest, locked record card), purge, reset, and batch-dates tests. Frontend: `boards-route-cutover.spec.ts` (23) and `boards-navigation.spec.ts` (4); deleted specs (71); `test_openapi_snapshot.py` | FN1 for `ho-manager` and `ho-noaccess`; no request to a removed route; sample runs pass |
| **P1** Sidebar and header | The budget plan; the sidebar rows (BR1–BR5, BR41, BR47); the header and tabs (BR6, BR7, BR50); BR9; BF-7; All boards | `isolated/workspace-navigation.spec.ts` (21), `isolated/department-navigation.spec.ts` (4), `http/department-navigation.spec.ts` (7), `http/workspace-orientation.spec.ts` (4), `comms-js-budget.spec.ts` at 548,000 | Cold Comms JavaScript under 548,000 locally and in CI; cold `/boards` at most 34 requests, the board list and the open board read once each |
| **P2** Posts | BR10–BR15, BR38 | `boards-live-posts.spec.ts` (30), `boards-live-attachments.spec.ts` (7), `isolated/boards/live-posts` (10), `live-post-editor` (12), `live-post-lifecycle` (3), `post-editor-state` (12), `board-posts-api` (10), `board-post-author-api` (6); `?post=` links | No document scroll at 1280×720 and 1440×900 |
| **P3** Calendar and My calendar | BR16, BR19–BR22, BR35, BR43, BR44, BR51–BR59, FN2; record-date sources (BR57, BE8) and card due dates (BR58, after BE7) | `boards-live-calendar.spec.ts` (13), `isolated/boards/live-calendar` (27), `board-events-api` (13), `board-scope-rules` (4); `isolated/openview/window-api.spec.ts` for the source read; new journeys: My calendar with one refused board; a source the viewer cannot read stays hidden | Month titles legible at 1280×720 (no clipped time, two-line titles where the day has room); no document scroll at 1280×720 and 1440×900 |
| **P4** Kanban and Gantt, and the OpenView removal | BR60–BR76, BR79–BR83 on the BE7 routes; **in the same phase** BE6 and BR77–BR78 (OpenView keeps three layouts; the saved-view migration), so no capability is missing between phases | New Kanban and Gantt HTTP journeys (stage CRUD as manager, card add and move as writer with Undo, read-only reader, locked record card, keyboard drag, WIP overrun, Gantt staged resize and Save changes, Unscheduled); isolated rank, grouping, and progress rules; the OpenView removals and trims in data safety B; `url-state.spec.ts` for old layout links | Every capability in the OpenView map has its home or its recorded removal; the Layout menu lists three; no saved view of the three layouts remains |
| **P5** Board settings | BR26–BR30, BR34, BR37, BR82 | `boards-live-management.spec.ts` (10), `isolated/boards/live-management` (12), `board-management-api` (14), `live-access-preview` (4), `live-activity` (5), `board-tools-api` (10), `live-collection` (11) | Archive asks once; Restore is neutral |
| **P6** Phones, words, review | BR31, BR32, BR46, BR59, BR71, BR76; the words; critique, `ui-reviewer`, and the hands-on passes | A 44px sweep at 390 per tab; the glossary guard; `theme-parity.spec.ts` (the Kanban canvas in four looks); `fullstack/smoke/boards.spec.ts` (3) | The exit criteria |

## Exit criteria

| Exit | Criterion |
| --- | --- |
| EXIT-1 | Posts, Calendar (Month and Week), Kanban, Gantt, My calendar, and All boards do not scroll the document at 1280×720 or 1440×900; only panels scroll. |
| EXIT-2 | From 1280px, controls are 32px and rows 40px, with four exceptions: the Posts list's two-line rows (BR11); Month cell targets (day numbers, chips, bars, and "+n more"), which are 24px, the WCAG 2.5.8 floor, so six week rows stay legible at 1280×720 (BR55); Kanban cards, which are as tall as their content (labels, a two-line title, record fields, one fact line; BR67); and Gantt bars, which are 24px (the WCAG 2.5.8 floor) in 40px rows and are not targets on phones (BR76); at 390, every target is at least 44px and nothing scrolls the page sideways (the Gantt panel may). |
| EXIT-3 | No request to a removed route from any page; FN1 holds for every role. |
| EXIT-4 | Every capability in both maps has its home or its recorded removal, for each role that has it now; every URL in Preserved behavior opens the same thing. |
| EXIT-5 | Cold Comms JavaScript stays under 548,000 gzip bytes locally and in CI. |
| EXIT-6 | OpenView's Layout menu lists Table, Grid, Gallery; the migration test shows no saved view of the three layouts, no stripped key left, and an untouched Table view; `layout=kanban` opens Table. |
| EXIT-7 | Readability: Month titles read at 1280; Kanban stage headers show name and count, cards carry no field labels, and the drop target shows; the Gantt shows a summary bar per group, a today line, and an Unscheduled list. |
| EXIT-8 | A critique scores at least 28/40 with no P1. |
| EXIT-9 | Each finding has a test that failed first, or a recorded reason; focused batches pass; the gate passes before the push. |
| EXIT-10 | A release smoke pass on a fresh organization and on Harbor finds no blocking defect for any hands-on account, including two-account live delivery of a post, an event, and a card move. |
| EXIT-11 | The owner reviews the live app and approves the result. |

## Risks

- **Two kinds of card can confuse people.** Solution: a record card carries its module name and the record icon; an objective carries its checklist or labels.
- **Data loss is permanent** in two migrations (widgets; saved views). Solution: data safety A and B, the caution, and downgrades that never claim to restore rows.
- **A new feature inside a relayout.** BE7 is the largest backend change here. Solution: it lands in P0 behind its own go-ahead and gates P4; P1–P3 do not depend on it, except "Cards · Due" in P3.
- **Record cards and access.** A record card on a board that many people read could leak a record. Solution: summaries are computed per viewer at read time, never cached across viewers, and a locked card shows no name.
- **Color repeats.** Four department hues cycle, so in Harbor Sales and Purchasing are both violet in My calendar. Solution: the calendar list, the tooltip, the accessible name, and Week blocks name the calendar; the checkboxes hide one of them.
- **The Name Beside Color exception** (BR53) is recorded in DESIGN.md (2026-10-26) as the rule's second exception, for calendar month cells.
- **Test churn.** About 122 tests go with widgets and portability, and 29 with the OpenView layouts; about 20 OpenView tests and the 87 remaining Boards HTTP tests change. Solution: every removed assertion gets a ledger row; P0 and P4 delete, the other phases update.
- **The large OpenView file.** Removing the layouts and record moves touches `server-backed-views-workspace.tsx` (4,060 lines). Solution: removal only, no refactor (OD15).
- **My calendar volume.** Twelve boards, weekly series, card due dates, and up to 5 sources. Solution: per-board limits (BE2), one cross-board card read, and one window read per visible source and month.
- **Sidebar visibility and DA2.** A person with a department role but no readable module sees no department group. Solution: All boards lists every readable board.
- **A new skin place.** `data-skin="board-surface"` (BR66) needs a frame rule in each look's stylesheet and a `theme-parity.spec.ts` case. Solution: impeccable adds it with the four looks in P4.

## Could not verify

- The local 546,585 bytes and the CI offset of about 1,000 come from the brief.
- The byte costs are simulated on the built chunks, not measured from a build.
- BE7 and BE8 costs are estimates from comparable code (posts, events, record links), not a design spike.
- "Read-mode type measure" has no named token; BR38 uses DESIGN.md Body and the Profile Bio's 65ch.
- Test counts come from a grep of `test(` and `def test_` lines.
- The role rows marked "inferred" come from `access.py`, not the live app.
- The comps show more posts, events, and cards than Harbor seeds, to show each grammar.
- The baseline numbers are the analysis's.
- The comps' stages, labels, and cards are invented Harbor-like content; the packs seed none yet (BE7 adds a demo Kanban).
- The Gantt's W1–W5 labels assign a week to the month that holds its Thursday (the ISO rule); the owner's reference does not say which rule it uses.
- A product observation from the comps: `[data-skin="canvas-frame"]` resets the text size against the device text scale, so the Sandbox canvas ignores the person's text-size setting by design. BR66 keeps the Kanban out of that rule.
