from unittest.mock import Mock

import pytest
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.auth.router as auth_router
import app.systems.users.account_operations as users_router
import app.systems.users.router as user_transport
import app.systems.users.service as users_service
from app.core.integrations.supabase import SupabaseAuthUser
from app.systems.users.models import UserRole, UserStatus
from app.systems.users.schemas import UserCreate
from app.systems.users.service import InvitationConflict, InvitationError
from app.systems.users.service import invite_user as invite_user_service
from tests.user_invitations_support import auth_client, invitation, invite_user, profile, role


@pytest.fixture(autouse=True)
def committed_security_events(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(users_service, "append_committed_security_event", lambda _payload: None)
    monkeypatch.setattr(users_router, "_record_security_event", lambda *_args, **_kwargs: None)

def test_invitation_releases_preflight_locks_before_auth_http() -> None:
    assigned_role = role()
    auth_id = uuid7()
    pending_profile = profile(auth_id, assigned_role)
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None, assigned_role, pending_profile]
    db.in_transaction.return_value = True

    def release_transaction() -> None:
        db.in_transaction.return_value = False

    db.rollback.side_effect = release_transaction

    def invite(_email: str, _username: str) -> SupabaseAuthUser:
        assert db.in_transaction() is False
        return SupabaseAuthUser(auth_id, "invited@example.com")

    client.invite_user.side_effect = invite

    result = invite_user(db, invitation(assigned_role.id), client=client)

    assert result is pending_profile


def test_invitation_does_not_overwrite_a_trigger_profile_that_drifted() -> None:
    assigned_role = role()
    auth_id = uuid7()
    drifted_profile = profile(auth_id, assigned_role)
    drifted_profile.email = "changed@example.com"
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [
        admin_role,
        admin,
        assigned_role,
        None,
        admin_role,
        admin,
        assigned_role,
        drifted_profile,
    ]

    with pytest.raises(InvitationError, match="profile changed"):
        invite_user_service(
            db,
            invitation(assigned_role.id),
            client=client,
            actor_id=admin.id,
        )

    assert drifted_profile.email == "changed@example.com"
    assert drifted_profile.username == f"auth_{auth_id.hex}"
    db.commit.assert_not_called()
    client.delete_user.assert_not_called()


def test_invitation_does_not_assign_a_role_that_drifted_during_auth_http() -> None:
    assigned_role = role()
    changed_role = role()
    changed_role.id = assigned_role.id
    changed_role.permissions = {"records.read": True}
    auth_id = uuid7()
    pending_profile = profile(auth_id, assigned_role)
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [
        admin_role,
        admin,
        assigned_role,
        None,
        admin_role,
        admin,
        changed_role,
        pending_profile,
    ]

    with pytest.raises(InvitationError, match="role changed"):
        invite_user_service(
            db,
            invitation(assigned_role.id),
            client=client,
            actor_id=admin.id,
        )

    assert pending_profile.role_id == assigned_role.id
    assert pending_profile.status == UserStatus.PENDING.value
    db.commit.assert_not_called()
    client.delete_user.assert_not_called()


def test_invitation_rejects_inactive_or_missing_role_without_external_call() -> None:
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.return_value = None

    with pytest.raises(InvitationError, match="Role is not active"):
        invite_user(db, invitation(uuid7()), client=client)

    client.invite_user.assert_not_called()


def test_invitation_requires_an_active_default_member_role() -> None:
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.return_value = None

    with pytest.raises(InvitationError, match="Default member role"):
        invite_user(db, invitation(), client=client)

    client.invite_user.assert_not_called()


@pytest.mark.parametrize(
    "commit_error",
    [IntegrityError("stmt", {}, Exception()), SQLAlchemyError()],
)
def test_invitation_rolls_back_without_destructive_compensation(commit_error: Exception) -> None:
    assigned_role = role()
    auth_id = uuid7()
    pending_profile = profile(auth_id, assigned_role)
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None, assigned_role, pending_profile]
    db.commit.side_effect = commit_error

    expected = InvitationConflict if isinstance(commit_error, IntegrityError) else InvitationError
    with pytest.raises(expected):
        invite_user(db, invitation(assigned_role.id), client=client)

    assert db.rollback.call_count >= 2
    client.delete_user.assert_not_called()


def test_failed_invitation_compensation_is_observable_and_correlated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    auth_id = uuid7()
    pending_profile = profile(auth_id, assigned_role)
    client = auth_client(auth_id)
    database = Mock(spec=Session)
    database.scalar.side_effect = [assigned_role, None, pending_profile]
    database.commit.side_effect = SQLAlchemyError("local finalization failed")
    event_writer = Mock()
    monkeypatch.setattr(users_service, "append_committed_security_event", event_writer)

    with pytest.raises(InvitationError):
        invite_user(database, invitation(assigned_role.id), client=client)

    events = [call.args[0] for call in event_writer.call_args_list]
    assert events
    operation_ids = {event.operation_id for event in events}
    outcomes = {getattr(event.outcome, "value", event.outcome) for event in events}
    assert len(operation_ids) == 1
    assert "attempt" in outcomes
    assert "partial" in outcomes
    client.delete_user.assert_not_called()


def test_router_create_user_returns_invited_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    assigned_role = role()
    invited = profile(uuid7(), assigned_role, status=UserStatus.ACTIVE.value)
    monkeypatch.setattr(user_transport, "invite_user", lambda *_args, **_kwargs: invited)

    result = user_transport.create_user(
        UserCreate(email="person@example.com", username="person", role_id=assigned_role.id),
        invited,
        Mock(spec=Session),
    )

    assert result is invited


@pytest.mark.parametrize(
    ("error", "status_code"),
    [
        (InvitationConflict("duplicate"), 409),
        (InvitationError("upstream"), 502),
    ],
)
def test_router_maps_invitation_errors_to_api_responses(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    status_code: int,
) -> None:
    monkeypatch.setattr(user_transport, "invite_user", Mock(side_effect=error))

    with pytest.raises(user_transport.HTTPException) as raised:
        user_transport.create_user(
            UserCreate(email="person@example.com", username="person"),
            Mock(),
            Mock(spec=Session),
        )

    assert raised.value.status_code == status_code


def test_resend_route_returns_the_refreshed_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = profile(uuid7(), role())
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    monkeypatch.setattr(auth_router, "resend_invitation", lambda *_args, **_kwargs: target)

    result = auth_router.resend(target.id, admin, Mock(spec=Session))

    assert result is target


@pytest.mark.parametrize(
    ("error", "status_code"),
    [(InvitationConflict("duplicate"), 409), (InvitationError("upstream"), 502)],
)
def test_resend_route_maps_invitation_errors(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    status_code: int,
) -> None:
    monkeypatch.setattr(auth_router, "resend_invitation", Mock(side_effect=error))
    target_id = uuid7()
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)

    with pytest.raises(auth_router.HTTPException) as raised:
        auth_router.resend(target_id, admin, Mock(spec=Session))

    assert raised.value.status_code == status_code


def test_acceptance_route_returns_the_finalized_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = profile(uuid7(), role())
    identity = auth_router.VerifiedPendingIdentity(subject=target.id, email=target.email)
    monkeypatch.setattr(
        auth_router,
        "accept_verified_invitation",
        lambda *_args, **_kwargs: target,
    )

    result = auth_router.accept_invitation(identity, Mock(spec=Session))

    assert result is target


@pytest.mark.parametrize(
    ("error", "status_code"),
    [(InvitationConflict("conflict"), 409), (InvitationError("invalid"), 409)],
)
def test_acceptance_route_maps_invitation_errors(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    status_code: int,
) -> None:
    monkeypatch.setattr(auth_router, "accept_verified_invitation", Mock(side_effect=error))
    identity = auth_router.VerifiedPendingIdentity(subject=uuid7(), email="person@example.com")

    with pytest.raises(auth_router.HTTPException) as raised:
        auth_router.accept_invitation(identity, Mock(spec=Session))

    assert raised.value.status_code == status_code

