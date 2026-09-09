from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.users.account_operations as users_router
import app.systems.users.reconciliation as reconciliation
from app.core.integrations.supabase import SupabaseAdminClient, SupabaseAdminError
from app.systems.audit.service import SecurityEventPersistenceError
from app.systems.users.account_operations import (
    delete_user,
    restore_user,
    update_user,
)
from app.systems.users.coordination import lock_active_role as _active_role
from app.systems.users.models import Role, User, UserRole, UserStatus
from app.systems.users.roles_router import delete_role, update_role
from app.systems.users.schemas import RoleUpdate, UserUpdate


def make_role(name: str, *, deleted: bool = False) -> Role:
    role = Role(role=name, permissions={}, is_deleted=deleted)
    role.id = uuid7()
    return role


def make_user(
    username: str,
    role: Role,
    *,
    status: str = UserStatus.ACTIVE.value,
    deleted: bool = False,
) -> User:
    user = User(
        id=uuid7(),
        email=f"{username}@example.com",
        username=username,
        status=status,
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
    admin = make_user("admin", role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [role, admin, role]

    with pytest.raises(HTTPException) as error:
        update_role(role.id, RoleUpdate(role="superadmin"), admin, db)

    assert error.value.status_code == 403
    db.commit.assert_not_called()


def test_role_mutation_reloads_and_denies_a_stale_non_admin_actor() -> None:
    admin_role = make_role(UserRole.ADMIN)
    stale_actor = make_user("stale", make_role("operator"))
    target = make_role("editor")
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, stale_actor]
    db.get.return_value = target

    with pytest.raises(HTTPException) as error:
        update_role(target.id, RoleUpdate(permissions={"records.read": True}), stale_actor, db)

    assert error.value.status_code == 403
    db.commit.assert_not_called()


def test_role_mutation_fails_closed_without_a_real_admin_role_result() -> None:
    db = Mock(spec=Session)
    db.scalar.return_value = Mock()

    with pytest.raises(HTTPException) as error:
        update_role(uuid7(), RoleUpdate(permissions={"records.read": True}), Mock(), db)

    assert error.value.status_code == 503
    db.commit.assert_not_called()


def test_built_in_role_permissions_can_be_updated() -> None:
    role = make_role(UserRole.ADMIN)
    admin = make_user("admin", role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [role, admin, role]

    updated = update_role(role.id, RoleUpdate(permissions={"records.read": True}), admin, db)

    assert updated is role
    assert role.permissions == {"records.read": True}
    db.commit.assert_called_once()


def test_role_with_active_users_cannot_be_deleted() -> None:
    role = make_role("editor")
    admin = make_user("admin", make_role(UserRole.ADMIN))
    db = Mock(spec=Session)
    db.scalar.side_effect = [
        admin.role,
        admin,
        role,
        1,
    ]

    with pytest.raises(HTTPException) as error:
        delete_role(role.id, admin, db)

    assert error.value.status_code == 409
    assert role.is_deleted is False


@pytest.mark.parametrize("status", [
    UserStatus.PENDING.value,
    UserStatus.ACTIVE.value,
    UserStatus.DISABLED.value,
])
def test_role_with_any_non_deleted_assignee_cannot_be_archived(status: str) -> None:
    role = make_role("editor")
    assignee = make_user(f"{status}-assignee", role, status=status)
    role.users = [assignee]
    admin = make_user("admin", make_role(UserRole.ADMIN))
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin.role, admin, role, 1]

    with pytest.raises(HTTPException) as error:
        delete_role(role.id, admin, db)

    assert error.value.status_code == 409
    assert role.is_deleted is False
    db.commit.assert_not_called()


def test_user_cannot_delete_self() -> None:
    role = make_role(UserRole.ADMIN)
    user = make_user("admin", role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [role, user, user]

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
    db.scalar.side_effect = [role, admin, target, 1]

    with pytest.raises(HTTPException) as error:
        delete_user(target.id, admin, db)

    assert error.value.status_code == 409
    assert target.is_deleted is False


def test_user_patch_rejects_a_projected_state_without_an_active_admin() -> None:
    admin_role = make_role(UserRole.ADMIN)
    member_role = make_role(UserRole.MEMBER)
    admin = make_user("current-admin", admin_role)
    target = make_user("other-admin", admin_role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, target, member_role, 1]

    with pytest.raises(HTTPException) as error:
        update_user(
            target.id,
            UserUpdate(role_id=member_role.id, status=UserStatus.DISABLED),
            admin,
            db,
        )

    assert error.value.status_code == 409
    assert target.role_id == admin_role.id
    assert target.status == UserStatus.ACTIVE.value
    db.commit.assert_not_called()


def test_deleted_user_can_be_restored_only_with_an_active_role(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    role = make_role("editor")
    user = make_user("deleted-user", role, deleted=True)
    user.deleted_at = datetime.now(UTC)
    db = Mock(spec=Session)
    admin_role = make_role(UserRole.ADMIN)
    admin = make_user("admin", admin_role)
    db.scalar.side_effect = [admin_role, admin, user, role, admin_role, admin, user, role]
    monkeypatch.setattr(users_router, "_enable_auth_user", lambda _: None)
    monkeypatch.setattr(users_router, "_record_security_event", lambda *_args, **_kwargs: None)

    restored = restore_user(user.id, admin, db)

    assert restored is user
    assert user.is_deleted is False
    assert user.deleted_at is None
    db.commit.assert_called_once()


def test_user_router_maps_user_lock_database_failure_to_503() -> None:
    admin_role = make_role(UserRole.ADMIN)
    admin = make_user("admin", admin_role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, SQLAlchemyError("database unavailable")]

    with pytest.raises(HTTPException) as error:
        update_user(uuid7(), UserUpdate(username="renamed"), admin, db)

    assert error.value.status_code == 503
    assert error.value.detail == "Unable to lock user"
    db.rollback.assert_called_once()


def test_user_router_fails_before_auth_when_security_event_cannot_be_persisted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_role = make_role(UserRole.ADMIN)
    admin = make_user("admin", admin_role)
    target = make_user("target", make_role("editor"), status=UserStatus.DISABLED.value)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, target]
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    monkeypatch.setattr(
        users_router,
        "append_committed_security_event",
        Mock(side_effect=SecurityEventPersistenceError("event unavailable")),
    )

    with pytest.raises(HTTPException) as error:
        update_user(target.id, UserUpdate(status=UserStatus.ACTIVE), admin, db)

    assert error.value.status_code == 503
    assert error.value.detail == "Unable to record security event"
    client.enable_user.assert_not_called()
    db.commit.assert_not_called()


def test_activation_records_partial_when_local_finalization_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_role = make_role(UserRole.ADMIN)
    admin = make_user("admin", admin_role)
    target = make_user("target", make_role("editor"), status=UserStatus.DISABLED.value)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, target, admin_role, admin, target]
    db.commit.side_effect = SQLAlchemyError("database unavailable")
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    events = Mock()
    monkeypatch.setattr(users_router, "_record_security_event", events)

    with pytest.raises(HTTPException) as error:
        update_user(target.id, UserUpdate(status=UserStatus.ACTIVE), admin, db)

    assert error.value.status_code == 503
    client.enable_user.assert_called_once_with(target.id)
    client.disable_user.assert_not_called()
    outcomes = {
        getattr(call.kwargs["outcome"], "value", call.kwargs["outcome"])
        for call in events.call_args_list
    }
    operation_ids = {call.kwargs["operation_id"] for call in events.call_args_list}
    assert {"attempt", "partial"} <= outcomes
    assert len(operation_ids) == 1


def test_reconcile_auth_records_provider_failure_without_opposite_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_role = make_role(UserRole.ADMIN)
    admin = make_user("admin", admin_role)
    target = make_user("target", make_role("editor"), status=UserStatus.DISABLED.value)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, target]
    client = Mock(spec=SupabaseAdminClient)
    client.disable_user.side_effect = SupabaseAdminError("provider unavailable")
    monkeypatch.setattr(reconciliation, "SupabaseAdminClient", lambda: client)
    events = Mock()
    monkeypatch.setattr(users_router, "_record_security_event", events)

    with pytest.raises(HTTPException) as error:
        reconciliation.reconcile_auth(target.id, admin, db)

    assert error.value.status_code == 503
    client.disable_user.assert_called_once_with(target.id)
    client.enable_user.assert_not_called()
    outcomes = {
        getattr(call.kwargs["outcome"], "value", call.kwargs["outcome"])
        for call in events.call_args_list
    }
    operation_ids = {call.kwargs["operation_id"] for call in events.call_args_list}
    assert {"attempt", "failure"} <= outcomes
    assert len(operation_ids) == 1
