"""Representative legacy decimal upgrade, downgrade, and atomic failure behavior."""

import importlib.util
import json
from pathlib import Path
from uuid import uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text


def _invoke_migration(connection, operation):
    (path,) = (Path(__file__).parents[2] / "migrations/versions").glob("*_0015_*.py")
    spec = importlib.util.spec_from_file_location("decimal_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with Operations.context(Operations(MigrationContext.configure(connection))):
        getattr(module, operation)()


@pytest.fixture
def legacy_decimal(integration_db):
    connection = integration_db.connection()
    department, module, field, record = [uuid4() for _ in range(4)]
    connection.execute(
        text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
        {"id": department, "name": str(department)},
    )
    connection.execute(
        text(
            "INSERT INTO public.modules (id, department_id, module_name) VALUES "
            "(:id, :parent, :name)"
        ),
        {"id": module, "parent": department, "name": str(module)},
    )
    connection.execute(
        text(
            "INSERT INTO public.fields (id, module_id, name, type, position, config) "
            "VALUES (:id, :parent, 'legacy', 'decimal', 0, CAST(:config AS jsonb))"
        ),
        {"id": field, "parent": module, "config": json.dumps({"minimum": 1.25, "maximum": None})},
    )
    connection.execute(
        text(
            "INSERT INTO public.records (id, module_id, data) "
            "VALUES (:id, :parent, CAST(:data AS jsonb))"
        ),
        {"id": record, "parent": module, "data": json.dumps({str(field): 1.25})},
    )
    return connection, field, record


@pytest.mark.integration
@pytest.mark.parametrize("closed", [False, True])
def test_decimal_migration_roundtrips_active_and_closed_data(legacy_decimal, closed):
    connection, field, record = legacy_decimal
    if closed:
        for table, identifier in (("fields", field), ("records", record)):
            connection.execute(
                text(f"UPDATE public.{table} SET is_deleted=true, deleted_at=now() WHERE id=:id"),
                {"id": identifier},
            )
    _invoke_migration(connection, "upgrade")
    assert connection.scalar(
        text("SELECT config FROM public.fields WHERE id=:id"), {"id": field}
    ) == {
        "minimum": "1.25",
        "maximum": None,
    }
    assert connection.scalar(
        text("SELECT data FROM public.records WHERE id=:id"), {"id": record}
    ) == {
        str(field): "1.25",
    }
    _invoke_migration(connection, "downgrade")
    assert connection.scalar(
        text("SELECT config FROM public.fields WHERE id=:id"), {"id": field}
    ) == {
        "minimum": 1.25,
        "maximum": None,
    }
    assert connection.scalar(
        text("SELECT data FROM public.records WHERE id=:id"), {"id": record}
    ) == {
        str(field): 1.25,
    }


@pytest.mark.integration
@pytest.mark.parametrize("minimum", ["invalid", 10**39])
def test_decimal_migration_failure_leaves_existing_data_unchanged(legacy_decimal, minimum):
    connection, field, record = legacy_decimal
    invalid = {"minimum": minimum}
    connection.execute(
        text("UPDATE public.fields SET config=CAST(:config AS jsonb) WHERE id=:id"),
        {
            "config": json.dumps(invalid),
            "id": field,
        },
    )
    savepoint = connection.begin_nested()
    with pytest.raises(Exception, match="invalid JSON type|exceeds canonical precision or scale"):
        _invoke_migration(connection, "upgrade")
    savepoint.rollback()
    assert (
        connection.scalar(text("SELECT config FROM public.fields WHERE id=:id"), {"id": field})
        == invalid
    )
    assert connection.scalar(
        text("SELECT data FROM public.records WHERE id=:id"), {"id": record}
    ) == {
        str(field): 1.25,
    }
