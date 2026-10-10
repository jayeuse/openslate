# Dynamic Field Validation Contracts and Testing

## Purpose and scope

Verify the current dynamic-field contract at the enforcing boundaries:
Sandbox/Pydantic definitions, field-aware record normalization, registered
FastAPI requests, and PostgreSQL persistence/locks. The backend is authoritative;
frontend validation is user feedback, not the persistence security boundary.

[`FieldType`](../backend/app/systems/sandbox/fields/models.py) has 13 values:
`text`, `long_text`, `email`, `url`, `number`, `decimal`, `int`, `boolean`,
`date`, `datetime`, `select`, `user`, and `relationship`. Primitive record
values use [`fields/validation.py`](../backend/app/systems/sandbox/fields/validation.py)
and [`mutation_validation.py`](../backend/app/systems/sandbox/records/mutation_validation.py).
Relationship edges use their own service, never `Record.data`.

In scope are definition/configuration, active-field creation gates, full-value
record saves, closed values, deterministic errors, JSONB persistence,
relationship visibility/cardinality, user eligibility, and concurrency.
Do not introduce new limits, lifecycle policy, audit rules, load testing or
penetration testing merely to execute this plan.

## Current contract and retained tests

Test names below identify checked-in protection, not a claim that this document
executed it. The old nine-type inventory and removed CRUD-schema tests are not
the current test list.

| Boundary | Contract | Existing test source and named cases |
|---|---|---|
| Definition and configuration | Type-specific configuration rejects cross-type/unknown keys. Active module fields have unique names/positions and structurally valid relationship metadata. | [`test_fields.py`](../backend/tests/catalog/test_fields.py): `test_field_config_rejects_cross_type_configuration`, `test_module_schema_validator_checks_active_field_structure`, `test_module_schema_validator_reuses_field_config_and_relationship_metadata`. |
| Select | Options have stable UUID IDs and labels; records store IDs, not labels. Duplicate labels are rejected. | [`test_fields.py`](../backend/tests/catalog/test_fields.py): `test_select_option_ids_are_stable_values_and_duplicate_labels_are_rejected`. |
| Text, long text, email, URL | Values/defaults obey their own format and configured constraints; text is not silently trimmed as record normalization. | [`test_record_validation.py`](../backend/tests/catalog/test_record_validation.py): `test_text_like_defaults_must_satisfy_their_field_constraints`, `test_field_config_validates_text_and_canonicalizes_decimal_bounds`; [`test_field_validation.py`](../backend/tests/sandbox_designs/test_field_validation.py): `test_portable_values_cover_supported_types_constraints_and_invalid_dates`. |
| Number and integer | Reject booleans/non-finite/wrong wire types; enforce bounds and configured steps; normalize defaults. | [`test_record_validation.py`](../backend/tests/catalog/test_record_validation.py): `test_numeric_defaults_are_normalized_and_enforce_bounds_and_steps`, `test_shared_record_field_validation_cases`; [shared parity fixture](../contracts/record-field-validation-cases.json). |
| Decimal | Canonical string, up to 38 integer and 18 fractional digits; no exponent/plus/leading-zero syntax, with exact inclusive bounds. | [`test_record_validation.py`](../backend/tests/catalog/test_record_validation.py): `test_decimal_validation_enforces_lexical_limits_and_exact_bounds`; [`test_fields.py`](../backend/tests/catalog/test_fields.py): `test_record_route_rejects_numeric_json_for_decimal_field`. |
| Boolean, date and datetime | Exact value types and calendar validity. Designer-compatible datetime syntax and offset-equivalent instants use the current validator, not a blanket timezone-required claim. | [`test_record_validation.py`](../backend/tests/catalog/test_record_validation.py): `test_operational_date_and_datetime_constraints_match_designer_values`, `test_shared_record_field_validation_cases`; [`test_field_validation.py`](../backend/tests/sandbox_designs/test_field_validation.py): `test_datetime_values_accept_designer_syntax_and_compare_timezone_offsets_as_instants`. |
| User | Assigned user UUIDs must remain eligible current module readers; picker results do not authorize a subsequent write. | [`test_user_field_integration.py`](../backend/tests/catalog/test_user_field_integration.py): `test_assignable_picker_and_record_writes_follow_current_module_readers`. |
| Request schemas | Record request extras are rejected, not ignored. Departments/modules/fields expose read-only catalog routes; schema writes happen through Sandbox publish. | [`test_request_schema_contracts.py`](../backend/tests/catalog/test_request_schema_contracts.py): `test_write_schemas_accept_declared_inputs_and_reject_unknown_top_level_fields`, `test_unknown_write_fields_return_fastapi_422`; [`test_fields_api_contract.py`](../backend/tests/catalog/test_fields_api_contract.py): `test_schema_catalog_routes_are_read_only_in_the_application_contract`, `test_removed_schema_write_routes_are_not_served`. |
| Publish and active structure | Publish validates active contiguous structure and impact on existing records. Record create requires an active module with at least one active field after its lock. | [`test_publication_planning_integration.py`](../backend/tests/sandbox_publications/test_publication_planning_integration.py): `test_preview_blocks_a_required_field_added_to_a_module_with_live_records`, `test_publish_keeps_active_positions_contiguous_after_closing_an_earlier_field`; [`test_publication_operational_access.py`](../backend/tests/sandbox_publications/test_publication_operational_access.py): `test_record_create_succeeds_right_after_the_publish_that_creates_the_module`. |
| Null/required values and exact keys | Optional values accept null; required text rejects null/empty; unknown keys and relationship values cannot enter record data. | [`test_record_validation.py`](../backend/tests/catalog/test_record_validation.py): `test_optional_primitive_record_values_accept_null`, `test_required_text_record_values_reject_null_and_empty`, `test_record_data_validation_rejects_unknown_relationship_and_missing_required_values`. |
| Full-value saves and closed fields | Supplying `data` replaces active values, drops omitted optional active values, and preserves omitted closed values. A changed type/value for a closed field conflicts. | [`test_dynamic_field_persistence_integration.py`](../backend/tests/catalog/test_dynamic_field_persistence_integration.py): `test_replacement_update_preserves_closed_values_drops_optional_active_values`; [`test_record_validation.py`](../backend/tests/catalog/test_record_validation.py): `test_record_patch_rejects_type_changed_closed_integer_value`. |
| Error collection | Aggregate errors in deterministic phases with a 20-item cap and `truncated`; ordinary invalid values return 422 and closed mutations conflict. | [`test_record_validation.py`](../backend/tests/catalog/test_record_validation.py): `test_record_mutation_aggregates_errors_and_normalizes_active_values`, `test_record_mutation_caps_deterministic_errors`. |
| JSONB and explicit-null decimal bounds | Accepted normalized values persist with their JSONB types. Explicit-null minimum/maximum means unbounded. | [`test_dynamic_field_persistence_integration.py`](../backend/tests/catalog/test_dynamic_field_persistence_integration.py): `test_router_persists_jsonb_types_and_canonical_decimal_values`; [`test_dynamic_field_database_integration.py`](../backend/tests/catalog/test_dynamic_field_database_integration.py): `test_migrated_explicit_null_decimal_config_is_an_unbounded_runtime_bound`. |
| Lifecycle and create concurrency | Field close and record creation serialize on the parent module; zero active fields reject creation without rewriting stored records. | [`test_dynamic_field_concurrency_integration.py`](../backend/tests/catalog/test_dynamic_field_concurrency_integration.py): `test_field_close_and_record_create_serialize_on_parent_module_lock`; [`test_dynamic_field_persistence_integration.py`](../backend/tests/catalog/test_dynamic_field_persistence_integration.py): `test_record_create_rejects_module_whose_last_active_field_is_closed`. |
| Relationships | Structural self/duplicate constraints are PostgreSQL-backed; cardinality and hidden-edge reservations are enforced by the service. | [`test_mutations.py`](../backend/tests/relationships_integration/test_mutations.py): `test_postgres_constraints_reject_self_and_active_duplicates`, `test_relationship_cardinality_rejects_a_second_edge`; [`test_relationships_cross_department_http.py`](../backend/tests/relationships_integration/test_relationships_cross_department_http.py): `test_cardinality_conflict_with_a_hidden_cross_department_link_reveals_no_record`. |
| Relationship contention | A held NOWAIT lock may produce 503; after the winner commits a retry may produce a deterministic 409 with no losing mutation. | [`test_concurrency.py`](../backend/tests/relationships_integration/test_concurrency.py): `test_single_target_race_returns_unavailable_then_committed_conflict`. |

## Environment, safety and running checks

Use the [testing architecture](architecture/16-testing-architecture.md): focused
pytest checks from `backend/` and the guarded disposable Supabase/PostgreSQL
runner for database guarantees. It provisions an isolated per-run identity,
applies the active migrations and rejects unrecognized targets. Never use a
personal/customer database or SQLite. Fixture cleanup is limited to owned IDs.
Concurrency checks use independent engines/connections/sessions and explicit
locks, not sleeps or a shared SQLAlchemy session.

Run only the affected batch while repairing; full coverage and real-stack
acceptance belong to their owning gate. See [migration guidance](../backend/migrations/AGENTS.md).
The explicit-null decimal behavior is verified at the active migrated state;
archived migration numbering is not a current command target.

## Enforcement boundaries and remaining limitations

- Direct SQL is a trusted bypass boundary: it can evade FastAPI dynamic-value
  semantics and ORM audit. PostgreSQL separately constrains field types,
  positions, active uniqueness, relationship metadata and foreign keys. Keep
  runtime/owner credentials and network access private. This is not an HTTP
  authorization bypass or a claim that retired direct-SQL tests still exist.
- Relationship cardinality is application-enforced, not a standalone database
  cardinality constraint.
- The total request body is bounded; this plan defines no separate module-field,
  text-byte or option-count limits.
- Browser numeric values can lose precision outside the safe integer range;
  exact decimal values use strings.
- Router/service and PostgreSQL tests prove their own boundaries. They do not
  establish a live browser→gateway→FastAPI→database journey; use the real-stack
  acceptance procedure for that claim.
