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

## app/systems/sandbox/fields/validation.py

- `_canonical_decimal`, `fractional_part.rstrip("0")` changed to `rstrip("XX0XX")`: 1 mutant — equivalent: `_DECIMAL_PATTERN` admits only digits, so stripping `X` as well as `0` changes nothing.
- `_validate_date`, `datetime_values=False` changed to `None`: 1 mutant — equivalent: `date_in_range` only tests the flag for truth, and `None` is false like `False`.
- `_validate_decimal`, the `"minimum"` and `"maximum"` labels passed to `_canonical_decimal` for the bounds: 6 mutants — equivalent: the `except (InvalidOperation, ValueError)` at the bound parse discards the label message and raises "has invalid decimal configuration" instead.
- `_validate_email` and `_validate_url`, `cast(str, value)` changed to `cast(None, value)`: 2 mutants — type-only: `cast` returns its second argument unchanged.
- `_numeric_config`, the second finite check of `defaultValue` (lines 88 and 89): 4 mutants — unreachable default: the key loop at lines 63 to 69 already refuses a non-finite `defaultValue` with the same message. Dead code, listed for the owner.
- `_decimal_config`, the `except InvalidOperation` around the bound comparison (lines 123, 126 and 127): 4 mutants — unreachable default: both bounds are already canonical decimal strings from `_canonical_decimal`, and `Decimal` never refuses one. Dead code, listed for the owner.
- `_validate_decimal`, the `except InvalidOperation` around `Decimal(canonical)` (lines 326 to 330): 1 mutant — unreachable default: same reason. Dead code, listed for the owner.
- `_numeric_config`, `key == "defaultValue" and config[key] is None` changed to `or`: 1 mutant — unreachable default: the mutant only changes the outcome for a `None` minimum, maximum or step, and the publish path drops `None` values before `field_config` (`publications/rules.py`, the `present` filter); for a non-finite `defaultValue` the later check raises the same message.
- `_numeric_config`, the `continue` after a `None` `defaultValue` changed to `break`: 1 mutant — equivalent: the key loop checks `defaultValue` last, so leaving the loop there skips nothing.
- `_numeric_config`, `"defaultValue"` in the key-order tuple renamed (three spellings): 3 mutants — equivalent: the second `defaultValue` finite check (lines 88 and 89) refuses a non-finite default with the same message.
