import pytest
from fastapi import HTTPException
from uuid6 import uuid7

from app.common.dependencies import require_roles
from app.core.security.tokens import create_access_token, decode_access_token
from app.systems.users.models import Role, User, UserRole


def test_access_token_round_trip() -> None:
    subject = str(uuid7())
    token = create_access_token(subject)

    assert decode_access_token(token) == subject


def test_decode_access_token_rejects_invalid_token() -> None:
    assert decode_access_token("not-a-token") is None


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
