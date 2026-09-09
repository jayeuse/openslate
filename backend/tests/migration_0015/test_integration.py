import importlib.util
import os
from pathlib import Path
from types import ModuleType
from uuid import uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text
from sqlalchemy.orm import Session

MIGRATIONS = Path(__file__).parents[2] / "migrations" / "versions"


def _migration_path() -> Path:
    matches = sorted(MIGRATIONS.glob("*_0015_*.py"))
    assert len(matches) == 1
    return matches[0]


def _migration_module() -> ModuleType:
    path = _migration_path()
    spec = importlib.util.spec_from_file_location("migration_0015_runtime", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _invoke_migration(connection, operation: str) -> None:
    with Operations.context(Operations(MigrationContext.configure(connection))):
        getattr(_migration_module(), operation)()


def _insert_field(
    connection,
    field_id,
    module_id,
    name: str,
    config: str,
    *,
    deleted: bool = False,
    position: int,
) -> None:
    connection.execute(
        text(
            """
            INSERT INTO public.fields (
                id, module_id, name, type, position, config, is_deleted, deleted_at
            )
            VALUES (:id, :module_id, :name, 'decimal', :position, CAST(:config AS jsonb), :deleted,
                    CASE WHEN :deleted THEN CURRENT_TIMESTAMP ELSE NULL END)
            """
        ),
        {
            "id": field_id,
            "module_id": module_id,
            "name": name,
            "position": position,
            "config": config,
            "deleted": deleted,
        },
    )


def _insert_record(
    connection,
    record_id,
    module_id,
    data: str,
    *,
    deleted: bool = False,
) -> None:
    connection.execute(
        text(
            """
            INSERT INTO public.records (id, module_id, data, is_deleted, deleted_at)
            VALUES (:id, :module_id, CAST(:data AS jsonb), :deleted,
                    CASE WHEN :deleted THEN CURRENT_TIMESTAMP ELSE NULL END)
            """
        ),
        {"id": record_id, "module_id": module_id, "data": data, "deleted": deleted},
    )


@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("TEST_DATABASE_URL") is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_decimal_migration_rewrites_legacy_numbers_and_roundtrips_without_lifecycle_filters(
    integration_db: Session,
) -> None:
    connection = integration_db.connection()
    department_id, module_id = uuid4(), uuid4()
    minimum_only, null_bound, maximum_boundary, closed_field = [uuid4() for _ in range(4)]
    active_record, deleted_record, empty_record = [uuid4() for _ in range(3)]
    maximum_integer = "9" * 38 + "." + "9" * 18
    maximum_scale = "0." + "0" * 17 + "1"

    connection.execute(
        text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
        {"id": department_id, "name": f"migration-0015-{department_id}"},
    )
    connection.execute(
        text(
            "INSERT INTO public.modules (id, department_id, module_name) "
            "VALUES (:id, :department_id, :name)"
        ),
        {"id": module_id, "department_id": department_id, "name": f"migration-0015-{module_id}"},
    )
    _insert_field(
        connection,
        minimum_only,
        module_id,
        "minimum only",
        '{"minimum":1e-3}',
        position=0,
    )
    _insert_field(
        connection,
        null_bound,
        module_id,
        "null bound",
        '{"maximum":null}',
        position=1,
    )
    _insert_field(
        connection,
        maximum_boundary,
        module_id,
        "maximum boundary",
        f'{{"minimum":{maximum_integer},"maximum":{maximum_scale}}}',
        deleted=True,
        position=2,
    )
    _insert_field(
        connection,
        closed_field,
        module_id,
        "closed field",
        '{"minimum":1.0000}',
        deleted=True,
        position=3,
    )
    _insert_record(
        connection,
        active_record,
        module_id,
        "{"
        f'"{minimum_only}":1e-3,'
        f'"{null_bound}":null,'
        f'"{maximum_boundary}":{maximum_integer},'
        f'"{closed_field}":1.0000,'
        '"unrelated":1e-3'
        "}",
    )
    _insert_record(
        connection,
        deleted_record,
        module_id,
        f'{{"{minimum_only}":2.5000e+1}}',
        deleted=True,
    )
    _insert_record(connection, empty_record, module_id, "{}")

    _invoke_migration(connection, "upgrade")
    upgraded = connection.execute(
        text(
            """
            SELECT
                (SELECT config->>'minimum'
                   FROM public.fields
                  WHERE id = :minimum_only_id) AS minimum_only,
                (SELECT config ? 'maximum'
                   FROM public.fields
                  WHERE id = :minimum_only_id) AS minimum_has_maximum,
                (SELECT jsonb_typeof(config->'maximum')
                   FROM public.fields
                  WHERE id = :null_bound_id) AS null_bound_type,
                (SELECT config ? 'minimum'
                   FROM public.fields
                  WHERE id = :null_bound_id) AS null_bound_has_minimum,
                (SELECT config->>'minimum'
                   FROM public.fields
                  WHERE id = :maximum_boundary_id) AS maximum_integer,
                (SELECT config->>'maximum'
                   FROM public.fields
                  WHERE id = :maximum_boundary_id) AS maximum_scale,
                (SELECT jsonb_typeof(data->:minimum_only_key)
                   FROM public.records
                  WHERE id = :active_record_id) AS active_type,
                (SELECT data->>:minimum_only_key
                   FROM public.records
                  WHERE id = :active_record_id) AS active_value,
                (SELECT jsonb_typeof(data->:null_bound_key)
                   FROM public.records
                  WHERE id = :active_record_id) AS null_value_type,
                (SELECT data->>:minimum_only_key
                   FROM public.records
                  WHERE id = :deleted_record_id) AS deleted_value,
                (SELECT data->>:maximum_boundary_key
                   FROM public.records
                  WHERE id = :active_record_id) AS maximum_record,
                (SELECT jsonb_typeof(data->'unrelated')
                   FROM public.records
                  WHERE id = :active_record_id) AS unrelated_type,
                (SELECT data
                   FROM public.records
                  WHERE id = :empty_record_id) AS empty_data,
                (SELECT is_deleted
                   FROM public.fields
                  WHERE id = :closed_field_id) AS closed_field,
                (SELECT is_deleted
                   FROM public.records
                  WHERE id = :deleted_record_id) AS deleted_record
            """
        ),
        {
            "minimum_only_id": minimum_only,
            "minimum_only_key": str(minimum_only),
            "null_bound_id": null_bound,
            "null_bound_key": str(null_bound),
            "maximum_boundary_id": maximum_boundary,
            "maximum_boundary_key": str(maximum_boundary),
            "active_record_id": active_record,
            "deleted_record_id": deleted_record,
            "empty_record_id": empty_record,
            "closed_field_id": closed_field,
        },
    ).one()
    assert upgraded.minimum_only == "0.001"
    assert upgraded.minimum_has_maximum is False
    assert upgraded.null_bound_type == "null"
    assert upgraded.null_bound_has_minimum is False
    assert upgraded.maximum_integer == maximum_integer
    assert upgraded.maximum_scale == maximum_scale
    assert upgraded.active_type == "string" and upgraded.active_value == "0.001"
    assert upgraded.null_value_type == "null"
    assert upgraded.deleted_value == "25"
    assert upgraded.maximum_record == maximum_integer
    assert upgraded.unrelated_type == "number"
    assert upgraded.empty_data == {}
    assert upgraded.closed_field is True and upgraded.deleted_record is True

    _invoke_migration(connection, "downgrade")
    downgraded = connection.execute(
        text(
            """
            SELECT
                (SELECT jsonb_typeof(config->'minimum')
                   FROM public.fields
                  WHERE id = :minimum_only_id) AS minimum_type,
                (SELECT config->>'minimum'
                   FROM public.fields
                  WHERE id = :minimum_only_id) AS minimum_value,
                (SELECT config ? 'maximum'
                   FROM public.fields
                  WHERE id = :minimum_only_id) AS minimum_has_maximum,
                (SELECT jsonb_typeof(config->'maximum')
                   FROM public.fields
                  WHERE id = :null_bound_id) AS null_bound_type,
                (SELECT config ? 'minimum'
                   FROM public.fields
                  WHERE id = :null_bound_id) AS null_bound_has_minimum,
                (SELECT jsonb_typeof(data->:minimum_only_key)
                   FROM public.records
                  WHERE id = :active_record_id) AS active_type,
                (SELECT data->>:minimum_only_key
                   FROM public.records
                  WHERE id = :active_record_id) AS active_value,
                (SELECT jsonb_typeof(data->:null_bound_key)
                   FROM public.records
                  WHERE id = :active_record_id) AS null_value_type,
                (SELECT jsonb_typeof(data->:minimum_only_key)
                   FROM public.records
                  WHERE id = :deleted_record_id) AS deleted_type,
                (SELECT jsonb_typeof(data->:maximum_boundary_key)
                   FROM public.records
                  WHERE id = :active_record_id) AS maximum_record_type,
                (SELECT data
                   FROM public.records
                  WHERE id = :empty_record_id) AS empty_data
            """
        ),
        {
            "minimum_only_id": minimum_only,
            "minimum_only_key": str(minimum_only),
            "null_bound_id": null_bound,
            "null_bound_key": str(null_bound),
            "maximum_boundary_key": str(maximum_boundary),
            "active_record_id": active_record,
            "deleted_record_id": deleted_record,
            "empty_record_id": empty_record,
        },
    ).one()
    assert downgraded.minimum_type == "number" and downgraded.minimum_value == "0.001"
    assert downgraded.minimum_has_maximum is False
    assert downgraded.null_bound_type == "null"
    assert downgraded.null_bound_has_minimum is False
    assert downgraded.active_type == "number" and downgraded.active_value == "0.001"
    assert downgraded.null_value_type == "null"
    assert downgraded.deleted_type == "number"
    assert downgraded.maximum_record_type == "number"
    assert downgraded.empty_data == {}


@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("TEST_DATABASE_URL") is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_decimal_migration_rolls_back_before_mutating_on_invalid_type_or_precision(
    integration_db: Session,
) -> None:
    connection = integration_db.connection()
    department_id, module_id = uuid4(), uuid4()
    valid_field, invalid_field = uuid4(), uuid4()
    valid_record = uuid4()
    connection.execute(
        text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
        {"id": department_id, "name": f"migration-0015-invalid-{department_id}"},
    )
    connection.execute(
        text(
            "INSERT INTO public.modules (id, department_id, module_name) "
            "VALUES (:id, :department_id, :name)"
        ),
        {
            "id": module_id,
            "department_id": department_id,
            "name": f"migration-0015-invalid-{module_id}",
        },
    )
    _insert_field(connection, valid_field, module_id, "valid", '{"minimum":1.2300}', position=0)
    _insert_field(
        connection,
        invalid_field,
        module_id,
        "invalid type",
        '{"minimum":"not-a-number"}',
        position=1,
    )
    _insert_record(connection, valid_record, module_id, f'{{"{valid_field}":1.2300}}')
    before = connection.execute(
        text(
            """
            SELECT
                (SELECT config FROM public.fields WHERE id = :valid_field) AS valid_config,
                (SELECT config FROM public.fields WHERE id = :invalid_field) AS invalid_config,
                (SELECT data FROM public.records WHERE id = :valid_record) AS valid_data
            """
        ),
        {"valid_field": valid_field, "invalid_field": invalid_field, "valid_record": valid_record},
    ).one()

    invalid_type_savepoint = connection.begin_nested()
    with pytest.raises(Exception, match="invalid JSON type"):
        _invoke_migration(connection, "upgrade")
    invalid_type_savepoint.rollback()
    after_invalid_type = connection.execute(
        text(
            """
            SELECT
                (SELECT config FROM public.fields WHERE id = :valid_field) AS valid_config,
                (SELECT config FROM public.fields WHERE id = :invalid_field) AS invalid_config,
                (SELECT data FROM public.records WHERE id = :valid_record) AS valid_data
            """
        ),
        {"valid_field": valid_field, "invalid_field": invalid_field, "valid_record": valid_record},
    ).one()
    assert after_invalid_type == before

    connection.execute(text("DELETE FROM public.fields WHERE id = :id"), {"id": invalid_field})
    invalid_record = uuid4()
    _insert_record(connection, invalid_record, module_id, f'{{"{valid_field}":true}}')
    invalid_record_savepoint = connection.begin_nested()
    with pytest.raises(Exception, match="invalid JSON type"):
        _invoke_migration(connection, "upgrade")
    invalid_record_savepoint.rollback()
    after_invalid_record = connection.execute(
        text(
            """
            SELECT
                (SELECT config FROM public.fields WHERE id = :valid_field) AS valid_config,
                (SELECT data FROM public.records WHERE id = :invalid_record) AS invalid_data,
                (SELECT data FROM public.records WHERE id = :valid_record) AS valid_data
            """
        ),
        {
            "valid_field": valid_field,
            "invalid_record": invalid_record,
            "valid_record": valid_record,
        },
    ).one()
    assert after_invalid_record.valid_config == before.valid_config
    assert after_invalid_record.invalid_data == {str(valid_field): True}
    assert after_invalid_record.valid_data == before.valid_data
    connection.execute(text("DELETE FROM public.records WHERE id = :id"), {"id": invalid_record})

    oversized_field = uuid4()
    _insert_field(
        connection,
        oversized_field,
        module_id,
        "oversized",
        f'{{"minimum":{"1" + "0" * 38}}}',
        position=1,
    )
    oversized_savepoint = connection.begin_nested()
    with pytest.raises(Exception, match="exceeds canonical precision or scale"):
        _invoke_migration(connection, "upgrade")
    oversized_savepoint.rollback()
    after_oversized = connection.execute(
        text(
            """
            SELECT
                (SELECT config FROM public.fields WHERE id = :valid_field) AS valid_config,
                (SELECT config FROM public.fields WHERE id = :oversized_field) AS oversized_config,
                (SELECT data FROM public.records WHERE id = :valid_record) AS valid_data
            """
        ),
        {
            "valid_field": valid_field,
            "oversized_field": oversized_field,
            "valid_record": valid_record,
        },
    ).one()
    assert after_oversized.valid_config == before.valid_config
    assert after_oversized.oversized_config == {"minimum": int("1" + "0" * 38)}
    assert after_oversized.valid_data == before.valid_data
