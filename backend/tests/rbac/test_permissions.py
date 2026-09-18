"""Permission schema and capability guard contracts."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.common.dependencies.auth import require_capability
from app.systems.access.users.models import UserRole
from app.systems.access.users.permissions import (
    ALL_CAPABILITIES,
    Capability,
    effective_permissions,
)
from app.systems.access.users.schemas import RoleCreate, RoleUpdate

from .support import make_role, make_user


def test_role_schemas_accept_finite_flat_boolean_capabilities() -> None:
    permissions = {capability: index % 2 == 0 for index, capability in enumerate(ALL_CAPABILITIES)}

    assert RoleCreate(role="editor", permissions=permissions).permissions == permissions
    assert RoleUpdate(permissions=permissions).permissions == permissions


@pytest.mark.parametrize(
    "permissions",
    [
        {"unknown.read": True},
        {"records": {"read": True}},
        {"records.read": "true"},
    ],
    ids=["unknown", "nested", "non-boolean"],
)
@pytest.mark.parametrize("schema", [RoleCreate, RoleUpdate], ids=["create", "update"])
def test_role_schemas_reject_unknown_nested_and_non_boolean_capabilities(
    schema: type[RoleCreate] | type[RoleUpdate],
    permissions: dict[str, Any],
) -> None:
    values: dict[str, Any] = {"permissions": permissions}
    if schema is RoleCreate:
        values["role"] = "editor"

    with pytest.raises(ValidationError):
        schema.model_validate(values)


@pytest.mark.parametrize(
    "permissions",
    [
        None,
        [],
        {"records": {"read": True}},
        {"records.read": "true"},
        {"unknown.read": True},
    ],
    ids=["none", "list", "nested", "non-boolean", "unknown"],
)
def test_malformed_persisted_permissions_are_effectively_zero(permissions: object) -> None:
    role = SimpleNamespace(role="editor", permissions=permissions)

    assert effective_permissions(role) == []


def test_admin_effective_permissions_are_all_even_when_persisted_document_is_malformed() -> None:
    role = SimpleNamespace(role=UserRole.ADMIN, permissions={"records": {"read": "not-a-boolean"}})
    user = SimpleNamespace(role=role)

    assert effective_permissions(role) == list(ALL_CAPABILITIES)
    assert all(require_capability(capability)(user) for capability in Capability)


def test_effective_permissions_are_deterministic_and_sorted() -> None:
    role = make_role(
        "editor",
        {
            "records.write": True,
            "departments.read": True,
            "records.read": False,
        },
    )

    assert effective_permissions(role) == ["departments.read", "records.write"]


def test_require_capability_accepts_a_permitted_non_admin() -> None:
    user = make_user("reader", permissions={"records.read": True})

    assert require_capability(Capability.RECORDS_READ)(user) is user


@pytest.mark.parametrize(
    "permissions",
    [{}, {"departments.read": True}, {"records.read": "true"}, {"records": {"read": True}}],
    ids=["missing", "unrelated", "non-boolean", "nested"],
)
def test_require_capability_rejects_missing_or_malformed_permissions(
    permissions: object,
) -> None:
    user = SimpleNamespace(role=SimpleNamespace(role="editor", permissions=permissions))

    with pytest.raises(HTTPException) as raised:
        require_capability(Capability.RECORDS_WRITE)(user)

    assert raised.value.status_code == 403


