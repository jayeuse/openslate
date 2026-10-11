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
