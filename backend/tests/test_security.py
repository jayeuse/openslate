from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.common.dependencies.auth as auth_dependencies
from app.systems.users.models import Role, User, UserRole


def test_role_dependency_accepts_allowed_role() -> None:
    admin = User(
        id=uuid7(),
        email="admin@example.com",
        username="admin",
        status="active",
        role_id=uuid7(),
        role=Role(role=UserRole.ADMIN, permissions={}),
    )

    assert auth_dependencies.require_roles(UserRole.ADMIN)(admin) is admin


def test_role_dependency_rejects_other_role() -> None:
    member = User(
        id=uuid7(),
        email="member@example.com",
        username="member",
        status="active",
        role_id=uuid7(),
        role=Role(role=UserRole.MEMBER, permissions={}),
    )

    with pytest.raises(HTTPException) as error:
        auth_dependencies.require_roles(UserRole.ADMIN)(member)

    assert error.value.status_code == 403


def _use_verified_claims(monkeypatch: pytest.MonkeyPatch, claims: dict[str, Any]) -> None:
    verifier = getattr(auth_dependencies, "verify_supabase_jwt", None)
    assert callable(verifier), "get_current_user is not wired to Supabase JWT verification"
    monkeypatch.setattr(
        auth_dependencies,
        "verify_supabase_jwt",
        lambda _: claims,
        raising=False,
    )


def _profile(
    user_id: Any,
    *,
    status: str = "active",
    deleted: bool = False,
    tokens_valid_after: datetime | None = None,
) -> Any:
    return SimpleNamespace(
        id=user_id,
        username="member",
        status=status,
        is_deleted=deleted,
        tokens_valid_after=tokens_valid_after,
        role=SimpleNamespace(role=UserRole.MEMBER, is_deleted=False),
    )


def test_current_user_loads_same_id_active_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    user_id = uuid7()
    profile = _profile(user_id)
    db = Mock(spec=Session)
    db.scalar.return_value = profile
    _use_verified_claims(monkeypatch, {"sub": str(user_id)})

    current_user = auth_dependencies.get_current_user("supabase-token", db)

    assert current_user is profile


@pytest.mark.parametrize(
    ("status", "deleted"),
    [("pending", False), ("disabled", False), ("active", True)],
)
def test_current_user_rejects_inactive_or_deleted_profile(
    monkeypatch: pytest.MonkeyPatch,
    status: str,
    deleted: bool,
) -> None:
    user_id = uuid7()
    db = Mock(spec=Session)
    db.scalar.return_value = _profile(user_id, status=status, deleted=deleted)
    _use_verified_claims(monkeypatch, {"sub": str(user_id)})

    with pytest.raises(HTTPException) as error:
        auth_dependencies.get_current_user("supabase-token", db)

    assert error.value.status_code == 401


def test_current_user_rejects_missing_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    user_id = uuid7()
    db = Mock(spec=Session)
    db.scalar.return_value = None
    _use_verified_claims(monkeypatch, {"sub": str(user_id)})

    with pytest.raises(HTTPException) as error:
        auth_dependencies.get_current_user("supabase-token", db)

    assert error.value.status_code == 401


def test_current_user_rejects_profile_with_different_id(monkeypatch: pytest.MonkeyPatch) -> None:
    token_user_id = uuid7()
    db = Mock(spec=Session)
    db.scalar.return_value = _profile(uuid7())
    _use_verified_claims(monkeypatch, {"sub": str(token_user_id)})

    with pytest.raises(HTTPException) as error:
        auth_dependencies.get_current_user("supabase-token", db)

    assert error.value.status_code == 401


@pytest.mark.parametrize(
    ("issued_at", "accepted"),
    [
        (datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC).timestamp() - 1, False),
        (datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC).timestamp(), True),
    ],
)
def test_current_user_applies_the_local_token_cutoff(
    monkeypatch: pytest.MonkeyPatch,
    issued_at: float,
    accepted: bool,
) -> None:
    user_id = uuid7()
    cutoff = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
    db = Mock(spec=Session)
    db.scalar.return_value = _profile(user_id, tokens_valid_after=cutoff)
    _use_verified_claims(monkeypatch, {"sub": str(user_id), "iat": issued_at})

    if accepted:
        assert auth_dependencies.get_current_user("supabase-token", db).id == user_id
    else:
        with pytest.raises(HTTPException) as error:
            auth_dependencies.get_current_user("supabase-token", db)

        assert error.value.status_code == 401


def test_verified_pending_identity_uses_only_verified_jwt_subject_and_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = uuid7()
    _use_verified_claims(
        monkeypatch,
        {"sub": str(user_id), "email": " Pending@Example.COM "},
    )

    identity = auth_dependencies.get_verified_pending_identity("supabase-token")

    assert identity.subject == user_id
    assert identity.email == "pending@example.com"


@pytest.mark.parametrize(
    "claims",
    [{"sub": str(uuid7())}, {"sub": str(uuid7()), "email": "not-an-email"}],
)
def test_verified_pending_identity_rejects_missing_or_invalid_verified_email(
    monkeypatch: pytest.MonkeyPatch,
    claims: dict[str, Any],
) -> None:
    _use_verified_claims(monkeypatch, claims)

    with pytest.raises(HTTPException) as error:
        auth_dependencies.get_verified_pending_identity("supabase-token")

    assert error.value.status_code == 401
