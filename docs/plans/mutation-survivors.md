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

## app/systems/sandbox/designs/validation.py

- `_value_matches_field`, the non-scalar branch `return False` changed to `return True` (lines 444 and 445): 1 mutant — unreachable default: `validate_document` parses a dictionary with `SandboxDocument`, and both callers (`designs/service.py` and `publications/planner.py`) pass a document that Pydantic already validated, whose `TypedValue` admits only `str`, `int`, `float`, `bool` and `None`, so no scenario or literal value reaches this branch. Dead code, listed for the owner.

## app/systems/sandbox/designs/field_validation.py

- `validate_value` and `_validate_numeric_value`, the `DocumentValueError` texts (closed field, required null, required empty string, maxLength, minimum, maximum, step): 7 mutants — internal wording: every caller (`validation._value_matches_field`, `mapping_validation.fields_compatible`, and `_mapping_is_compatible` and `_value_is_valid` in `test_runs/relationships.py`) catches the error and drops its text.
- `validate_value`, the two `valid = False` assignments in the `user` branch changed to `None`: 2 mutants — equivalent: `not valid` is true for both values.
- `validate_value`, `isinstance(value, (int, float)) and not isinstance(value, bool)` changed to `or`: 1 mutant — equivalent: the only extra values that then reach `_validate_numeric_value` are strings of a text, date, select or user field and booleans of a checkbox field; `field_metadata` gives those fields no minimum, maximum or step, so the check does nothing.
- `validate_mapping`, `"text"` and `"long-text"` in the same-kind set (two spellings each): 4 mutants — equivalent: the next clause accepts a text or long-text source into a text or long-text target with the same `_length_fits` test.
- `_numeric_fits`, `source_step is None or target.step <= 0` changed to `and`: 1 mutant — equivalent: with no source step, `numeric_matches_step(None, 0, step)` returns `False` (`Decimal("None")` raises `InvalidOperation`, which it catches), and the schema gives every target step a value above 0.
- `_numeric_fits` and `_validate_numeric_value`, `step <= 0` changed to `step < 0`: 2 mutants — unreachable default: `NumberFieldConfig.step` has `gt=0`, and `numeric_matches_step` refuses a step of 0 in any case.
- `_validate_numeric_value`, the default step of 1 for an integer field (`or True`, `and False`, two spellings of `"integer"`): 4 mutants — equivalent: an integer field admits only `int` values, and `NumberFieldConfig` requires a whole minimum for an integer field, so every value is on a step of 1 from the minimum.

## app/systems/sandbox/designs/mapping_validation.py

- `fields_compatible`, the `"relationship"` label passed to `validate_mapping` (`None` and two spellings): 3 mutants — internal wording: the label appears only in the `DocumentValueError` text, which `fields_compatible` discards.

## app/systems/boards/event_occurrences.py

- `_zone`, `not isinstance(value, str) or not value.strip()` changed to `and`: 1 mutant — equivalent: a non-string value raises `AttributeError` at `.strip()`, which `_event_spec` catches as a corrupt row, and `ZoneInfo` refuses a blank string.
- `_event_spec`, `timezone=None` and `duration=None` on the all-day spec, and `all_day=None`, `duration_days=None` and `duration_days=1` on the timed spec: 5 mutants — equivalent: all-day expansion reads only dates and `duration_days`, timed expansion reads only instants and `duration`, and `None` is false like `False`.
- `_event_spec`, the `.replace(tzinfo=None, fold=0)` on the local start time (without `tzinfo`, without `fold`, `fold=1`), and `_compatible_local_instant` without `fold=0`: 4 mutants — equivalent: `_compatible_local_instant` sets `tzinfo` and `fold=0` on the combined wall time, and the stored local start time already has `fold=0`, so each normalization alone gives the same instant.
- `_timed_window`, `end is None or end <= start` changed to `end is None and end <= start`, and `end <= start` changed to `end < start`: 2 mutants — unreachable default: when the start midnight has a UTC instant, the later end midnight also has one (`date.max` takes its own branch), and a local day is never zero or less long. The `end <= start` test is dead code, listed for the owner.
- `_recurrence_search_start`, the all-day `duration_days - 1` changed to `+ 1`, the timed `is None` changed to `is not None`, the one-day margin changed to `None` or `2`; the expansion passing `None` as the window-start instant (two spellings); and the first daily or weekly candidate `start_date + periods * step` changed to `-`: 7 mutants — equivalent: each only starts the search earlier (at worst at or before the anchor); `add` rechecks every candidate against the window, and candidates before the real search start end before the window. Only the loop length changes.
- `_occurrence`, `start_at is None or end_at is None` changed to `and`: 1 mutant — unreachable default: `add` passes both instants for a timed occurrence. Dead code, listed for the owner.
- `expand_board_event_occurrences`, timed window bounds also computed for an all-day event (`spec.all_day and False`): 1 mutant — equivalent: all-day overlap and search start read only dates.
- `add`, `recurring=None` passed to `_occurrence` for an all-day event, and `add(spec.start_date, recurring=None)` for a single event: 2 mutants — equivalent: an all-day occurrence ignores the flag, and `None` is false like `False`.
- `add`, `return False` changed to `return True` after an `OverflowError` (all-day end date, timed start, timed end): 3 mutants — equivalent: candidates only move later, so every later candidate overflows too; stopping the loop there gives the same occurrences.
- `add`, `return False` changed to `return True` for an all-day candidate outside the window: 1 mutant — equivalent: a single event ignores the return value, and every recurring all-day candidate lies between the search start and `last_date`, so it always overlaps the window.
- `add`, the `local_start_time is None` return, the `occurrence_start is None` and `occurrence_end is None` tests before the bounds check (two `and` spellings), and the `occurrence is None` return: 4 mutants — unreachable default: a timed spec always has a local start time, both instants are set when the bounds check runs, and `_occurrence` returns `None` only for an overflow that `add` already refused. Dead code, listed for the owner.
- `add`, `return True` changed to `return False` when the limit is full: 1 mutant — equivalent: `truncated` is already `True`, and later candidates only set it again; the result is the same, only the loop is longer.
- `expand_board_event_occurrences`, the `spec.repeat_until is None` return (lines 323 and 324; `None` occurrences, `None` or `True` truncated, missing arguments): 5 mutants — unreachable default: `_event_spec` refuses a recurring row without `repeat_until`. Dead code, listed for the owner.

## app/systems/boards/portability.py

- `_unique_object` and `_invalid_json_constant`, the `ValueError` texts (`None` and three spellings each): 8 mutants — internal wording: `parse_portable_board` catches the `ValueError` and raises `PortabilityError("board_bundle_invalid")`, so the text never reaches the route.
- `parse_portable_board`, `raw.decode("utf-8")` changed to `"UTF-8"`: 1 mutant — equivalent: both names select the same codec.
- `_departments`, `_modules` and `_fields`, the row-selection predicates (the department name `IN`, the module department ID and name pairs, the field module ID and name pairs; each removed, set to `None` or negated with `!=`) and `select(None)`: 21 mutants — stack-owned: the mock session in the stack-free tests returns fixed rows, so only PostgreSQL shows which rows match. `tests/boards/test_portability_routes.py::test_import_creates_a_project_board_and_widgets_in_one_audited_transaction` and `::test_managers_export_and_administrators_duplicate_every_widget`, and `tests/boards/test_portability_contract.py::test_normalized_multiwidget_or_commit_failure_is_atomic` resolve real rows. A removed name or ID predicate fails there only when another active row shares the other half of the pair; those fixtures have one candidate row (gap reported to the owner, 2026-10-12).
- `_modules`, `key = (department_name, row.module_name) if ... or True`: 1 mutant — equivalent: a row without a selected department then gets the key `(None, name)`, which is not in `sources` either, so it is skipped the same way.
- `_modules` and `_fields`, the `continue` for an unselected row changed to `break`, and `references.get(row.module_id, set())` without the `set()` default (two spellings): 4 mutants — unreachable default: the `WHERE` clause returns only the selected department and module pairs and module and field-name pairs, so no returned row is outside `sources` or `references`. Dead code, listed for the owner.
- `resolve_portable_board`, the `PortabilityError` code in `except ValidationError` (lines 219 and 220; `None` and two spellings): 3 mutants — unreachable default: every live rule that `inline_config` and `BoardWidgetSpec` check has a portable mirror that `parse_portable_board` already applies (distinct fields, primitive types, measure pairs, query windows, widget type and size, name length after strip), and `_filter` turns its own `ValidationError` into `PortabilityError`. Dead code, listed for the owner.
