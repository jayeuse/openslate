# OpenView: department pages and the slim identity (umbrella)

> **Status: direction approved (2026-10-25); parts A, B, and C approved (2026-10-26).** This file holds the owner's direction, the Phase 0 baseline, the critique, the findings, and the slim decisions OD1–OD15 that the parts reuse. Each part has its own spec. Comps are in `.impeccable/mocks/openview/` (renders in `.playwright-mcp/openview-relayout/comp/`). No product code has changed.

## Direction (owner, 2026-10-25)

OpenView becomes the departments' own pages. The owner chose each of these from the recommended options:

- **Sidebar.** Departments replace the OpenView item. Each department is a collapsible group with its Dashboard and one page per module (Sales: Customers, Contacts, Quotes, Sales Orders). The tools (Sandbox, Boards, Access, Manage, Platform) follow.
- **Dashboard.** One per department, its home, configured by the department's managers. A fixed grid of 4 columns and 5 rows that managers arrange, with presets and size rules per widget type. Widgets are graphs built from the modules the department can read, including linked departments.
- **Charts.** No page: a large chart-builder dialog, opened from Add widget.
- **Reports.** A Reports tab inside each module page.
- **Order.** Part A, then B, then C.

| Part | Spec | Content |
| --- | --- | --- |
| A | `docs/specs/openview-department-pages.md` (approved 2026-10-26) | Departments in the sidebar, module pages, the Views decisions below |
| B | `docs/specs/openview-dashboard.md` (approved 2026-10-26) | The department Dashboard: the 4×5 grid, presets, size rules, the chart-builder dialog, and the backend changes (placement, linked sources, one home) |
| C | `docs/specs/openview-reports-in-modules.md` (approved 2026-10-26) | Reports inside module pages; the Reports page and the OpenView item go (no backend change) |

Sections below that describe Charts, Dashboards, and Reports as pages (OD2, OD9–OD11, and their layout direction) are the relayout plan before this direction. Parts B and C replace them; they stay here as the record of the baseline.

## Outcome

OpenView uses the slim grammar that Access, the Sandbox, Manage, the shell, and Profile already use (DESIGN.md "Slim controls"):

- slim controls (32px from 1280px) and 40px one-line rows
- label-left rows in panels and sheets
- quick filters, with the Filters popover and chips
- summary first, then detail; two panes where a list and a detail meet
- still pages from 1280px: only panels scroll
- quiet actions with one primary action
- framed dialogs with a named close and a pinned footer
- 44px targets on phones

A person sees their records at once. They find, filter, and open a record without scrolling past controls. Each account sees only what it can use, and an account with nothing to read is told why.

**In scope.** The OpenView page (`/openview`) and its four sections: Views, Dashboards, Charts, and Reports. The scope covers:

- their dialogs, sheets, popovers, and menus
- their empty, no-access, and error states
- their 390px layouts
- their words

**Out of scope.**

- Other pages.
- Backend contracts, schema, and wire formats.
- New capabilities: sorting by a click on a column head, a date quick filter ("This week"), automatic chart preview, new layouts.
- Merging the four sections into one surface. The critique asked about it; it is a product change, not a layout change. The owner may raise it later.

**Preserved behavior.**

- Every capability stays reachable, for every role that has it now.
- URLs and their values stay the same: `?section=`, `?module=`, `?view=`, `?record=`, `?dashboard=`, `?report=`, and the view state that lives in the URL. Links from Boards, Platform search, and notifications keep working.
- Saved views, drafts, the unsaved-changes guards, conflicts, exports, chart snapshots, dashboard refresh, report runs, and schedules behave as they do now.
- Charts keep the explicit Apply. The table and exports keep the last applied result.
- Server refusals stay the source of truth.

## How the issues were found

1. **Baseline capture.** 29 states at 1440×900, 1280×720, and 390×844 in Slate dark, with Harbor Operations Group data, signed in as `ho-admin` on the dev stack (`.playwright-mcp/openview-relayout/baseline/`). Nothing was saved.
2. **Baseline numbers.** `.agent-runtime/openview-relayout/metrics.json` and `ux-analysis.md`.
3. **Role pass.** The four sections as `ho-reader`, `ho-guest`, `ho-manager`, and `ho-noaccess` (`role-ho-*` captures).
4. **UX analysis (`ui-ux-pro-max`).** Findings and the layout direction (`.agent-runtime/openview-relayout/ux-analysis.md`).
5. **Design critique (`impeccable critique`).** Two isolated assessments: a design review and the detector with a browser overlay. Score 17/40, one P0, three P1. Archive: `.impeccable/critique/2026-10-25T15-31-58Z__s-openview-components-workspace-route-tsx-76fdd495.md`.
6. **Comps.** Views and Charts, built on the app's current tokens.

## Baseline (Phase 0)

| Measure | Views | Charts | Dashboards | Reports |
| --- | --- | --- | --- | --- |
| Document scroll at 1280×720 | 1912px | 63px (1558px after Apply) | 1619px | 590px |
| Document scroll at 1440×900 | 1732px (Grid 4421px) | 0 (1558px after Apply) | 1267px | 410px |
| First record row at 1440 | y≈800 of 900 | — | — | — |
| Fields and buttons (median, 1440) | 44px | 44px | 44px | 40–44px |
| Rows | 69px | 37px | 61px (widget tables) | buttons, 50px |
| Muted helper words (1440) | 58 (70 with filters open) | 57 (83 after Apply) | 127 | 60 (74 with a report open) |
| Document scroll at 390 | 2352px, no record on the first screen | 275px | 3043px | 710px (1151px with a report open) |
| Targets below 44px at 390 | none material | none | none | Show archived checkbox (16px) |
| Horizontal overflow at 390 | none | none | none | none |
| Critique | 17/40: consistency (4) 1, minimalism (8) 1, real-world match (2) 1 | | | |

The code: `min-h-11` (44px) appears 339 times in OpenView. Only `LoadingRegion` comes from the slim kit; there is no `slim-ui`, no dialog frame, no `DisabledReason`, and no `StatusWord`.

## Findings

| ID | Pri | Area | Finding |
| --- | --- | --- | --- |
| OV-F1 | P0 | Views | The records are below the controls. At 1440 the first row starts at y≈800 of 900; on a phone the first screen shows no record. Four control bands come first: the data-source card, the view header, the search and sort card, and the filter row with New record, Columns, and Layout settings. More filters opens inline and pushes the table down. The page scrolls 1912px at 1280×720 (`server-backed-views-workspace.tsx:2531–3221`). |
| OV-F2 | P1 | Every section | Empty states ignore the role. A member with no readable module sees "Nothing published yet… Design your modules in the Sandbox" with Open Sandbox; the modules are published and the member has no Sandbox (`server-backed-views-workspace.tsx:2399–2420`). Charts shows the whole editor and a disabled Apply over "No authorized data sources are available." Dashboards says "Create one to get started" with no create button (`server-backed-dashboards.tsx:1411`). Reports says "create your first Report" with no New Report (`saved-reports-panel.tsx:125`). |
| OV-F3 | P1 | Views | View actions opens an empty menu on an unsaved view: every item needs a saved view (`server-backed-views-workspace.tsx:2933–3010`). |
| OV-F4 | P1 | Dialogs | Dialogs do not use the shared frame. Record details shows three helper sentences, puts Delete record beside Edit record, changes height on each tab, and clips its tabs at 390. Columns clips its footer at 1440 and repeats each field name ("Show Name", "Pin Name"; 40 tab stops for 10 fields). New report disables Create with no reason and puts Close at the far right. |
| OV-F5 | P1 | Charts | Charts opens on a meaningless chart: the default Group by is the first categorical field (`domain/chart-query.ts:308`), which is Name, so the result is 30 bars of 1. Save chart and Apply chart are both filled primaries, and Save is offered before any result (`saved-chart-management.tsx:415–422`, `server-backed-charts.tsx:925`). The saved list opens inline and pushes the editor down. |
| OV-F6 | P2 | Every section | Chrome before content. Each section opens with a title and a one- to two-sentence intro, then stacked cards; cards nest three deep (Record results inside View controls; the summary card inside a widget card). "Unsaved view" shows three times. |
| OV-F7 | P2 | Every section | Pre-slim controls: 44px label-above fields, outline buttons, no slim skin. |
| OV-F8 | P2 | Views | Six full-width layout tabs read as navigation and exceed four options at one decision. Kanban, Calendar, and Timeline open on "Choose an active queried field…"; the field is chosen only in Layout settings. |
| OV-F9 | P2 | Views | Rows are 69px. Record names are blue link buttons, people are underlined blue links, and Email is cut at the right edge. Dates read "2026-01-11" in the record and "Jan 11, 2026" in the table. Only the name opens a record, not the row. |
| OV-F10 | P2 | Dashboards | The picker sits in a card with two labels and a revision sentence. Managers get three widget buttons. Each widget repeats "Current results from the selected data source.", shows a size kicker ("Summary · M"), and carries a full pager with Rows per page, even for three rows. |
| OV-F11 | P2 | Reports | Each saved report is a bordered button with a cut name and its own Duplicate button (12 Duplicates). The detail is a 480px card beside about 330px of empty page. "Available outputs" (saved runs shared with you) is a button at the foot of the list. The Reports and saved-chart lists mark the selection only by style: no `aria-current` or `aria-selected`. |
| OV-F12 | P2 | Words | "Inline query", "aggregate snapshot", "queried field", "DATE or DATETIME", "frozen bytes", "retained output", "eligible to open", "All conditions (AND)", "These changes live in the page address", "Live records", "Complete aggregate data", "numeric approximations". |
| OV-F13 | P3 | Phones | Views needs 2352px of scroll on a phone, Dashboards 3043px. |

## Layout direction

**One section header.** Every section uses the same header:

- The title names what is shown. In Views it is the data source, and the title is also its picker. In Charts it is the chart; in Dashboards, the dashboard; in Reports, the section.
- One 14px muted meta line says what is shown and its state ("Sales · 30 records"). An "Unsaved changes" chip joins it when the view changed.
- Pickers sit in the header row as slim searchable selects (saved view, dashboard, saved chart).
- Actions are quiet. There is at most one primary action.
- No intro sentence, no source card, no repeated name.

**Views: a header, one toolbar, the table, and a sheet** (comp `views.html`).

- Header: the source title, the saved-view picker, Export, a "More view actions" menu, and one primary: New record for writers, or Save view when the view has unsaved changes (with "Save as new view" beside it). The menu holds Archived views, Copy link, and Reset changes, so it is never empty.
- One 40px toolbar row: search, a status quick filter with counts, Filters, Sort, Columns, and the Layout picker at the right.
- Filters opens a popover from 768px (a bottom sheet below): Match (All conditions or Any condition), one row per condition, Add condition, and Deleted records (Hide, Include, Only deleted). Active filters show as chips under the toolbar, with Clear all.
- The table panel fills the page; only its body scrolls; the pager stays at the bottom (PD66). Rows are 40px and one line. The whole row opens the record. The name is weight 500 in ink; people are a 24px avatar and the name in ink. One date format everywhere.
- The record opens in a right sheet, as a person does in Access: the name, one facts line, Previous and Next, a quiet Edit, a "More record actions" menu with Delete in danger ink, and a named close ("Close record"). Tabs: Details, Linked records, Files, History. Details uses label-left rows.
- Kanban, Calendar, and Timeline keep their place. When the view has no field for them, the empty state holds the field picker itself.

**Charts: two panes** (comp `charts.html`).

- Header: the chart name (a new chart takes a name from its setup, "Contacts by status"), the meta line with "Not saved" when it is not saved, "Open saved chart", "Save as…", and Save chart.
- Setup pane (340px): label-left rows Records, Chart (Bar, Line, Pie), Group by, Show, Filters, Dates, Order. Apply sits in the pane footer with a status ("Showing this setup" or "1 change not shown yet").
- Result pane: the chart, then its values as 40px rows.
- One primary at a time: Apply while a change waits, Save chart once a result is shown. A disabled Save says why.
- Group by starts on the first choice field of the records, or on nothing with "Choose what to group by".

**Dashboards: a header and the widget grid.**

- Header: the dashboard name with its department chip, the dashboard picker, and for managers one primary (Add widget) and a menu (Add from saved chart, Refresh now, Dashboard options; Archive in danger ink).
- Widgets: a 40px head with the title and its menu. No repeated sentence and no size kicker. A table widget keeps paging with a compact pager ("1–3 of 3", previous, next); Rows per page shows only when there are more rows than the smallest page. The summary widget is not a card inside a card.
- The grid is the scroll panel.

**Reports: list and detail panes** (the Sandbox Triggers grammar).

- List pane: search, a segmented control (Reports, Shared outputs), a department filter, and 40px rows (name, department chip, state of the last output). The selected row takes the tint and `aria-current`. Archived reports are a list filter.
- Duplicate, Archive, and "Start from this report" move to the detail's menu.
- Detail pane: the report name and one meta line (records, department, columns), Run now as the primary, a quiet Edit, and the tabs Saved outputs and Schedule.

**Dialogs.** Every OpenView dialog uses the shared frame (`ui/dialog-frame.tsx`): a pinned header with a named close, a pinned footer with the primary at the right, and a reason on a disabled primary (`DisabledReason`). Columns shows one row per field: a checkbox, a pin toggle, and a move menu.

**No access.** One state for all four sections when the account can read nothing: "No records to show yet" over "You do not have access to any department's records. An administrator can give access in Access › Groups." No editor, picker, or create action. An administrator with nothing published keeps the Sandbox action. A create action shows only to those who can create.

**Phones.** Two short header rows (title, then the primary and the menu). The toolbar is search, Filters (a bottom sheet), and Layout. Rows are two lines. Sheets are full screen. In Charts the panes stack, and Result comes first after Apply.

## Decisions

Proposed under the relayout delegation; each names what it removes.

| ID | Decision | Removes |
| --- | --- | --- |
| OD1 | One section header for all four sections (Layout direction). | Page intro sentences; the data-source card; the dashboard picker card; the repeated "Unsaved view" titles. |
| OD2 | ~~Keep four sections.~~ Replaced by the direction above (department pages). | — |
| OD3 | Views toolbar in one row: search, quick filter, Filters popover with chips, Sort, Columns, Layout. | The inline More filters panel; "No active filters"; the search-and-sort card. |
| OD4 | The layout is a select with six options and their icons, not tabs or a segmented control. | Six full-width tabs. |
| OD5 | Save model: the "Unsaved changes" chip, then Save view (primary) and "Save as new view". Otherwise New record is the primary. Export sits in the header; Archived views, Copy link, and Reset changes move to the menu. | "Temporary changes" with "These changes live in the page address"; the filled Save view as at rest; the empty View actions menu. |
| OD6 | 40px one-line rows; the whole row opens the record; people as avatar and name in ink; one date format. | Blue name buttons; underlined people links; the 69px rows. |
| OD7 | The record opens in a right sheet. `?record=` links are unchanged. | The centered dialog; its three helper sentences; Delete beside Edit; the height jump between tabs. |
| OD8 | Kanban, Calendar, and Timeline show their field picker in their empty state. | "Choose an active queried … field" with no control. |
| OD9 | *(Replaced by part B: a chart-builder dialog.)* Charts in two panes with explicit Apply; one primary at a time; Group by starts on a choice field. | The "Chart source: Inline query" select; two filled primaries; the inline saved list; the snapshot sentences; 30 bars of 1. |
| OD10 | *(Replaced by part B: the 4×5 grid.)* Dashboards: header picker, one primary, compact widget pagers, no repeated widget sentence. | The picker card and revision sentence (the revision moves to Dashboard options); the size kicker; full pagers on short tables; the nested summary card. |
| OD11 | *(Replaced by part C: Reports in module pages.)* Reports in list and detail panes; Shared outputs as the second list. | Per-row Duplicate buttons; the "Available outputs" foot button; the 480px detail card. |
| OD12 | All OpenView dialogs on the shared dialog frame. | Unframed dialogs; Close at the far right; disabled Create with no reason. |
| OD13 | One no-access state; create actions only for those who can create. | "Nothing published yet" for members; Open Sandbox for accounts without the Sandbox; the editor with no sources. |
| OD14 | The quick filter in Views uses the first choice field of the records, with counts from the existing grouped-count read (the one Kanban lanes use), cached per view. No choice field, no quick filter. | — |
| OD15 | Extract only along the seams this layout needs (header, toolbar, record sheet) from `server-backed-views-workspace.tsx` (4060 lines). State owners stay where they are (frontend/AGENTS.md). | — |

## Shared files outside OpenView

| File | Why it changes | Guard |
| --- | --- | --- |
| `ui/search-filter-toolbar.tsx` | The one-row toolbar | Access, Manage tests that use it |
| `ui/table-pagination.tsx` | The compact pager for widgets | Every table with a pager |
| `ui/dialog-frame.tsx` | Used, not changed (unless a gap shows) | Sandbox, Manage dialogs |
| `person-card.tsx` | People in rows open the person card | `comms-js-budget` (it is in the cold Comms bundle) |

## Phases

Each part's spec holds its phases. Part A: `docs/specs/openview-department-pages.md`.

## Exit criteria

| Exit | Criterion |
| --- | --- |
| EXIT-1 | Critique at least 28/40 with no P1. |
| EXIT-2 | The four landings do not scroll the document at 1280×720 and 1440×900; only panels scroll. |
| EXIT-3 | The first record row is above y=300 at 1440 and on the first screen at 390. |
| EXIT-4 | From 1280px, controls are 32px and rows 40px in every section. |
| EXIT-5 | Targets are at least 44px at 390; no horizontal scroll. |
| EXIT-6 | Every capability stays reachable for each role; every URL in Preserved behavior still opens the same thing. |
| EXIT-7 | Each finding has a test that failed first, or a recorded reason. Focused batches pass, and the budget stays under its limit. |
| EXIT-8 | A hands-on pass by role finds no blocking defect. |
| EXIT-9 | The owner reviews the live app and approves the result. |

## Risks

- **Test churn.** About 276 HTTP tests in nine `openview-*` files and 24 isolated files touch OpenView. Locators change with the layout. Update them per phase; every removed assertion gets a ledger row.
- **The large Views file.** `server-backed-views-workspace.tsx` has 4060 lines. A relayout must not become a refactor (OD15).
- **The cold Comms budget.** Shared components (`person-card.tsx`, the toolbar, the pager) are in the shell bundle; the margin is about 1.2 KB locally.
- **One more read per view.** The quick-filter counts add a grouped-count read. It must be cached and must not run for views without a choice field.
- **Edit inside the sheet.** Record edit and create move from a centered dialog to the sheet and the framed dialog; the unsaved-changes guards must follow them.

## Open questions (resolved)

1. Record details: a right sheet (decided under the relayout delegation, part A).
2. Views quick filter: the first choice field with counts (decided under the delegation, part A).
3. Dashboard table widgets: moved to part B, which redesigns widgets.
