# OpenView part A: department pages

> **Status: approved (2026-10-26).** Part A of the OpenView direction in `docs/specs/openview-relayout.md` (the umbrella: owner decisions, baseline, critique, findings, and the slim decisions OD1–OD15). Comp: `.impeccable/mocks/openview/views.html` (render `.playwright-mcp/openview-relayout/comp/deptpages-views-1440.png`; the owner chose this sidebar on 2026-10-26). No product code has changed.

## Outcome

Each department is a group in the sidebar, and each of its modules is a page. A person opens Sales › Contacts from the sidebar and sees the Contacts records at once, in the slim grammar. They no longer pick a "data source" first.

**In scope.**

- The sidebar and the phone drawer: a Departments section above the tools.
- The module page: today's Views page for one module, relayouted with the slim decisions of the umbrella (OD1, OD3–OD8, OD12–OD15).
- The record sheet, the Views dialogs, the no-access state, phones, and the words of these screens.

**Out of scope (parts B and C, or later).**

- The department Dashboard, the 4×5 grid, and the chart builder (part B).
- Reports inside module pages (part C).
- The Dashboards, Charts, and Reports pages: unchanged in A, still reachable from the OpenView item.
- Backend changes. A uses the existing reads only.

**Preserved behavior.**

- Every capability stays reachable for each role that has it now.
- URLs stay the same. A module page is `/openview?section=views&module=<id>`; saved views, `?record=`, and the view state in the URL are unchanged. Links from Boards, Platform search, and notifications keep working.
- A bare `/openview` (or `?section=views` without a module) opens the first module the person can read, as today.
- Saved views, drafts, the unsaved-changes guards, conflicts, record edit and create, exports, links, files, and history behave as they do now.

## Sidebar

```
Departments
  ■ Sales               ▾      (■ = the department mark, in its Sandbox color)
      Contacts              ← current page
      Customers
      Quotes
      Sales Orders
  ■ Finance             ▸
  ■ Purchasing          ▸
  ■ Inventory           ▸
  ■ Field Operations    ▸
  ■ Customer Service    ▸
Tools
  Sandbox  Boards  Access  OpenView (Dashboards, Charts, Reports)  Manage  Platform
```

| ID | Decision | Removes |
| --- | --- | --- |
| DA1 | A Departments section sits above the tools, under a small muted label; the tools follow under "Tools". | — |
| DA2 | It lists only departments that have at least one module the person can read, and only those modules. Departments follow the Sandbox order: the departments read sorted by `created_at` (department ids are time-ordered, and the Sandbox orders departments by id). Modules follow their names. | The data-source picker as the way into a module. |
| DA10 | Each department row starts with its `DepartmentMark` (8px, `--dept-n`), indexed by its place in the Sandbox order, so a department has the same color here as in Access and OpenComms (The Same Department Rule). The name follows as text. | — |
| DA3 | The current department is open; the others are closed. A group the person opens or closes stays that way while they move between pages; a reload starts again from "current only". (Changed during A1: browser storage cost bytes on every cold page and the cold-load budget had no room for it.) | Remembered groups across reloads. |
| DA4 | A module row links to its module page. It is current when the page shows that module, with the same fill and glide as other sidebar rows. | — |
| DA5 | The OpenView item stays, with Dashboards, Charts, and Reports only, until parts B and C replace them. Its Views item goes; the module pages replace it. | The Views item. |
| DA6 | In the collapsed rail (56px), one Departments button (the chart icon OpenView used) opens the sidebar with the department groups. (Changed during A1: a second menu in the rail duplicated the expanded sidebar and cost cold-load bytes.) | The rail menu. |
| DA7 | The phone drawer shows the same section, with the current department open. | — |
| DA8 | The breadcrumb reads "Sales › Contacts" on a module page. | "Workspace › OpenView › Views". |
| DA9 | A person who can read no module sees no Departments section. An administrator in an organization with nothing published also sees none; the module landing offers the Sandbox (OD13). | — |

**Data.** The sidebar renders on every page, OpenComms included, so it must be cheap:

- One read of the departments the person can read (`/api/departments` with `sort_by=created_at`, an existing sort; the cached `departmentsOptions` sorts by name, so the sidebar gets its own key) and one read of the readable modules (`/api/views/data-sources`, the first page of 100). Both are cached in the account's query cache and shared with the module page.
- The section refreshes when the server reports a `departments` or `modules` change on the existing event stream, so a module published or renamed in the Sandbox appears without a reload.
- A cold load of `/comms` adds at most these two reads; the cold Comms JavaScript budget holds.
- More than 100 readable modules: the section shows the first 100 by name and a "More…" row that opens the module picker. (Harbor has about 30.) The module list is the same cached first page the module page reads, so a module page adds no request. The "More…" row lands in A2 with the module page's module picker.

## Module page

The module page is the umbrella's Views direction (comp `views.html`), with the module chosen by the sidebar:

- **Header** (OD1, OD5): the module name as the title; one meta line, "Sales · 30 records", with "Unsaved changes" when the view changed; the saved-view picker; Export; a "More view actions" menu (Archived views, Copy link, Reset changes), so it is never empty; one primary, New record for writers or Save view with unsaved changes ("Save as new view" beside it). No data-source card and no intro sentence.
- **Toolbar** (OD3, OD4, OD14): one row with search, the quick filter (the first choice field, with counts), Filters (a popover from 768px, a bottom sheet below) with chips under the toolbar, Sort, Columns, and the Layout select.
- **Records** (OD6): the table panel fills the page; only its body scrolls; the pager stays at the bottom. 40px one-line rows; the whole row opens the record; people as avatar and name in ink; one date format.
- **Record** (OD7): a right sheet with Previous and Next, a quiet Edit, Delete in the "More record actions" menu, a named close, and the tabs Details, Linked records, Files, History. Edit and create use the shared dialog frame.
- **Layouts** (OD8): Kanban, Calendar, and Timeline show their field picker in their empty state.
- **Dialogs** (OD12): Columns, New record, Export, and Save view as use the shared dialog frame.
- **No access** (OD13): "No records to show yet" with the reason and no action.
- **Words**: the glossary rows that belong to these screens (umbrella OV-F12).

Of the umbrella's open questions, the first two are in-scope decisions under the relayout delegation and follow the recommendation: the record opens in a right sheet, and the quick filter shows the first choice field with counts. The third (dashboard widget pagers) belongs to part B.

## Phases

Each phase ends with tests that fail first, one code review, targeted screenshots (no sweep; the owner checks the live app), and the budget spec (`comms-js-budget`).

| Phase | Content | Proof |
| --- | --- | --- |
| A1 | Sidebar Departments section, rail menu, drawer, breadcrumb, bare `/openview` landing (DA1–DA9) | `workspace-navigation` (isolated), `workspace-orientation`, a new sidebar spec for each role; cold-load request count on `/comms` |
| A2 | Module page header, toolbar, Filters popover and chips, quick filter, Layout select, 40px rows, still page (OD1, OD3–OD6, OD14); the View actions menu (OV-F3) | `openview-views-api` (89 tests) updated, not deleted; no document scroll at 1280×720 |
| A3 | Record sheet and the framed dialogs (OD7, OD8, OD12) | `openview-record-links-busy`, record tests; Previous and Next; `?record=` links from Platform and notifications |
| A4 | No-access state, phones, and words (OD13, OV-F12, OV-F13) | 44px sweep at 390; the first record on the first phone screen; the glossary guard |
| A5 | Review: critique of the module page, `ui-reviewer`, and a hands-on pass as `ho-admin`, `ho-manager`, `ho-reader`, `ho-guest`, and `ho-noaccess` | Exit criteria |

`server-backed-views-workspace.tsx` (4060 lines) is split only along the seams this layout needs: the header, the toolbar, and the record sheet. State owners stay where they are (OD15).

## Exit criteria

| Exit | Criterion |
| --- | --- |
| EXIT-A1 | Each role sees exactly the departments and modules it can read; the module rows open the right pages; the current row is marked. |
| EXIT-A2 | A cold load of `/comms` adds at most the two catalog reads, and the cold Comms JavaScript stays under its budget. |
| EXIT-A3 | A module published or renamed in the Sandbox appears in the sidebar without a reload. |
| EXIT-A4 | The module page does not scroll the document at 1280×720 or 1440×900; the first record row is above y=300 at 1440 and on the first phone screen. |
| EXIT-A5 | From 1280px, controls are 32px and rows 40px; at 390, targets are at least 44px and nothing scrolls sideways. |
| EXIT-A6 | Every URL in Preserved behavior opens the same thing; every capability stays reachable. |
| EXIT-A7 | A critique of the module page scores at least 28/40 with no P1. |
| EXIT-A8 | Each finding has a test that failed first, or a recorded reason; focused batches pass. |
| EXIT-A9 | The owner reviews the live app and approves the result. |

## Risks

- **Every page reads the catalog.** The two reads join the cold load of every route. They are small and cached, but EXIT-A2 measures them on `/comms`.
- **Mark color for partial readers.** The mark index counts the departments the person can read. A person who cannot read every department may see a department in a different color than an administrator sees in the Sandbox. Access and OpenComms have the same limit today; a canvas position on the departments read (a backend field) would remove it later.
- **Test churn.** Most OpenView tests open `?section=views&module=…` URLs, which stay valid; the locators of the header, toolbar, and record dialog change. Every removed assertion gets a ledger row.
- **Two ways to OpenView during the transition.** Until parts B and C, the OpenView item holds Dashboards, Charts, and Reports while modules live under departments. This is deliberate and ends with part C.
