# OpenView part C: Reports inside module pages

> **Status: approved (2026-10-26).** In-scope design decisions made during the work go into the Decisions table. Part C of the OpenView direction in `docs/specs/openview-relayout.md` (umbrella), after part A (`openview-department-pages.md`, approved) and part B (`openview-dashboard.md`, approved). Comp: `.impeccable/mocks/openview/reports.html` (renders `.playwright-mcp/openview-relayout/comp/reports2-1440.png` and `reports2-empty-1440.png`; `?empty=1`). Revised 2026-10-26 after the owner's review: the layout must explain what a report does. No product code has changed.

## What a report is

A report is a saved recipe for one module: its columns, up to 10 filters, up to 3 sorts, an optional grouping, and an optional row count. People run it now, or on a schedule (daily, weekly, or monthly at a local time). Each run saves a **copy**: the rows as they were at that moment. A copy can be opened, printed, or downloaded as CSV later, and later changes to the records do not change it. Export gives the records now; a report adds the schedule and the history of copies.

## Outcome

A module's reports live on its page, and the layout explains what a report does without help text. On Sales › Quotes, a person switches from Records to Reports and picks "Weekly quotes summary". The detail reads as one sentence in three steps: what it lists → when it runs → what you keep. Under it is the latest copy itself, so the person sees what a report produces. A manager can turn the view they are looking at into a report in one step. The Reports page and the OpenView sidebar item go; the sidebar holds departments and tools only.

**In scope.**

- The module page's Records and Reports views, and the Reports view's list, detail, copies, and schedule.
- The report dialog (new and edit) and "Make a report from this view".
- Old report links and notification links.
- The end of the OpenView item in the sidebar.

**Out of scope.**

- Backend changes: part C uses the existing report, run, schedule, and purge routes.
- New report features: recipients, emailed copies, charts in reports.

**Preserved behavior.**

- Who may do what: readers of the module see its reports and copies; any reader who is not a guest may run a report; module managers create, edit, schedule, archive, and restore; permanent delete follows the existing purge rules.
- A copy keeps the rows of its run; opening it checks module read again (`eligibility.py`).
- The schedule rules (cadence, weekday, day of month, time, time zone, the next run) and the revision checks on save.
- Every link: `/openview?section=reports&report=<id>` and `&run=<id>` (used by notifications) still open that report and copy.

## Current state (observed 2026-10-26)

- `Report`: one `module_id`, name, subtitle, revision, recipe (`fields`, `filters`, `logic`, `sorts`, `group_by`, `include_row_count`).
- `ReportRun`: the recipe revision, headings, row count, the rows, and the CSV bytes. Eligible people are the module's readers at run time; a read checks module read again.
- `ReportSchedule`: enabled, cadence, time zone, local time, weekday, day of month, next due.
- `GET /api/reports` already filters by `module_id`.
- The Reports page lists every report across modules, each with its own Duplicate button, a detail card, and "Available outputs" (copies shared with you across modules).
- Notifications link to `/openview?section=reports&report=<id>&run=<id>` (`notification-kind.ts:31`).

## Decisions

| ID | Decision | Removes |
| --- | --- | --- |
| DC1 | The module page has two views, Records and Reports, as a segmented control with counts in the header ("Records 42 · Reports 3"). The URL keeps the module and adds `tab=reports`, `report=<id>`, and `copy=<runId>`. | The Reports page. |
| DC2 | The Reports view is a list and a detail (the Sandbox Triggers grammar). List rows: the name, the schedule state as a dot and word (Scheduled, Not scheduled), and one plain line with the cadence in words and the number of copies ("Every Monday · 12 copies", "When someone makes a copy · 3 copies"). The selected row takes the tint and `aria-current`. New report sits in the list head for managers; archived reports are a list filter for managers. | Per-row Duplicate buttons; cut names. |
| DC3 | The detail head: the name, a "More report actions" menu (Duplicate, Archive; for an archived report, Restore and Delete forever under the existing purge rules), and the one primary, "Make a copy now" (the action says what it produces). | "Run now"; the facts line. |
| DC4 | **The three steps.** Under the head, three linked cards read left to right: 1 · What it lists ("Open quotes, grouped by status", the columns and row count), 2 · When it runs ("Every Monday at 08:00", the next copy), 3 · What you keep ("A dated copy each time", the count and the latest date). For managers, step 1's Change opens the report dialog and step 2's Change opens the schedule (label-left rows: Repeat, Day, Time, Time zone; Save schedule quiet and enabled only with changes). Readers see the same cards without Change. | The Saved copies and Schedule tabs; the facts line. |
| DC5 | **The copy itself.** Under the steps, the latest copy shows as the document it is: a bar with "Copy of Mon, Oct 20 at 08:00 · 142 rows · as they were then", an "Older copies" picker (each with its date and how it was made), Print, and CSV; then the copy's rows in the panel that scrolls. A link to a copy opens it here. | The copies list; the copy sheet; the separate output pane. |
| DC6 | New report and Edit use the shared dialog frame. The module is the page's module; there is no module picker. Sections: Basics (Name, Subtitle), Columns, Filters and order (the module page's Filters rows, AND or OR, up to 3 sorts, Group by, row count). | The module picker; Reset draft beside Create. |
| DC7 | "Make a report from this view" in the Records view menu (managers) opens New report with the view's columns, filters, sort, and grouping filled in. | "Start from saved Report" (Duplicate covers it). |
| DC8 | An old link, `/openview?section=reports&report=<id>` with or without `&run=<id>`, reads the report, then replaces the URL with its module page's Reports view, the report selected and the copy open. A report that is gone or not readable lands on the first readable module with "This report is not available." | — |
| DC9 | The OpenView item leaves the sidebar; the sidebar holds departments and tools (the end state of the direction). `?section=reports` without a report opens the Reports view of the first module the person can read. | The OpenView item. |
| DC10 | No cross-module list of copies. Each module's Reports view holds its copies, and each scheduled copy still arrives as a notification. | "Available outputs" (the shared-runs list); the route stays, unused by this page. |
| DC11 | **The empty state teaches by the same layout.** "Keep a dated copy of these quotes" over the same three steps as dashed cards (the quotes you choose → now, or every day, week, or month → a dated copy each time), then "Make a report from the current view" (primary) and "Start from scratch" for managers. Readers see the steps and "No reports for Quotes yet." | A text-only empty state. |
| DC12 | Phones: Records and Reports sit under the title; the list opens the detail as its own screen with Back; a copy opens full screen. | — |

### Where each Reports page capability goes

| Capability today | In part C |
| --- | --- |
| List reports | The Reports view of each module |
| Create a report | New report (list head), or Make a report from this view |
| Edit, name, subtitle, recipe | Step 1, What it lists |
| Duplicate; Start from saved Report | Duplicate (detail menu) |
| Archive, Restore, Delete forever | Detail menu; archived reports in the list filter |
| Run now | "Make a copy now", the detail's primary |
| Schedule | Step 2, When it runs |
| Saved outputs: open, print, CSV | The latest copy under the steps; Older copies; Print and CSV in the copy bar |
| Available outputs (shared copies) | Each module's Saved copies, and the notification links |
| Notification and old links | DC8 |

## Phases

Each phase ends with tests that fail first, one code review, targeted screenshots (no sweep), and the budget spec (`comms-js-budget`).

| Phase | Content | Proof |
| --- | --- | --- |
| C1 | The Records and Reports views; the list, the three steps, the copy in place, the schedule, and the teaching empty state (DC1–DC5, DC10, DC11) | `openview-reports` (31 tests) moved to the module page; each role's actions |
| C2 | The report dialog and Make a report from this view (DC6, DC7) | Create, edit, and the prefilled recipe; revision conflicts |
| C3 | Old links and notifications; the OpenView item and the Reports page go (DC8, DC9) | `platform-report-notifications`, `platform-notification-kinds`; a link to a gone report |
| C4 | Phones and words (DC12) | 44px sweep at 390 |
| C5 | Review: critique, `ui-reviewer`, and a hands-on pass as `ho-admin`, `ho-manager`, `ho-writer`, `ho-reader`, and `ho-guest` | Exit criteria |

## Exit criteria

| Exit | Criterion |
| --- | --- |
| EXIT-C1 | Every capability in the map is reachable from the module page for each role that has it now. |
| EXIT-C2 | Every old report link and notification link opens the right report and copy, or the notice. |
| EXIT-C3 | The sidebar has no OpenView item; `?section=reports` and `?section=charts` links still land on a working page. |
| EXIT-C4 | The Reports view does not scroll the document at 1280×720 or 1440×900; only its panels scroll. |
| EXIT-C5 | At 390, targets are at least 44px and nothing scrolls sideways. |
| EXIT-C6 | A critique scores at least 28/40 with no P1. |
| EXIT-C7 | Each finding has a test that failed first, or a recorded reason; focused batches pass. |
| EXIT-C8 | The owner reviews the live app and approves the result. |

## Risks

- **A busier module page.** The page now holds records and reports. The Reports view lives in its own component under `openview/components/`, so the 4060-line Views file does not grow.
- **The redirect needs one read.** DC8 reads the report to find its module before it opens the page; a slow read shows the page frame, not a blank page.
- **No cross-module list of copies.** Someone who followed many reports across modules loses one place for all copies; notifications still deliver each scheduled copy. If that list is missed, it can return as a Platform notification filter later.
