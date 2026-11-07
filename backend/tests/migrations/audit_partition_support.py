"""Shared catalog reads and engines for the audit partition tests."""

import os
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.pool import NullPool
from uuid6 import uuid7

from tests.conftest import guarded_create_engine

DEFAULT_PARTITION = "audit_logs_default"
INSUFFICIENT_PRIVILEGE = "42501"
LOCK_NOT_AVAILABLE = "55P03"
_LEAVES = text(
    "SELECT child.relname FROM pg_catalog.pg_inherits AS link "
    "JOIN pg_catalog.pg_class AS child ON child.oid = link.inhrelid "
    "WHERE link.inhparent = 'public.audit_logs'::regclass ORDER BY 1"
)
_INSERT_ROW = text(
    "INSERT INTO public.audit_logs (id, org_id, created_at, action, entity_type) "
    "VALUES (:id, :org_id, :created_at, 'create', :entity_type)"
)


@dataclass(frozen=True)
class AuditEngines:
    owner: Engine
    runtime: Engine


@pytest.fixture
def audit_engines() -> Iterator[AuditEngines]:
    # NullPool: a lock that a test holds ends with its connection, not with a pooled session.
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"], poolclass=NullPool)
    try:
        yield AuditEngines(owner, runtime)
    finally:
        owner.dispose()
        runtime.dispose()


def leaf_names(connection: Connection) -> list[str]:
    return list(connection.scalars(_LEAVES))


def month_starts(connection: Connection, count: int = 3) -> list[str]:
    """The first day of this month and the next ones, as the database clock says, in UTC."""

    return list(
        connection.scalars(
            text(
                "SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC') "
                "+ make_interval(months => step), 'YYYY-MM-DD') "
                "FROM generate_series(0, :last) AS step ORDER BY step"
            ),
            {"last": count - 1},
        )
    )


def partition_name(first_day: str) -> str:
    year, month, _day = first_day.split("-")
    return f"audit_logs_y{year}m{month}"


def insert_audit_row(
    connection: Connection,
    created_at: str,
    *,
    org_id: UUID | None = None,
    row_id: UUID | None = None,
) -> UUID:
    """Add the smallest valid row; with no organization it is an installation row."""

    identity = row_id or uuid7()
    connection.execute(
        _INSERT_ROW,
        {
            "id": identity,
            "org_id": org_id,
            "created_at": created_at,
            "entity_type": "records" if org_id else "users",
        },
    )
    return identity


def sqlstate(error: DBAPIError) -> Any:
    return getattr(error.orig, "sqlstate", None)
