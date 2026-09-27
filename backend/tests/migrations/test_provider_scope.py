"""Provider objects must never become application migration targets."""

from unittest.mock import MagicMock

import pytest
from sqlalchemy import Column, Integer, MetaData, Table


def _metadata() -> MetaData:
    metadata = MetaData()
    Table("users", metadata, Column("id", Integer, primary_key=True))
    return metadata


def test_scope_keeps_application_drift_but_excludes_provider_objects() -> None:
    from app.core.database.migration_scope import application_migration_scope

    connection = MagicMock()
    connection.execute.return_value.all.return_value = [
        ("users", True), ("retired_app_table", True), ("provider_table", False),
    ]
    include = application_migration_scope(connection, _metadata())
    assert include(None, "schema", {})
    assert not include("auth", "schema", {})
    assert not include("storage", "schema", {})
    assert include("users", "table", {"schema_name": None})
    assert include("retired_app_table", "table", {"schema_name": None})
    assert not include("provider_table", "table", {"schema_name": None})
    assert not include("users", "table", {"schema_name": "auth"})
    assert not include("provider_column", "column", {
        "schema_name": None, "table_name": "provider_table",
    })
    assert include("id", "column", {"schema_name": None, "table_name": "users"})


def test_scope_rejects_a_provider_table_colliding_with_an_application_model() -> None:
    from app.core.database.migration_scope import application_migration_scope

    connection = MagicMock()
    connection.execute.return_value.all.return_value = [("users", False)]
    with pytest.raises(RuntimeError, match="owned by the application migration role"):
        application_migration_scope(connection, _metadata())
