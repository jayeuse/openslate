from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.users.router as users_router
from app.systems.users.models import Role, User, UserRole
from app.systems.users.router import (
    _active_role,
    delete_role,
    delete_user,
    restore_user,
    update_role,
)
from app.systems.users.schemas import RoleUpdate


def make_role(name: str, *, deleted: bool = False) -> Role:
    role = Role(role=name, permissions={}, is_deleted=deleted)
    role.id = uuid7()
    return role


def make_user(username: str, role: Role, *, deleted: bool = False) -> User:
    user = User(
        id=uuid7(),
        email=f"{username}@example.com",
        username=username,
        status="active",
        role_id=role.id,
        role=role,
        is_deleted=deleted,
    )
    return user


def test_active_role_rejects_deleted_role() -> None:
    db = Mock(spec=Session)
    db.scalar.return_value = None

    with pytest.raises(HTTPException) as error:
        _active_role(db, uuid7())

    assert error.value.status_code == 409


def test_built_in_role_cannot_be_renamed() -> None:
    role = make_role(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.get.return_value = role

    with pytest.raises(HTTPException) as error:
        update_role(role.id, RoleUpdate(role="superadmin"), role, db)

    assert error.value.status_code == 403
    db.commit.assert_not_called()


def test_built_in_role_permissions_can_be_updated() -> None:
    role = make_role(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.get.return_value = role

    updated = update_role(role.id, RoleUpdate(permissions={"records.read": True}), role, db)

    assert updated is role
    assert role.permissions == {"records.read": True}
    db.commit.assert_called_once()


def test_role_with_active_users_cannot_be_deleted() -> None:
    role = make_role("editor")
    db = Mock(spec=Session)
    db.get.return_value = role
    db.scalar.return_value = 1

    with pytest.raises(HTTPException) as error:
        delete_role(role.id, role, db)

    assert error.value.status_code == 409
    assert role.is_deleted is False


def test_user_cannot_delete_self() -> None:
    role = make_role(UserRole.ADMIN)
    user = make_user("admin", role)
    db = Mock(spec=Session)
    db.scalar.return_value = user

    with pytest.raises(HTTPException) as error:
        delete_user(user.id, user, db)

    assert error.value.status_code == 403
    assert user.is_deleted is False
    db.commit.assert_not_called()


def test_last_active_admin_cannot_be_deleted() -> None:
    role = make_role(UserRole.ADMIN)
    admin = make_user("current-admin", role)
    target = make_user("other-admin", role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [target, 1]

    with pytest.raises(HTTPException) as error:
        delete_user(target.id, admin, db)

    assert error.value.status_code == 409
    assert target.is_deleted is False


def test_deleted_user_can_be_restored_only_with_an_active_role(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    role = make_role("editor")
    user = make_user("deleted-user", role, deleted=True)
    user.deleted_at = datetime.now(UTC)
    db = Mock(spec=Session)
    db.scalar.side_effect = [user, role, user]
    monkeypatch.setattr(users_router, "_enable_auth_user", lambda _: None)

    restored = restore_user(user.id, user, db)

    assert restored is user
    assert user.is_deleted is False
    assert user.deleted_at is None
    db.commit.assert_called_once()
