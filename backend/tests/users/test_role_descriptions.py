"""Role description contracts for access administration."""

from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.roles_router as roles_router
from app.common.listing import StandardListRequest, build_standard_list_statements
from app.systems.access.users.models import Role
from app.systems.access.users.roles_router import ROLE_LIST_SPEC, RoleSortField
from app.systems.access.users.schemas import RoleCreate, RoleResponse, RoleUpdate
from tests.users.test_local_identity_users import _role, _user


def test_role_creation_trims_description_and_exposes_it_in_the_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin = _user(_role())
    payload = RoleCreate(role="editor", description="  Can maintain workspace records.  ")
    db = Mock(spec=Session)
    monkeypatch.setattr(roles_router, "require_fresh_exact_admin", lambda *_args: admin)

    result = roles_router.create_role(payload, admin, db)

    created = db.add.call_args.args[0]
    created.id = uuid7()
    created.created_at = datetime.now(UTC)
    created.updated_at = datetime.now(UTC)
    created.is_deleted = False
    assert result is created
    assert created.description == "Can maintain workspace records."
    assert RoleResponse.model_validate(created).description == "Can maintain workspace records."


def test_role_description_whitespace_normalizes_to_null_and_extra_fields_are_rejected() -> None:
    assert RoleCreate(role="editor", description=" \t ").description is None
    assert RoleUpdate(description="\n").description is None

    with pytest.raises(ValidationError):
        RoleCreate.model_validate({"role": "editor", "description": "Useful", "unexpected": True})
    with pytest.raises(ValidationError):
        RoleUpdate.model_validate({"description": "Useful", "unexpected": True})
    with pytest.raises(ValidationError):
        RoleCreate(role="editor", description="x" * 1001)


def test_role_update_can_clear_description_and_preserves_it_when_omitted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin = _user(_role())
    editor = Role(id=uuid7(), role="editor", description="Existing summary", permissions={})
    db = Mock(spec=Session)
    monkeypatch.setattr(roles_router, "require_fresh_exact_admin", lambda *_args: admin)
    monkeypatch.setattr(roles_router, "lock_active_role", lambda *_args: editor)

    roles_router.update_role(editor.id, RoleUpdate(role="content-editor"), admin, db)

    assert editor.role == "content-editor"
    assert editor.description == "Existing summary"

    roles_router.update_role(editor.id, RoleUpdate(description=None), admin, db)

    assert editor.description is None


def test_role_patch_rejects_an_empty_body_and_null_non_nullable_fields() -> None:
    db = Mock(spec=Session)

    for payload in (RoleUpdate(), RoleUpdate(role=None), RoleUpdate(permissions=None)):
        with pytest.raises(HTTPException) as error:
            roles_router.update_role(uuid7(), payload, Mock(), db)
        assert error.value.status_code == 422

    db.scalar.assert_not_called()


def test_role_search_matches_role_names_and_descriptions() -> None:
    items, _ = build_standard_list_statements(
        select(Role),
        StandardListRequest[RoleSortField](search="workspace"),
        ROLE_LIST_SPEC,
    )

    query = str(items.compile(dialect=postgresql.dialect()))

    assert "roles.role ILIKE" in query
    assert "roles.description ILIKE" in query
