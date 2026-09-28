# Dynamic Field Validation Contracts and Testing

## Purpose

This plan verifies the dynamic-field contract at the boundaries that actually enforce it:

1. Pydantic request and field-definition validation.
2. FastAPI field-aware record validation and normalization.
3. PostgreSQL structural constraints, JSONB persistence, transactions, and locks.
4. The direct-SQL trust boundary where application-only semantics and ORM audit can be bypassed.

The backend remains authoritative. Frontend Zod validation is intentionally outside this suite because it is client-side feedback rather than the persistence security boundary.

## Scope and non-goals

In scope:

- all nine field types;
- field configuration and metadata;
- the record-create gate on active fields;
- record create/update replacement semantics;
- closed and relationship fields;
- deterministic error aggregation;
- PostgreSQL persistence and constraints;
- runtime-role direct SQL behavior;
- relationship cardinality and NOWAIT contention;
- decimal migration/runtime compatibility.

Not in scope:

- broad load or penetration testing;
- defining new payload, text, field-count, or option-count limits;
- changing lifecycle policy;
- changing audit redaction policy;
- changing the validation contract as part of test execution.

## Environment and safety

PostgreSQL checks require an explicitly authorized disposable database. The full-stack runner creates an isolated loopback PostgreSQL database with a per-run identity; tests reject unrecognized targets.

Application operations run through `TEST_DATABASE_URL`. Tests that commit fixtures clean only their generated UUIDs through the owner-capable `MIGRATION_DATABASE_URL`. No table-wide reset or user-data cleanup is performed.

Concurrency checks use independent engines, connections, and sessions. They use explicit PostgreSQL row locks and `NOWAIT`; they do not use sleeps or share a SQLAlchemy session between participants.

## Contract traceability

| Rule | Contract | Automated evidence |
|---|---|---|
| R-001 | Supported types are text, number, decimal, int, boolean, date, datetime, select, and relationship. | `test_field_schema_accepts_primitive_types`, `test_field_validators_cover_every_type_and_return_clean_values` |
| R-002 | Field names are trimmed and contain 1–150 characters. | `test_field_schema_trims_name_and_enforces_one_to_150_character_boundaries` |
| R-003 | Position is nonnegative; active module positions are unique. | Existing field schema tests plus `test_direct_sql_can_store_invalid_record_data_but_postgres_rejects_invalid_field_structure` |
| R-004 | Configuration keys are type-specific and unknown/cross-type keys are rejected. | `test_field_config_rejects_invalid_select_options`, `test_field_config_rejects_cross_type_configuration` |
| R-005 | Select options are a nonempty unique string list and values match exactly. | `test_select_config_preserves_embedded_strings_and_requires_exact_values` |
| R-006 | Number/int reject booleans and non-finite/wrong numeric types and enforce inclusive bounds. | `test_field_validators_cover_every_type_and_return_clean_values`, shared contract fixture |
| R-007 | Decimal values and bounds are canonical strings with 38 integer and 18 fractional digits, no exponent/plus/leading-zero syntax, and exact bounds. | `test_field_config_validates_text_and_canonicalizes_decimal_bounds`, `test_decimal_validation_enforces_lexical_limits_and_exact_bounds`, shared contract fixture |
| R-008 | Text preserves its value and applies configured code-point length bounds. | `test_text_validation_preserves_whitespace_and_counts_unicode_codepoints` |
| R-009 | Boolean/date/datetime require their exact wire types/profile; date and datetime calendar boundaries are checked. | `test_date_validation_accepts_calendar_boundaries_and_rejects_invalid_dates`, `test_datetime_validation_accepts_datetime_boundaries_and_rejects_invalid_dates`, `test_datetime_validation_requires_strict_timezone_aware_profile` |
| R-010 | Relationship metadata is complete, relationship fields are not required, and relationship config is empty. | Existing field schema/module validation tests |
| R-011 | Active field names and positions are unique per module in the Sandbox publish and at the PostgreSQL layer. | Publication planning tests and the direct structural SQL test |
| R-012 | A publish requires each active module to have at least one active, structurally valid, contiguous field set. | Existing module schema validator tests and publication tests |
| R-013 | Unknown top-level field/record properties are currently ignored, while config keys are strict. | `test_top_level_extra_keys_are_ignored_by_field_and_record_schemas` |
| R-014 | Fields change only through the Sandbox publish; the field API is read-only. | `test_schema_catalog_routes_are_read_only_in_the_application_contract`, `test_removed_schema_write_routes_are_not_served` |
| R-015 | Tightened required/config rules cannot invalidate active records. | Existing field-update impact tests |
| R-016 | Field order comes only from the Sandbox document positions. | Publication tests |
| R-017 | Field close/reopen transitions preserve stored record values. | `test_replacement_update_preserves_closed_values_drops_optional_active_values` |
| R-018 | Record create requires an active module with at least one active field, checked after the module lock; a publish that creates a module makes it ready for records. | `test_record_create_rejects_module_whose_last_active_field_is_closed`, `test_field_close_and_record_create_serialize_on_parent_module_lock`, `test_record_create_succeeds_right_after_the_publish_that_creates_the_module` |
| R-019 | Record keys are exact field UUID strings; malformed and unknown keys are rejected. | Existing aggregate/deterministic record mutation tests |
| R-020 | Optional primitive null is accepted; required null and required empty text are rejected. | `test_optional_primitive_record_values_accept_null`, `test_required_text_record_values_reject_null_and_empty` |
| R-021 | Every active primitive value uses its registered type validator and normalization. | `test_field_validators_cover_every_type_and_return_clean_values`, shared parity fixture |
| R-022 | Record validation aggregates field errors rather than stopping at the first one. | `test_record_mutation_aggregates_errors_and_normalizes_active_values`, `test_record_mutation_reports_errors_in_deterministic_phases` |
| R-023 | Supplying update `data` replaces active data, removes omitted optional active values, and preserves omitted closed values. | `test_record_update_replaces_active_values_instead_of_merging_them`, `test_replacement_update_preserves_closed_values_drops_optional_active_values` |
| R-024 | Existing closed primitive values may only be resubmitted with exactly equal type and value; changed/new values conflict. | Existing closed-field tests and `test_record_patch_rejects_type_changed_closed_integer_value` |
| R-025 | Relationship fields never accept values in `Record.data`; relationship edges use their own service. | `test_relationship_values_are_rejected_on_record_create_and_update`, shared parity fixture |
| R-026 | Errors have deterministic phases, a 20-item cap, a `truncated` flag, ordinary `422`, and closed-mutation `409`. | Existing error-shape/order tests and `test_record_mutation_caps_deterministic_errors` |
| R-027 | Valid normalized values persist with expected JSONB types and ORM audit data. | `test_router_persists_jsonb_types_and_canonical_decimal_values` |
| R-028 | PostgreSQL enforces field type, nonnegative position, active uniqueness, relationship FKs/self-link/duplicate structure; it does not interpret dynamic record keys. | Dynamic direct-SQL structural test and existing relationship integration contract tests |
| R-029 | Runtime-role direct SQL bypasses FastAPI semantic validation and ORM audit. | `test_runtime_role_can_store_invalid_record_data_without_orm_audit_and_rolls_back` |
| R-030 | Relationship cardinality is application-enforced; all four flag combinations and hidden-edge reservation are covered. | `test_create_accepts_all_four_cardinalities`, `test_create_enforces_both_cardinalities`, existing hidden-edge PostgreSQL test |
| R-031 | Contention can produce `503`; after the winner commits, a retry can produce deterministic `409`, with no losing mutation/audit. | duplicate-field race test and `test_single_target_race_returns_unavailable_then_committed_conflict` |
| R-032 | Explicit-null decimal bounds mean unbounded and are preserved by runtime validation and applied migrations. | `test_migrated_explicit_null_decimal_config_is_an_unbounded_runtime_bound` |

## Running checks

Run focused field and record tests from `backend/` with the repository's pytest
configuration. Database and cross-system checks use the disposable full-stack
runner, which provisions its own database and identities, applies migrations,
and cleans up its resources. See [Testing architecture](architecture/16-testing-architecture.md)
for test layers, commands, isolation, and CI workflows.

## Enforcement boundaries

### 1. FastAPI validation protects supported API writes

Record routes validate and normalize dynamic values before persistence. Invalid values are rejected without changing records; accepted values retain their normalized JSONB types.

### 2. Direct database access is a trusted bypass boundary

Direct SQL through the runtime role can store semantically invalid dynamic record JSON without creating an ORM audit row. Dynamic validation and audit capture belong to the application path.

PostgreSQL separately enforces supported field types, nonnegative positions, and unique active names and positions.

This is not an HTTP authorization bypass. It means runtime/owner credentials and PostgreSQL network access must remain private because dynamic semantics and ORM audit are application-level controls.

### 3. Field lifecycle and record creation

Field close/reopen transitions run under the parent module lock. Creating a record in a
module with zero active fields returns `409` with the detail `Module has no active fields`.
Existing record updates remain supported; data is not rewritten.

### 4. Explicit-null decimal bounds

Explicit `minimum`/`maximum: null` means unbounded. Runtime schema validation preserves
nulls and compares only non-null canonical bounds. Applied migration 0015 is unchanged;
no historical JSON rewrite is required.

### 5. Concurrency outcomes are controlled

Field uniqueness and single-target relationship contention have separate transient and committed-state outcomes:

- contender during held lock: `503`;
- retry after winner commit: `409`;
- committed state must satisfy active uniqueness/cardinality;
- failed contender produces no domain or audit mutation.

These tests distinguish transient NOWAIT contention from committed-state conflicts and do not assume a predetermined thread winner.

## Remaining risks and limitations

- Requests have a 1 MiB total body limit. Separate record-key, module-field, text-byte and option-count limits are not defined.
- Ordinary browser `number`/`int` values can lose JavaScript precision outside the safe integer range; exact values should use decimal strings.
- Dynamic record audit redaction is UUID-keyed.
- PostgreSQL relationship cardinality remains application-enforced rather than constrained directly by the database.
- The suite uses router/service calls plus registered API and real PostgreSQL checks for deterministic concurrency. It does not run a live browser→gateway→FastAPI→database workflow.
