# Test ledger

This file records each assertion that a change removes from a test file, and the test that now owns that behavior. The test guard (`scripts/assertion_guard.py`, plan item 14) reads the rows that a change adds to this file. A change that removes assertions without matching rows does not pass the pre-push gate or CI.

Add rows at the end. Do not edit or delete earlier rows.

Each row has four cells:

1. **Removed from:** the repository path of the test file that lost assertions.
2. **Assertions:** the number of assertions removed from that file in this change.
3. **Owner:** the test that now owns the behavior, as `path` or `path::test name`. The file must exist.
4. **Rule:** the consolidation rule (D1 to D4 in `.agents/skills/tdd-workflow/references/consolidation.md`) and a short reason. For a reviewed snapshot change, start the rule with `snapshot`.

Correct: `| frontend/tests/http/openview-views-api.spec.ts | 3 | frontend/tests/isolated/openview/view-filters.spec.ts | D1: filter matrix owned by the isolated rules test |`
Wrong: `| frontend/tests/http/openview-views-api.spec.ts | 3 | n/a | cleanup |`

| Removed from | Assertions | Owner | Rule |
| --- | --- | --- | --- |
| frontend/tests/http/access-memberships.spec.ts | 8 | frontend/tests/http/access-memberships.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/access-people.spec.ts | 2 | frontend/tests/http/access-people.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/aggregate-calendar-journeys.spec.ts | 4 | frontend/tests/http/aggregate-calendar-journeys.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/boards-live-calendar.spec.ts | 4 | frontend/tests/http/boards-live-calendar.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/boards-live-management.spec.ts | 2 | frontend/tests/http/boards-live-management.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/boards-live-posts.spec.ts | 6 | frontend/tests/http/boards-live-posts.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/boards-live-widgets.spec.ts | 9 | frontend/tests/http/boards-live-widgets.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/manage-jobs.spec.ts | 2 | frontend/tests/http/manage-jobs.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/openview-charts.spec.ts | 5 | frontend/tests/http/openview-charts.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/openview-dashboards.spec.ts | 9 | frontend/tests/http/openview-dashboards.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/openview-record-links-busy.spec.ts | 1 | frontend/tests/http/openview-record-links-busy.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/openview-reports.spec.ts | 2 | frontend/tests/http/openview-reports.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/openview-saved-charts.spec.ts | 1 | frontend/tests/http/openview-saved-charts.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/openview-views-api.spec.ts | 6 | frontend/tests/http/openview-views-api.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/sandbox-relationship-mappings.spec.ts | 4 | frontend/tests/http/sandbox-relationship-mappings.spec.ts | D1: design-review capture scaffolding; runs only with OPENVIEW_CAPTURE_DIR, never in the gate |
| frontend/tests/http/helpers/openview-review-capture.ts | 1 | frontend/tests/http/openview-views-api.spec.ts | D1: deleted design-review capture helper; its pre-screenshot check ran only with OPENVIEW_CAPTURE_DIR, never in the gate |
