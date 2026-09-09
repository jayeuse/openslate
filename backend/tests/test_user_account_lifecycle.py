from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.users.account_operations as users_router
from app.core.integrations.supabase import SupabaseAdminClient, SupabaseAdminError
from app.systems.users.models import UserRole, UserStatus
from app.systems.users.schemas import UserUpdate
from tests.user_invitations_support import profile, role


@pytest.fixture(autouse=True)
def committed_security_events(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(users_router, "_record_security_event", lambda *_args, **_kwargs: None)


def test_activation_commits_local_status_only_after_auth_enable_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.DISABLED.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    db = Mock(spec=Session)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [admin.role, admin, user, admin.role, admin, user]

    result = users_router.update_user(user.id, UserUpdate(status=UserStatus.ACTIVE), admin, db)

    assert result is user
    assert user.status == UserStatus.ACTIVE.value
    client.enable_user.assert_called_once_with(user.id)
    db.commit.assert_called_once()


def test_admin_activation_does_not_activate_a_pending_invitation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.PENDING.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    db = Mock(spec=Session)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [admin.role, admin, user]

    with pytest.raises(users_router.HTTPException) as error:
        users_router.update_user(
            user.id,
            UserUpdate(status=UserStatus.ACTIVE),
            admin,
            db,
        )

    assert error.value.status_code == 409
    assert user.status == UserStatus.PENDING.value
    client.enable_user.assert_not_called()
    db.commit.assert_not_called()


def test_activation_fails_closed_when_auth_enable_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.DISABLED.value)
    client = Mock(spec=SupabaseAdminClient)
    client.enable_user.side_effect = SupabaseAdminError("upstream")
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    db = Mock(spec=Session)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [admin.role, admin, user]

    with pytest.raises(users_router.HTTPException) as error:
        users_router.update_user(user.id, UserUpdate(status=UserStatus.ACTIVE), admin, db)

    assert error.value.status_code == 503
    assert user.status == UserStatus.DISABLED.value
    db.commit.assert_not_called()


def test_activation_finalization_drift_does_not_disable_auth_after_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.DISABLED.value)
    drifted = profile(user.id, assigned_role, status=UserStatus.DISABLED.value)
    drifted.username = "changed_while_blocked"
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    database = Mock(spec=Session)
    database.scalar.side_effect = [admin.role, admin, user, admin.role, admin, drifted]

    with pytest.raises(users_router.HTTPException) as error:
        users_router.update_user(user.id, UserUpdate(status=UserStatus.ACTIVE), admin, database)

    assert error.value.status_code == 409
    client.enable_user.assert_called_once_with(user.id)
    client.disable_user.assert_not_called()


def test_restore_finalization_drift_does_not_disable_auth_after_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.DISABLED.value)
    user.is_deleted = True
    user.deleted_at = datetime.now(UTC)
    drifted = profile(user.id, assigned_role, status=UserStatus.ACTIVE.value)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin.role,
        admin,
        user,
        assigned_role,
        admin.role,
        admin,
        drifted,
    ]

    with pytest.raises(users_router.HTTPException) as error:
        users_router.restore_user(user.id, admin, database)

    assert error.value.status_code == 409
    client.enable_user.assert_called_once_with(user.id)
    client.disable_user.assert_not_called()


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_local_first_disable_provider_failure_records_partial_without_compensation(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    client.disable_user.side_effect = SupabaseAdminError("upstream")
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    db = Mock(spec=Session)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [admin.role, admin, user]
    event_writer = Mock()
    monkeypatch.setattr(users_router, "_record_security_event", event_writer)

    with pytest.raises(users_router.HTTPException) as error:
        if operation == "disable":
            users_router.update_user(user.id, UserUpdate(status=UserStatus.DISABLED), admin, db)
        else:
            users_router.delete_user(user.id, admin, db)

    assert error.value.status_code == 503
    assert user.status == UserStatus.DISABLED.value
    assert user.tokens_valid_after is not None
    db.commit.assert_called_once()
    client.disable_user.assert_called_once_with(user.id)
    client.enable_user.assert_not_called()
    outcomes = [call.kwargs["outcome"].value for call in event_writer.call_args_list]
    operation_ids = {call.kwargs["operation_id"] for call in event_writer.call_args_list}
    assert outcomes == ["attempt", "partial"]
    assert len(operation_ids) == 1


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_local_first_disable_commit_failure_remains_failure_without_auth_call(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.ACTIVE.value)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    database = Mock(spec=Session)
    database.scalar.side_effect = [admin.role, admin, user]
    database.commit.side_effect = SQLAlchemyError("local failure")
    event_writer = Mock()
    monkeypatch.setattr(users_router, "_record_security_event", event_writer)

    with pytest.raises(users_router.HTTPException) as error:
        if operation == "disable":
            users_router.update_user(
                user.id,
                UserUpdate(status=UserStatus.DISABLED),
                admin,
                database,
            )
        else:
            users_router.delete_user(user.id, admin, database)

    assert error.value.status_code == 503
    client.disable_user.assert_not_called()
    client.enable_user.assert_not_called()
    outcomes = [call.kwargs["outcome"].value for call in event_writer.call_args_list]
    operation_ids = {call.kwargs["operation_id"] for call in event_writer.call_args_list}
    assert outcomes == ["attempt", "failure"]
    assert len(operation_ids) == 1


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_disable_and_delete_advance_token_cutoff_before_remote_auth_call(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.ACTIVE.value)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    database = Mock(spec=Session)
    database.scalar.side_effect = [admin.role, admin, user]
    calls: list[str] = []

    def commit() -> None:
        calls.append("commit")

    def disable_user(user_id) -> None:
        calls.append("disable_auth")
        assert user_id == user.id

    database.commit.side_effect = commit
    client.disable_user.side_effect = disable_user

    if operation == "disable":
        result = users_router.update_user(
            user.id,
            UserUpdate(status=UserStatus.DISABLED),
            admin,
            database,
        )
    else:
        result = users_router.delete_user(user.id, admin, database)

    assert result is not None
    assert user.tokens_valid_after is not None
    assert calls == ["commit", "disable_auth"]


def test_restore_releases_the_database_transaction_before_auth_enable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.DISABLED.value)
    user.is_deleted = True
    user.deleted_at = datetime.now(UTC)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin.role,
        admin,
        user,
        assigned_role,
        admin.role,
        admin,
        user,
        assigned_role,
    ]
    database.in_transaction.return_value = True

    def commit() -> None:
        database.in_transaction.return_value = False

    database.rollback.side_effect = commit

    def enable_user(user_id) -> None:
        assert user_id == user.id
        assert database.in_transaction() is False

    database.commit.side_effect = commit
    client.enable_user.side_effect = enable_user

    result = users_router.restore_user(user.id, admin, database)

    assert result is user
    assert user.is_deleted is False
    assert user.status == UserStatus.ACTIVE.value
