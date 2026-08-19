from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import get_current_user, require_roles
from app.core.security.tokens import (
    create_access_token,
    create_refresh_token,
    decode_access_token,
    decode_refresh_token,
)
from app.systems.users.models import Role, User, UserRole


def test_access_token_round_trip() -> None:
    subject = str(uuid7())
    token = create_access_token(subject)

    assert decode_access_token(token) == subject


def test_decode_access_token_rejects_invalid_token() -> None:
    assert decode_access_token("not-a-token") is None


def test_access_and_refresh_tokens_have_distinct_types() -> None:
    subject = str(uuid7())
    access_token = create_access_token(subject)
    refresh_token = create_refresh_token(subject)

    assert decode_access_token(access_token) == subject
    assert decode_refresh_token(refresh_token) == subject
    assert decode_refresh_token(access_token) is None
    assert decode_access_token(refresh_token) is None


def test_role_dependency_accepts_allowed_role() -> None:
    admin = User(
        username="admin",
        password_hash="digest",
        role=Role(role=UserRole.ADMIN, permissions={}),
    )

    assert require_roles(UserRole.ADMIN)(admin) is admin


def test_role_dependency_rejects_other_role() -> None:
    member = User(
        username="member",
        password_hash="digest",
        role=Role(role=UserRole.MEMBER, permissions={}),
    )

    with pytest.raises(HTTPException) as error:
        require_roles(UserRole.ADMIN)(member)

    assert error.value.status_code == 403


def test_current_user_rejects_deleted_role() -> None:
    role = Role(role=UserRole.MEMBER, permissions={}, is_deleted=True)
    user = User(
        username="deleted-role-user",
        password_hash="digest",
        role=role,
        is_deleted=False,
    )
    user.id = uuid7()
    db = Mock(spec=Session)
    db.scalar.return_value = user

    with pytest.raises(HTTPException) as error:
        get_current_user(create_access_token(str(user.id)), db)

    assert error.value.status_code == 401
