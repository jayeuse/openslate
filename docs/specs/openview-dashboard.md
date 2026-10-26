# OpenView part B: the department dashboard

> **Status: approved (2026-10-26),** including the backend changes BE1–BE3. B0 landed in `1f434798`; B1–B4 are built (decisions BD13–BD25). Part B of the OpenView direction in `docs/specs/openview-relayout.md` (umbrella). It follows part A (`docs/specs/openview-department-pages.md`, approved). Comp: `.impeccable/mocks/openview/dashboard.html` (renders `.playwright-mcp/openview-relayout/comp/dash-*.png`; `?edit=1`, `?builder=1`, `?locked=1`). No product code has changed.

## Outcome

Each department has one dashboard, its home. It opens from the first row under the department in the sidebar. The department's managers arrange it on a fixed grid of 4 columns and 5 rows. They add graphs that they build from the department's modules and from modules linked to them in other departments. Everyone who reads the department sees the dashboard; each widget shows only what that person may read.

**In scope.**

- The Dashboard row in each department group, and the end of the Dashboards and Charts items in the OpenView group (it then holds Reports only, until part C).
- The dashboard page: view mode, edit mode, presets, size rules, empty and locked states, phones.
- The chart-builder dialog, which replaces the Charts page.
- A home for every capability of the Charts and Dashboards pages.
- The backend changes listed under "Backend changes needing your go-ahead".

**Out of scope.**

- Reports (part C).
- Module pages (part A).
- New chart types, comparisons with a previous period, targets, and alerts.
- Several dashboards per department in the interface. Existing extra dashboards are kept; see BD3.

**Preserved behavior.**

- Widget data is read as the viewer, on every request (`POST /api/records/aggregate-snapshots` runs with the reader's id and checks read access to every module, `query_router.py:136`). No dashboard result is shared between people.
- The refresh cadence (manual, every minute, every five minutes), the revision check on save, archive and restore of a dashboard, and the live refresh from the event stream.
- Saved charts and their usage: a saved chart used by a widget keeps working.
- Every capability of the Charts and Dashboards pages stays reachable (the map below).
- Existing URLs: `/openview?section=dashboards&dashboard=<id>` opens that dashboard; `?section=charts` opens the dashboard of the person's first department with the builder's saved-chart list.

## Current state (observed 2026-10-26)

- A department can have several dashboards (`dashboards.position`). Harbor has 6 departments with exactly one dashboard each.
- A dashboard holds up to 12 widgets, placed by `position` 0–11 with `size` S, M, or L. Harbor has 4 widgets per dashboard, all size M.
- Widget types: `summary` (a number), `workload` (group values in a table), `records` (a list), and `chart` (bar, line, or pie), each inline or from a saved chart.
- The server accepts only modules of the dashboard's own department (`widget_validation.py:33`).
- The page reads all widgets in one batch. One refused module refuses the whole batch, so one refused saved chart clears every widget (by design today; `openview-dashboards.spec.ts:1789`).

## The grid

- **4 columns × 5 rows**, 12px gaps, filling the page under the header. At 1440×900 a row is about 135px.
- **Minimum row height 112px.** On a window too short for five such rows (1280×720 gives 99px), the grid panel scrolls; the page itself does not. This is the one exception to the still-page rule, recorded here.
- A widget covers a rectangle of whole cells. Widgets never overlap and never leave the grid.

### Size rules (columns × rows)

| Widget | Smallest | Largest | Why |
| --- | --- | --- | --- |
| Number | 1 × 1 | 2 × 1 | One figure and its label |
| Bar | 2 × 2 | 4 × 3 | Bars and their labels need width and height |
| Line | 2 × 2 | 4 × 3 | A trend needs width |
| Pie | 2 × 2 | 3 × 3 | A pie needs a square |
| Table (group values) | 2 × 2 | 4 × 5 | Four rows at 2 × 2, more when taller |
| Records (a list) | 2 × 2 | 4 × 5 | Four rows at 2 × 2, more when taller |

The rules were checked at the 112px minimum: a bar chart at 2 × 2 is about 236px tall; a table at 2 × 2 shows its head and four rows.

### Presets

A preset places empty widget spaces of the right sizes; each space then asks for its chart. Presets apply to an empty dashboard, or replace the layout after a confirmation.

| Preset | Layout |
| --- | --- |
| Overview (the comp) | Row 1: four numbers. Rows 2–3: a bar and a line, 2 × 2 each. Rows 4–5: a table and a records list, 2 × 2 each. |
| One big trend | Row 1: four numbers. Rows 2–4: one line, 4 × 3. Row 5: four numbers. |
| Lists first | Rows 1–2: a bar and a pie, 2 × 2 each. Rows 3–5: a records list, 4 × 3. |

## Decisions

| ID | Decision | Removes |
| --- | --- | --- |
| BD1 | Each department group in the sidebar starts with a Dashboard row, then its module pages (completes part A's DA5). The OpenView group loses Dashboards and Charts and keeps Reports until part C. | The Dashboards and Charts items; the dashboard picker. |
| BD2 | The header: the dashboard name (default "<Department> dashboard"), one meta line (when it refreshed, how often), a quiet Refresh, a "More dashboard actions" menu (Settings: name and refresh cadence; Archive), and for managers one primary, Edit layout. | The picker card, the revision sentence, Add from saved chart and Add widget at rest. |
| BD3 | One dashboard per department. The first active dashboard by position is the home. A department's other dashboards stay, read-only, under "Other dashboards" in the menu until a manager archives them. Nothing is deleted. A department with no dashboard shows "Set up the Sales dashboard" with the presets to its managers, and "No dashboard yet" to readers. | Creating more dashboards in the interface. |
| BD4 | View mode: each widget is a card with a 36px head (title, the linked department's name when the source is in another department, and its menu) and its content. No sentence under the title, no size kicker. Table widgets page with a compact "1–4 of 12" and arrows. | The repeated "Current results…" sentence; the "Summary · M" kicker; full pagers with Rows per page. |
| BD5 | The widget menu: Open the records (the module page with the same filters), Download data (CSV), and for managers Edit chart and Remove. | — |
| BD6 | A widget whose module the viewer cannot read is a locked card: a lock, "No access to Finance records", and "Ask an administrator for access." The other widgets load. The page sends one read per module, so one refusal locks only that module's widgets. | One refusal blanking the whole dashboard. |
| BD7 | Edit mode (managers, from 1024px): the grid lines show; empty cells show "Add"; every widget gets a drag handle and a corner handle. Moving uses `@dnd-kit/core`, already used by Kanban, Calendar, and Timeline. Resizing snaps to cells and stops at the widget's size rules. | — |
| BD8 | The non-drag way (WCAG 2.2, 2.5.7): the widget menu in edit mode lists the allowed sizes (a size it cannot take stays listed, disabled, with its reason) and Move left, right, up, down. On the focused drag handle, arrow keys move and Shift+arrow keys resize. | Drag as the only way. |
| BD9 | Edit mode replaces the header actions with one pinned bar: a hint, Presets, Add widget, Cancel, and Save layout (the only primary). Save sends one update with the revision; a conflict keeps the edit and offers to reload. Leaving with unsaved layout changes asks first. | — |
| BD10 | The chart builder is a large framed dialog with two panes: Setup (label-left rows: Show as, Records, Group by, Show, Filters, Dates, Order, Title, Size) and Preview (the widget at its size, updated with Update preview; explicit, as Charts are today). It opens from an empty cell (its size preselected; types that do not fit are disabled with their reason) or from Edit chart. The footer: "Use a saved chart instead", Cancel, and Add to dashboard. | The Charts page. |
| BD11 | The Records picker lists the department's modules first, then the linked modules under "Linked departments" ("Finance › Invoices"). The builder notes that people who cannot open that module see a locked card. | — |
| BD12 | Phones: the widgets stack in reading order (row, then column), full width, each at its type's height. Edit layout shows "Edit the layout on a larger screen." | — |
| BD13 | Decision (B1, 2026-10-26): the dashboard's address is `/openview?section=dashboards&department=<id>`; a department's other dashboard adds `&dashboard=<id>`. An old `&dashboard=<id>` link gains its department once the dashboard is read, and `?section=dashboards` alone opens the first readable department, so the sidebar and the breadcrumb follow the address alone. `?section=charts` opens the first department's dashboard with `&builder=saved`: a manager on a wide screen lands in edit mode with the saved-chart list; anyone else sees the dashboard. | The dashboard id as the only address; the Charts section page. |
| BD14 | Decision (B1): the page reads saved inline widgets in one `aggregate-snapshots` batch per module (at most 12 queries each) and each saved chart on its own. A 404 for one read (a module the viewer cannot see), or an unavailable saved chart, locks only its own widgets; a 401 or 403 still sets the OpenView refusal latch and hides the page until an authorized read, as before. | The single batch for every widget. |
| BD15 | Decision (B1): the locked card says "No access to these records". A viewer cannot read the name or the department of a module they cannot open, so the comp's "No access to Finance records" is not possible without a new read. | The department name on the locked card. |
| BD16 | Decision (B3): widgets store no title or group order (the B0 wire has neither). A widget's title comes from its query ("Equipment by Category", "Number of Quotes", "Sales Orders per week"); a saved chart shows its name. The builder's Title row shows that title, and becomes the name field when "Save for reuse" is ticked. The Order row is offered for records lists only (their stored sort). A free title and group order need a backend field (follow-up). | Free titles on inline widgets; the Order row on charts and tables. |
| BD17 | Decision (B2): preset spaces live in the layout draft only. Save layout saves the filled widgets; an unfilled space is not saved. A preset over a layout with widgets removes them after a confirmation. | Placeholder widgets in the API. |
| BD18 | Decision (B2): Edit chart and Remove in a view-mode widget menu open edit mode with that change made; Save layout saves it, Cancel drops it. | Immediate writes from the view menu. |
| BD19 | Decision (B1): Download data (CSV) is offered on numbers, charts and tables (their groups). A records list offers Open the records, where the module page exports. | A second records export. |
| BD20 | Decision (B3): the saved-chart list reads where a chart is used when that chart is opened, not for every row: there is no batch read of usage. Archive and Restore sit in each row's menu, Restore under "Archived charts". | One usage read per listed row. |
| BD21 | Decision (B3): Edit chart on a widget that uses a saved chart changes a copy here unless "Change … everywhere" is ticked, which saves the saved chart itself. | — |
| BD22 | Decision (B3): a Number shows one figure for all its groups (the record count, a sum, the smallest or the largest). Average and distinct cannot be added across groups, so the builder does not offer them for a Number; an older number with one of them shows its value when it has one group. | — |
| BD23 | Decision (B2): a card moves by pointer from its handle or its body (dnd-kit pointer sensor, 5px before it starts), resizes from its corner, and moves or resizes from the focused handle with the arrow keys and Shift (announced in a live region). Unplaced widgets (BE1m) show under "Not on the grid" with Place it and Remove, and Save layout says why it waits until each is placed or removed. Edit layout needs 1024px; from 768px to 1023px the grid shows with 112px rows and the page scrolls. | — |
| BD24 | Decision (B1, budget): the widget definition schemas moved to `adapters/dashboard-widget-config.ts`, so the shell, which reaches them through the saved-chart reads, no longer loads the dashboard reads; the locked card draws its lock in place. The cold `/comms` JavaScript is 546,926 gzip bytes against the 546,979 limit (546,881 before part B). | — |
| BD25 | Decision (B5, 2026-10-26): when a department has no active dashboard but has archived ones, its managers see "Archived dashboards…" under the setup choices, which opens the same list and Restore as the dashboard menu; the restored dashboard becomes the home. Readers see no change. The page reads the archived list only for a manager on that empty state. | A department whose only dashboard was archived having no way back in the interface. |

### Where each Charts and Dashboards capability goes

| Capability today | In part B |
| --- | --- |
| Create a chart | The builder, from Add widget or an empty cell |
| Open a saved chart and see its result | "Use a saved chart instead" in the builder: the list with a preview |
| Save a chart for reuse ("Save as") | A "Save for reuse" check in the builder footer |
| Usage of a saved chart | Each row of the saved-chart list names the dashboards that use it |
| Archive and restore a saved chart | The saved-chart list: row menu (Archive), and an Archived filter (Restore) |
| Edit a saved chart | Edit chart on a widget that uses it: "Change it everywhere" or "Use a copy here" |
| Chart data as CSV | Download data in the widget menu |
| Display options (order, labels) | Order and Title in the builder |
| Create, rename, archive, restore a dashboard | BD3 (the home exists or is set up), Settings and Archive in the dashboard menu |
| Refresh now and the cadence | The header Refresh, and Settings |
| A quick question without a dashboard | The module page: its quick filter, Filters, and the Kanban or grouped layouts |

## Backend changes needing your go-ahead

These change the API and the schema (`fastapi-api-design`, `postgres-patterns`). They land first, in their own branch, because the frontend phases depend on the wire format.

| ID | Change | Contract |
| --- | --- | --- |
| BE1 | **Widget placement.** Each widget gets `grid_column` (0–3), `grid_row` (0–4), `column_span` (1–4), and `row_span` (1–5). The server refuses overlap, out-of-grid placement, and sizes outside the type's rules (the size-rules table). `size` and the 12-widget limit go; the grid limits a dashboard to 20 cells. | `DashboardWidgetSpec` and `DashboardWidgetResponse` carry the four fields. A widget may be unplaced (`null` placement) only as a migration result. |
| BE1m | **Migration.** Existing widgets are placed in `position` order, row by row, at the first free space: a number S → 1 × 1, M or L → 2 × 1; any other type S or M → 2 × 2, L → 4 × 2. Decision (B0, 2026-10-26): a pie L → 3 × 3, its largest size, or 2 × 2 when 3 × 3 does not fit, because a pie is at most 3 columns wide. A widget that does not fit stays unplaced and shows in edit mode under "Not on the grid" until a manager places or removes it. Harbor's 4 widgets per dashboard all fit. | Alembic migration with a test on Harbor-shaped data. |
| BE2 | **Linked sources.** A widget may use a module of the dashboard's department, or a module linked to one of them by a relationship (either direction). The manager who saves must be able to read it. Readers' results stay per request (Preserved behavior), so a reader without access gets a refusal for that module only. | `validate_dashboard_widgets` changes its department check (`widget_validation.py:33`). SEC-R6: the control changes because every read is still checked as the viewer. |
| BE3 | **One home per department.** A dashboard gets `is_home`, with one active home per department (a partial unique index). The migration marks the first active dashboard by position. Archiving the home makes the next active one the home. | `DashboardResponse.is_home`; a list filter `home=true`. |

No change is needed for BD6: the page sends one `aggregate-snapshots` read per module.

## Phases

Each phase ends with tests that fail first, one code review, targeted screenshots (no sweep), and the budget spec (`comms-js-budget`).

| Phase | Content | Proof |
| --- | --- | --- |
| B0 | Backend BE1–BE3 with the migration, in its own branch | Backend route and migration tests; overlap, bounds, size rules, linked-source, and home rules; the dashboard batch |
| B1 | The Dashboard row in the sidebar; view mode; per-module reads and locked cards (BD1–BD6) | `openview-dashboards` (62 tests) updated; a reader without Finance access sees one locked card and the rest |
| B2 | Edit mode: drag, resize, the menu and keyboard, presets, Save layout (BD7–BD9) | Keyboard-only edit test; overlap and size-rule refusals; conflict on save |
| B3 | The chart builder and the saved-chart list; the Charts page goes (BD10, BD11, the capability map) | `openview-charts` and `openview-saved-charts` move to the builder; `?section=charts` links |
| B4 | Phones, the no-dashboard states, words (BD3, BD12) | 44px sweep at 390; reading order |
| B5 | Review: critique, `ui-reviewer`, and a hands-on pass as `ho-admin`, `ho-manager` (edits Sales), `ho-reader`, `ho-guest`, and `ho-noaccess` | Exit criteria |

## Exit criteria

| Exit | Criterion |
| --- | --- |
| EXIT-B1 | Each department's Dashboard row opens its home dashboard; the OpenView group holds Reports only. |
| EXIT-B2 | At 1440×900 the dashboard does not scroll; below the 112px row minimum only the grid panel scrolls. |
| EXIT-B3 | A manager arranges a dashboard by mouse and by keyboard alone; the server refuses overlaps and sizes outside the rules. |
| EXIT-B4 | A widget on a linked department's module shows to readers who can read it and is a locked card for the others; the other widgets still load. |
| EXIT-B5 | Every capability in the map is reachable; existing dashboards and saved charts keep working after the migration. |
| EXIT-B6 | At 390, targets are at least 44px, widgets stack in reading order, nothing scrolls sideways. |
| EXIT-B7 | A critique scores at least 28/40 with no P1. |
| EXIT-B8 | Each finding has a test that failed first, or a recorded reason; focused batches pass; the gate passes before the push. |
| EXIT-B9 | The owner reviews the live app and approves the result. |

## Risks

- **Linked sources widen what a dashboard can show.** BE2 is safe only because every read is checked as the viewer; a later cache of dashboard results would break it. The spec's Preserved behavior forbids such a cache.
- **More reads per dashboard.** Per-module reads (BD6) mean one request per module on the dashboard instead of one in all. A dashboard uses a few modules; the count is measured in B1.
- **Editor complexity.** Drag, resize, and their keyboard and menu alternatives are the largest new interaction in the product. B2 keeps the rules in one pure module (placement, collision, size rules) with isolated tests, and the components only draw it.
- **Migration.** Widgets that do not fit become unplaced, not deleted. Harbor fits; other organizations are checked by the migration test.
