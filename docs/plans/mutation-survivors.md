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

## app/systems/sandbox/records/mutation_validation.py

- `RecordValidationError.__init__`, the `"Record data is invalid"` exception text (three spellings and `None`): 4 mutants — internal wording: no caller reads `str(error)` of this exception; the record routes send their own `"Record data is invalid"` literal (`records/router.py`, `_record_validation_http_error`).
- `validate_record_mutation`, `has_closed_field_mutation = False` changed to `None`: 1 mutant — equivalent: `add_issue` sets the flag only together with an issue, so `issues or None` raises in the same cases, and the property returns `None or any(...)`, the same boolean.
- `validate_record_mutation`, `closed_field_mutation=closed_field_mutation` on the stored issue changed to `None` or dropped: 2 mutants — equivalent: only the `has_closed_field_mutation` property reads the issue flag, and the function always passes its own flag, which is already true for the same issue.
- `validate_record_mutation`, `sorted(new_data.items(), key=...)` without the key: 2 mutants — equivalent: keys are unique strings, so sorting the `(key, value)` pairs orders by key alone.
- `validate_record_mutation`, the three non-string key branches (lines 110 and 111, 153 and 154, 182 to 184): 13 mutants — unreachable default: every caller passes `dict[str, Any]` (`RecordCreate.data` and `RecordUpdate.data` from Pydantic, stored JSONB data, `str(field.id)` keys in the batch and import paths). Dead code, listed for the owner.
- `validate_record_mutation`, the phase 4 `str(candidate.id)` tie-break changed to `str(None)`: 1 mutant — unreachable default: the partial unique index `uq_fields_module_position_active` gives active fields distinct positions, and only active fields report there.

## app/systems/sandbox/records/importing.py

- `creation_schema_digest`, the six schema key names (`"id"` to `"config"`, two spellings each) and the `separators` argument: 16 mutants — equivalent: the digest is an opaque token that the import compares only with a preview digest from the same code, so another stable spelling or spacing changes nothing a client sees. `tests/catalog/test_record_import_rules.py` owns which field changes alter the digest, including the `sort_keys` rule for nested config.
- `creation_schema_digest`, the `str(item.id)` tie-break changed to `str(None)`: 1 mutant — unreachable default: the partial unique index `uq_fields_module_position_active` gives active fields distinct positions, and closed and relationship fields are left out.
- `_converted_cell`, `int(cell.strip(), 10)` without the base: 1 mutant — equivalent: `int` uses base 10 by default.
- `create_import_records` (the `Field` read, `Record` insert, flush, outbox event and assignment notification): 26 mutants — stack-owned: `tests/catalog/test_record_import_integration.py::test_import_preview_then_mixed_batch_creates_audited_records_and_events` and `::test_import_real_persistence_failure_rolls_back_records_audit_and_events`, and `tests/catalog/test_record_assignment_notifications.py::test_csv_import_notifies_only_valid_created_assignments_and_not_preview` and `::test_failed_csv_batch_rolls_back_first_assignment_notification`.
