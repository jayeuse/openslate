"""Permission schema and capability guard contracts."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.common.dependencies import auth as auth_dependencies
from app.common.dependencies.auth import require_capability, require_legacy_capability
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
    user = SimpleNamespace(identity_kind="internal", role=role)

    assert effective_permissions(role) == list(ALL_CAPABILITIES)
    assert all(require_legacy_capability(capability)(user) for capability in Capability)


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


def test_workspace_capability_guard_delegates_to_the_authoritative_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = make_user("reader", permissions={"records.read": True})
    database = object()
    calls: list[tuple[object, object, object, object]] = []

    def authorize(
        db: object,
        *,
        actor_id: object,
        expected_role_id: object,
        capabilities: object,
        **_kwargs: object,
    ) -> object:
        calls.append((db, actor_id, expected_role_id, capabilities))
        return user

    monkeypatch.setattr(auth_dependencies, "authorize_workspace_capabilities", authorize)

    assert require_capability(Capability.RECORDS_READ)(user, database) is user
    assert calls == [(database, user.id, user.role_id, (Capability.RECORDS_READ,))]


@pytest.mark.parametrize(
    "permissions",
    [{}, {"departments.read": True}, {"records.read": "true"}, {"records": {"read": True}}],
    ids=["missing", "unrelated", "non-boolean", "nested"],
)
def test_legacy_capability_guard_rejects_missing_or_malformed_permissions(
    permissions: object,
) -> None:
    user = SimpleNamespace(role=SimpleNamespace(role="editor", permissions=permissions))

    with pytest.raises(HTTPException) as raised:
        require_legacy_capability(Capability.RECORDS_WRITE)(user)

    assert raised.value.status_code == 403


def test_legacy_guard_requires_every_capability_for_combined_board_and_report_actions() -> None:
    read_only = make_user("read_only", permissions={"records.read": True})
    editor = make_user(
        "editor_both",
        permissions={"records.read": True, "records.write": True},
    )
    combined_guard = require_legacy_capability(
        Capability.RECORDS_READ, Capability.RECORDS_WRITE
    )

    with pytest.raises(HTTPException) as raised:
        combined_guard(read_only)

    assert raised.value.status_code == 403
    assert combined_guard(editor) is editor
