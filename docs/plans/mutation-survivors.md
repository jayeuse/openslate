# Mutation survivors that stay

This file belongs to item 24 of [the Tier 2.5 plan](test-suite-tier-2-5.md). It lists the surviving mutants that no new test kills, with the reason. A survivor in behavior that a user, an API client, or the data depends on is killed instead, and does not appear here.

Scores come from `backend/tests/app_mutation.py` (one `app/` module in its own root) or `backend/tests/sample_mutation.py` (`operations/sample`). Both run only the tests that need no stack.

## Format

One `##` section per module, named by its file. One line per group of mutants:

`<function or lines>: <n> mutants — <class>: <reason>`

Use one of these classes:

| Class | Meaning |
|---|---|
| equivalent | The change cannot alter behavior. |
| log or telemetry text | Only a log line or a metric changes. |
| internal wording | Message text that no API contract or screen shows. |
| repr or debug | `__repr__`, debug helpers. |
| unreachable default | An earlier check already guarantees the value. |
| type-only | Type hints, `TYPE_CHECKING` blocks, casts. |
| stack-owned | The behavior needs PostgreSQL; name the stack test that owns it. |

Correct: `_resolve, the two SELECT statements: 70 mutants — stack-owned: tests/access/test_scope_integration.py and the access stack batch own the reads and rule 2.`
Wrong: `_resolve: survivors are fine.`

Do not add `pragma: no mutate`. It hides a mutant instead of explaining it.

## app/systems/access/policy/scope.py

- `_resolve`, the group-row and module-department SELECT statements and the active-account check: 70 mutants — stack-owned: `tests/access/test_scope_integration.py` and the access stack batch own the reads and rule 2; `tests/access/test_access_fold.py` owns rules 1 and 3 to 6 (every `_fold_access` mutant is killed).
