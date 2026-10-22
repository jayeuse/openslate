"""Shared PostgreSQL setup and rejection assertions for Comms constraints."""

import pytest
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database.base import Base


def _insert(connection, table, org, **values):
    identity = values.pop("id", uuid7())
    connection.execute(
        Base.metadata.tables[table]
        .insert()
        .values(
            id=identity,
            org_id=org.id,
            **values,
        )
    )
    return identity


def _reject(connection, sqlstate, action):
    with pytest.raises(IntegrityError) as raised, connection.begin_nested():
        action()
    assert raised.value.orig.sqlstate == sqlstate
    assert raised.value.orig.diag.constraint_name
