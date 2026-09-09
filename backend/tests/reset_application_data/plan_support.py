"""Planning helpers shared by reset utility contract tests."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from scripts import reset_application_data as reset

from .support import EMAIL, NON_PRESERVED_TABLES, FakeConnection, _profile


def _database(**changes: Any) -> FakeConnection:
    values: dict[str, Any] = {
        "profile": _profile(),
    }
    values.update(changes)
    return FakeConnection(**values)


def _plan(database: FakeConnection) -> Any:
    return reset.build_reset_plan(database, EMAIL)


def _counts(*, users: int, roles: int = 2) -> dict[str, int]:
    return {table: 3 for table in NON_PRESERVED_TABLES} | {
        "users": users,
        "roles": roles,
    }


PROFILE_SNAPSHOT_FIELDS = (
    "id",
    "created_at",
    "deleted_at",
    "is_deleted",
    "updated_at",
    "performed_by",
    "email",
    "username",
    "status",
    "role_id",
)
ROLE_SNAPSHOT_FIELDS = (
    "id",
    "created_at",
    "deleted_at",
    "is_deleted",
    "updated_at",
    "performed_by",
    "role",
    "permissions",
)


def _rich_profile_snapshot(profile: dict[str, object]) -> SimpleNamespace:
    return SimpleNamespace(**{field: profile[field] for field in PROFILE_SNAPSHOT_FIELDS})


def _rich_role_snapshot(role: dict[str, object]) -> SimpleNamespace:
    return SimpleNamespace(**{field: role[field] for field in ROLE_SNAPSHOT_FIELDS})
