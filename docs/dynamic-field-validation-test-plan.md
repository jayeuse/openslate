# Dynamic Field Validation Test Plan and Results

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
- module schema acceptance;
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
- changing lifecycle/schema-acceptance policy;
- changing audit redaction policy;
- fixing findings discovered by this test pass.

## Environment and safety

PostgreSQL checks are guarded to the disposable loopback Supabase database on port `54322`, database `postgres`.

Application operations run through `TEST_DATABASE_URL`. Tests that commit fixtures clean only their generated UUIDs through the owner-capable `MIGRATION_DATABASE_URL`. No table-wide reset or user-data cleanup is performed.

Concurrency checks use independent engines, connections, and sessions. They use explicit PostgreSQL row locks and `NOWAIT`; they do not use sleeps or share a SQLAlchemy session between participants.

## Contract traceability

| Rule | Contract | Automated evidence |
|---|---|---|
| R-001 | Supported types are text, number, decimal, int, boolean, date, datetime, select, and relationship; unsupported API input is `422`. | `test_field_schema_accepts_primitive_types`, `test_field_route_returns_clean_422_for_unsupported_type`, `test_field_validators_cover_every_type_and_return_clean_values` |
| R-002 | Field names are trimmed and contain 1–150 characters. | `test_field_schema_trims_name_and_enforces_one_to_150_character_boundaries` |
| R-003 | Position is nonnegative; active module positions are unique. | Existing field schema tests plus `test_direct_sql_can_store_invalid_record_data_but_postgres_rejects_invalid_field_structure` |
| R-004 | Configuration keys are type-specific and unknown/cross-type keys are rejected. | `test_field_schema_rejects_invalid_configuration`, `test_field_config_rejects_cross_type_configuration` |
| R-005 | Select options are a nonempty unique string list and values match exactly. | `test_select_config_preserves_embedded_strings_and_requires_exact_values` |
| R-006 | Number/int reject booleans and non-finite/wrong numeric types and enforce inclusive bounds. | `test_field_validators_cover_every_type_and_return_clean_values`, shared contract fixture |
| R-007 | Decimal values and bounds are canonical strings with 38 integer and 18 fractional digits, no exponent/plus/leading-zero syntax, and exact bounds. | `test_field_config_validates_text_and_canonicalizes_decimal_bounds`, `test_decimal_validation_enforces_lexical_limits_and_exact_bounds`, shared contract fixture |
| R-008 | Text preserves its value and applies configured code-point length bounds. | `test_text_validation_preserves_whitespace_and_counts_unicode_codepoints` |
| R-009 | Boolean/date/datetime require their exact wire types/profile; date and datetime calendar boundaries are checked. | `test_date_validation_accepts_calendar_boundaries_and_rejects_invalid_dates`, `test_datetime_validation_accepts_datetime_boundaries_and_rejects_invalid_dates`, `test_datetime_validation_requires_strict_timezone_aware_profile` |
| R-010 | Relationship metadata is complete, relationship fields are not required, and relationship config is empty. | Existing field schema/module validation tests |
| R-011 | Active field names and positions are unique per module at API and PostgreSQL layers. | Existing create/update tests, direct structural SQL test, `test_committed_duplicate_field_creation_returns_503_then_409_and_keeps_one_active_winner` |
| R-012 | Schema acceptance requires at least one active, structurally valid, contiguous field set. | Existing module schema tests and `test_malformed_db_permitted_config_returns_controlled_schema_acceptance_conflict` |
| R-013 | Unknown top-level field/record properties are currently ignored, while config keys are strict. | `test_top_level_extra_keys_are_ignored_by_field_and_record_schemas` |
| R-014 | Field module and type are immutable through the API; effective changes invalidate acceptance. | Existing field-update tests and `test_effective_field_lifecycle_changes_clear_schema_acceptance` |
| R-015 | Tightened required/config rules cannot invalidate active records. | Existing field-update impact tests |
| R-016 | Reorder requires the complete active field set and normalizes positions. | Existing reorder tests |
| R-017 | Lifecycle close changes field availability but currently does not invalidate schema acceptance. | `test_replacement_update_preserves_closed_values_drops_optional_active_values`, `test_last_active_field_close_is_characterized_as_leaving_empty_record_creation_enabled` |
| R-018 | Record create requires an accepted active module; update does not use acceptance as its gate. | `test_record_create_requires_an_accepted_schema_after_module_lock` and PostgreSQL lifecycle characterization |
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
| R-032 | Migration-preserved explicit-null decimal bounds conflict with current runtime configuration validation in a controlled way. | `test_migrated_explicit_null_decimal_config_is_a_controlled_runtime_conflict` |

## Historical executed results

The following baseline was recorded on 2026-08-31, before the current test-file
split. The historical commands and counts are retained unchanged for comparison
with the current refactor.

| Command | Result |
|---|---|
| `uv run pytest --no-cov tests/test_fields_records.py tests/test_departments_modules.py tests/test_relationships.py` (pre-split grouping) | 116 passed |
| Runtime-role PostgreSQL run of the dynamic, relationship, and decimal migration integration files | 33 passed |
| Owner-role PostgreSQL run of the dynamic and relationship integration files | 27 passed |
| Full backend `pytest` with runtime `TEST_DATABASE_URL` and isolated Supabase-admin environment variables | 382 passed, 2 skipped, 82.08% coverage |
| `uv run ruff check .` | Passed |
| `uv run mypy app scripts` | Passed |
| `uv run alembic check` | Passed; no new upgrade operations |

The historical baseline commands, run from `backend/`, were:

```sh
uv run pytest --no-cov tests/test_fields_records.py tests/test_departments_modules.py tests/test_relationships.py

set -a; source ../.env; set +a
TEST_DATABASE_URL="$DATABASE_URL" uv run pytest --no-cov \
  tests/test_dynamic_field_validation_integration.py \
  tests/test_relationships_integration.py \
  tests/test_migration_0015_contract.py
TEST_DATABASE_URL="$MIGRATION_DATABASE_URL" uv run pytest --no-cov \
  tests/test_dynamic_field_validation_integration.py \
  tests/test_relationships_integration.py

unset SUPABASE_URL SUPABASE_SECRET_KEY
TEST_DATABASE_URL="$DATABASE_URL" uv run pytest

uv run ruff check .
uv run mypy app scripts
uv run alembic check
```

## Current split-file rerun commands

Run the equivalent checks against the current test-module layout from
`backend/`. These commands describe the verification scope; their current
results are recorded separately below and do not replace the historical counts.

```sh
uv run pytest --no-cov \
  tests/test_fields.py \
  tests/test_fields_api_contract.py \
  tests/test_record_validation.py \
  tests/test_records.py \
  tests/test_departments_modules.py \
  tests/test_relationships.py

set -a; source ../.env; set +a
TEST_DATABASE_URL="$DATABASE_URL" uv run pytest --no-cov \
  tests/test_dynamic_field_database_integration.py \
  tests/test_dynamic_field_persistence_integration.py \
  tests/test_dynamic_field_concurrency_integration.py \
  tests/relationships_integration/test_concurrency.py \
  tests/relationships_integration/test_lifecycle.py \
  tests/relationships_integration/test_migration.py \
  tests/relationships_integration/test_mutations.py \
  tests/migration_0015/test_integration.py
TEST_DATABASE_URL="$MIGRATION_DATABASE_URL" uv run pytest --no-cov \
  tests/test_dynamic_field_database_integration.py \
  tests/test_dynamic_field_persistence_integration.py \
  tests/test_dynamic_field_concurrency_integration.py \
  tests/relationships_integration/test_concurrency.py \
  tests/relationships_integration/test_lifecycle.py \
  tests/relationships_integration/test_migration.py \
  tests/relationships_integration/test_mutations.py

unset SUPABASE_URL SUPABASE_SECRET_KEY
TEST_DATABASE_URL="$DATABASE_URL" uv run pytest

uv run ruff check .
uv run mypy app scripts
uv run alembic check
```

The historical full-suite attempt inherited `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from the sourced local environment. That made `test_client_requires_url_and_secret_configuration` observe configured values and fail its expected missing-configuration assertion. Re-running with those two ambient variables unset passed. This is test-environment isolation behavior, not a dynamic-field failure.

## Current backend-refactor evidence

The following evidence was completed on 2026-09-09. It distinguishes the
runtime/network suite from the separate owner-only rollback verification.

| Evidence | Result |
|---|---|
| User-account PostgreSQL verification | 14 passed |
| Invitation transaction PostgreSQL verification | 11 passed |
| Field PostgreSQL verification | 16 passed |
| Registered relationship HTTP/PostgreSQL verification | 7 passed |
| Independent relationship/lifecycle race verification | 4 passed |
| Registered seed/lifecycle/expired-challenge API scenarios | 9 passed; expired challenge cases made no password-provider call |
| Network API smoke against an owned loopback FastAPI process with real local Auth and cleanup | 1 passed |
| Handwritten Python size guard | 207 files scanned; zero over 500 lines; largest file 499 lines |
| Final test collection | 673 collected; baseline 573 |
| Architecture and security static reviews | Closed; no additional finding |
| Existing focused PostgreSQL domain regression | 30 passed; focused existing regression only, not the final registered-route/API gate |
| Final full backend suite | 671 passed, 2 owner-reset skips; separate owner rollback run passed 2/2, covering all 673 collected cases |
| Python 3.12, 3.13, and 3.14 compatibility checks | Each 565 passed, 1 skipped; the existing database-dependent skip remains separately identified |
| Owner rollback-only reset verification | 2 passed; teardown verified baseline counts, admin/role/Auth snapshots, plan digest, and fixture-ID absence after physical rollback; PostgreSQL rollback itself restores the data, and no reset was committed |
| Combined application and six changed-script coverage | 87.41% |
| Changed executable coverage | 83.29% (1,775/2,131 lines; threshold at least 80%) |
| Alembic drift check | Passed; no new upgrade operations |

Frontend pagination and stale-request findings remain deferred pending separate
approval. The provider resend-contract concern remains unverified and is not a
confirmed defect; no provider redesign is included in this verification.

## Confirmed observations

### 1. FastAPI validation protects supported API writes

The expanded value matrix, aggregate mutation tests, and runtime-role PostgreSQL persistence tests passed. Values written through record routes were normalized and stored with expected JSONB types. Invalid API values did not mutate records.

### 2. Direct database access is a trusted bypass boundary

Confirmed with the real `openslate_runtime` login: semantically invalid dynamic record JSON can be inserted directly, and no ORM audit row is created. The transaction was rolled back after verification.

PostgreSQL still rejected its structural field invariants: unsupported field type, negative position, duplicate active name, and duplicate active position.

This is not an HTTP authorization bypass. It means runtime/owner credentials and PostgreSQL network access must remain private because dynamic semantics and ORM audit are application-level controls.

### 3. Last-active-field close leaves acceptance stale

Confirmed current behavior:

1. Accept a module containing one active primitive field.
2. Close that field through lifecycle.
3. `module.is_schema_accepted` remains `true`.
4. Record creation with `{}` succeeds and persists an empty record.

This is an unresolved product-contract/integrity issue because repository documents disagree on whether field lifecycle changes invalidate schema acceptance. The test is explicitly named as a characterization, not a desired invariant.

### 4. Explicit-null decimal migration/runtime mismatch

A persisted decimal config containing `{"minimum": null}` is permitted and preserved by migration `0015`, but current schema acceptance rejects it with controlled `409` detail:

`Module schema is invalid: Decimal minimum must be a valid decimal string`

No unhandled `500` occurred.

### 5. Concurrency outcomes are controlled

Observed deterministic outcomes for field uniqueness and single-target relationship contention:

- contender during held lock: `503`;
- retry after winner commit: `409`;
- final state satisfies active uniqueness/cardinality;
- failed contender produces no domain or audit mutation.

These tests distinguish transient NOWAIT contention from committed-state conflicts and do not assume a predetermined thread winner.

## Remaining risks and limitations

- No application-level total request-body, record-key, module-field, text-byte, option-count, or option-length ceiling currently exists. This pass does not invent thresholds.
- Ordinary browser `number`/`int` values can lose JavaScript precision outside the safe integer range; exact values should use decimal strings.
- Dynamic record audit redaction is UUID-keyed and was not redesigned by this test work.
- PostgreSQL relationship cardinality remains application-enforced rather than constrained directly by the database.
- The suite uses router/service calls plus registered API and real PostgreSQL checks for deterministic concurrency. It does not run a live browser→BFF→FastAPI→database workflow.

## Exit assessment

The tested FastAPI path rejects malformed dynamic data and PostgreSQL preserves the expected normalized result. Structural database constraints and NOWAIT conflict behavior are verified with both runtime and owner execution. The current backend refactor adds targeted registered-route evidence while preserving these dynamic-field contracts; its final full-suite and release-gate results are recorded above.

The suite also establishes, rather than conceals, three boundaries requiring product or operational decisions: direct SQL bypass, stale acceptance after closing the last field, and explicit-null decimal migration compatibility.
