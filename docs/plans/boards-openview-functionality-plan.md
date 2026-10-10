# Boards and OpenView contracts and implementation status

## Authority and historical scope

The original local-runtime audit and its phased migration proposal are
historical. Boards and OpenView now use authorized FastAPI adapters and
PostgreSQL; they are not account-scoped browser datasets. The
[schema redesign](schema-redesign-plan.md), [Tier 1](system-completion-tier-1.md)
and [Tier 2](system-completion-tier-2.md) supersede the old capabilities, personal
Dashboard, audience-role and announcement proposals. Current terminology is
**post**, not announcement. This document records implemented contracts and
acceptance boundaries, not a new implementation authorization.

## Boards

[`BoardsPage`](../../frontend/src/components/systems/boards/page.tsx) connects
the [Board router](../../backend/app/systems/boards/router.py) and feature
adapters. Each installation has one company Board, one Board per department,
and administrator-created project Boards. [`access.py`](../../backend/app/systems/boards/access.py)
enforces current scope and `read`, `write`, `manage` levels. A module denial
also prevents record values appearing through Board widgets and record links;
Board access alone does not grant Record access.

| Feature | Current contract and source |
|---|---|
| Posts | [Post routes](../../backend/app/systems/boards/post_router.py), [author actions](../../backend/app/systems/boards/post_author_router.py) and [published revisions](../../backend/app/systems/boards/post_revision_router.py) persist draft, scheduled, published and archived state. Published revisions are immutable history. Never-published deletion differs from archiving published content. |
| Events and reminders | [Event routes](../../backend/app/systems/boards/event_router.py) preserve all-day dates versus timed instants and event timezone. [Reminder service](../../backend/app/systems/boards/reminder_service.py) uses start/15-minute/1-day timing and current audience, without duplicate occurrence delivery. |
| Widgets | [Widget routes](../../backend/app/systems/boards/widget_router.py) read authorized module data and support the current saved-chart/query contract. Rendering a saved chart does not transfer its source rights. |
| Record links | [Link routes](../../backend/app/systems/boards/record_link_router.py) retain exact post/event and Record references. Hidden/unreadable sources disclose no Record values. Links are not Sandbox relationships. |
| Attachments | [Attachment routes](../../backend/app/systems/boards/attachment_router.py) associate private ready files; [file bytes](../../backend/app/systems/platform/files/board_router.py) pass through FastAPI. Export/duplicate do not copy private bytes. |
| Project groups and lifecycle | [Group routes](../../backend/app/systems/boards/group_router.py) and [lifecycle](../../backend/app/systems/boards/lifecycle_router.py) retain explicit access, state, revision and purge checks. Department Boards follow department lifecycle; project Boards remain independent. |
| Portable configuration | [Portability routes](../../backend/app/systems/boards/portability_router.py) validate complete configuration and references before an atomic import. Browser-local IDs and incomplete visible pages are not portable server configuration. |

## OpenView

[`OpenViewPage`](../../frontend/src/components/systems/openview/page.tsx)
routes live Views, Charts, Dashboards and Reports to typed server adapters.
Content belongs to departments/modules, not private personal sample snapshots.

| Feature | Current contract and source |
|---|---|
| Views | [Saved views](../../backend/app/systems/openview/views/router.py) persist module query/presentation definitions. Current module readers see them; managers change them. The live [Views workspace](../../frontend/src/components/systems/openview/components/server-backed-views-workspace.tsx) retains local unsaved edits, revision conflicts, filters, sort and layout state. |
| Records | The [live inspector](../../frontend/src/components/systems/openview/components/live-record-inspector.tsx) reads values, linked records and files; eligible writers open Edit. Board links and search open the same authorized source, not a sample Record. |
| Charts | [Chart routes](../../backend/app/systems/openview/charts/router.py) persist shared revisioned definitions; unsaved previews remain local. Dashboard/Board references recheck source access. Charts store configuration, not materialized results. |
| Dashboards | [Dashboard routes](../../backend/app/systems/openview/dashboards/router.py) persist department-owned widgets and layout. Widgets read that department's allowed modules; current query/source access is independent of layout permission. |
| Reports | [Report routes](../../backend/app/systems/openview/reports/router.py), [runs](../../backend/app/systems/openview/reports/run_reader_router.py) and [schedules](../../backend/app/systems/openview/reports/schedule_router.py) persist recipes, immutable results and schedule metadata. A run reader must have been eligible at creation and still read the module now. Scheduled execution uses the system actor. |

## Preserved constraints and acceptance

- Each server-backed read/mutation uses the shared authenticated gateway;
  session verification, denied reads and stale revisions must not expose old
  account/source data or overwrite drafts.
- SSE carries opaque invalidations, not row snapshots. The existing per-account
  QueryClient and singleton stream own refetching; no second provider/stream is
  needed. See [frontend architecture](../architecture/05-frontend-architecture.md).
- Saved consumers and retained Report-run rows participate in lifecycle
  dependency planning. Source purge cannot silently break retained content.
  Report archiving retains run snapshots; permanent Report deletion owns them.
- Exports, aggregates and counts use the full authorized query, not the loaded
  display page. URL navigation preserves the exact Board/content/source target.
- Loading, empty, retry, denial, pending and conflict states remain distinct;
  an ambiguous command outcome must not trigger automatic replay.

Follow [testing architecture](../architecture/16-testing-architecture.md) for
focused HTTP journeys and owned PostgreSQL checks, then the owning integration
gate. Synthetic browser fixtures prove frontend behavior, not backend access,
transactions or provider identity. Remaining accepted gaps are consolidated in
[known gaps](../reviews/known-gaps.md). This document does not claim native-host
acceptance, hosted multitenancy or release readiness.
