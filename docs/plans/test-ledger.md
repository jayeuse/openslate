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
| frontend/tests/http/auth-email-change.spec.ts | 5 | frontend/tests/http/auth-email-change.spec.ts | D1: screenshot capture scaffolding; runs only with CAPTURE_S24_EMAIL, never in the gate. Its unowned 390 px landing overflow check moved to "a scrubbed link survives in memory only, not a page reload" |
| frontend/tests/http/help-panel.spec.ts | 2 | frontend/tests/http/help-panel.spec.ts | D1: screenshot capture scaffolding; runs only with CAPTURE_S23_HELP, never in the gate. Its unowned phone-fit checks moved to "Help fits a phone and lists the existing Sandbox Build keys, not a new global or Comms dispatcher"; theme class owned by user-theme-preferences.spec.ts |
| frontend/tests/http/openview-date-moves.spec.ts | 1 | frontend/tests/http/openview-date-moves.spec.ts | D1: screenshot capture scaffolding; runs only with S19_CAPTURE_DIR, never in the gate. The stale review text is owned by "partial stale keeps the failed card and announces the successful move once" |
| frontend/tests/http/person-card.spec.ts | 1 | frontend/tests/http/person-card.spec.ts | D1: screenshot capture scaffolding; runs only with CAPTURE_S22_PERSON_CARD, never in the gate. Its unowned 390 px card bounds checks moved to "Person card guest DTO omits private keys and nullable member values remain truthful"; theme class owned by user-theme-preferences.spec.ts |
| frontend/tests/http/profile.spec.ts | 7 | frontend/tests/http/profile.spec.ts | D1: screenshot capture scaffolding; runs only with CAPTURE_S21_PROFILE, never in the gate. Draft retention owned by "Profile 503 preserves a text draft and a read Retry never replays a write", which now also owns the 390 px overflow check; theme class owned by user-theme-preferences.spec.ts |
| frontend/tests/http/sandbox-relationship-mappings.spec.ts | 3 | frontend/tests/http/sandbox-relationship-mappings.spec.ts | D1: screenshot capture scaffolding; runs only with S06_CAPTURE_DIR, never in the gate. The disabled "Exporting…" state is owned by "pending export is single and cancellation refuses its late download" |
| frontend/tests/http/sandbox-relationship-mappings.spec.ts | 2 | frontend/tests/http/sandbox-relationship-mappings.spec.ts | D1: screenshot capture scaffolding; runs only with TRIGGER_LAYOUT_SCREENSHOTS, never in the gate. Trigger page width at 1920, 1440 and 390 px is owned by "trigger panels resize with their requested minimum widths and remain usable" |
| frontend/tests/isolated/access/contracts.spec.ts | 8 | frontend/tests/isolated/contracts/access-contract.spec.ts | D1: duplicate of the OpenAPI-driven adapter cases, which parse backend-schema responses in values and nulls modes through the same eight strict schemas (no transforms) |
