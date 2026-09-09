from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.users.acceptance as acceptance
import app.systems.users.account_operations as users_router
import app.systems.users.service as users_service
from app.core.integrations.supabase import (
    SupabaseAdminClient,
    SupabaseAdminError,
    SupabaseAuthUser,
)
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import UserRole, UserStatus
from app.systems.users.service import (
    InvitationConflict,
    InvitationError,
)
from app.systems.users.service import invite_user as invite_user_service
from tests.user_invitations_support import auth_client, invitation, invite_user, profile, role


@pytest.fixture(autouse=True)
def committed_security_events(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(users_service, "append_committed_security_event", lambda _payload: None)
    monkeypatch.setattr(users_router, "_record_security_event", lambda *_args, **_kwargs: None)

def test_application_invitation_requires_an_explicit_actor() -> None:
    with pytest.raises(InvitationError, match="actor is required"):
        invite_user_service(Mock(spec=Session), invitation(), client=auth_client())


def test_invitation_finalizes_trigger_created_pending_profile_and_commits() -> None:
    assigned_role = role()
    auth_id = uuid7()
    pending_profile = profile(auth_id, assigned_role)
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None, assigned_role, pending_profile]

    result = invite_user(db, invitation(assigned_role.id), client=client)

    assert result is pending_profile
    assert pending_profile.email == "invited@example.com"
    assert pending_profile.username == "new_user"
    assert pending_profile.status == UserStatus.PENDING.value
    assert isinstance(pending_profile.invitation_sent_at, datetime)
    assert pending_profile.invitation_sent_at.tzinfo is not None
    assert pending_profile.invitation_accepted_at is None
    assert pending_profile.is_deleted is False
    assert pending_profile.deleted_at is None
    assert pending_profile.role is assigned_role
    client.invite_user.assert_called_once_with("invited@example.com", "new_user")
    client.delete_user.assert_not_called()
    db.commit.assert_called_once()
    db.refresh.assert_not_called()


def test_bootstrap_loser_keeps_trigger_profile_at_member_role_and_records_partial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member_role = role()
    admin_role = role(UserRole.ADMIN)
    auth_id = uuid7()
    pending_profile = profile(auth_id, member_role)
    pending_profile.email = "bootstrap-two@example.com"
    client = auth_client(auth_id)
    client.invite_user.return_value = SupabaseAuthUser(auth_id, pending_profile.email)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin_role,
        member_role,
        None,
        member_role,
        admin_role,
        1,
    ]
    event_writer = Mock()
    monkeypatch.setattr(users_service, "append_committed_security_event", event_writer)

    with pytest.raises(InvitationError, match="administrator reservation"):
        invite_user_service(
            database,
            InvitationCreate(
                email=pending_profile.email,
                username="bootstrap-two",
                role_id=admin_role.id,
            ),
            client=client,
            bootstrap=True,
        )

    assert pending_profile.role_id == member_role.id
    assert pending_profile.role is member_role
    assert pending_profile.status == UserStatus.PENDING.value
    assert pending_profile.invitation_sent_at is None
    assert database.commit.called is False
    client.delete_user.assert_not_called()
    client.disable_user.assert_not_called()
    events = [call.args[0] for call in event_writer.call_args_list]
    assert [event.outcome.value for event in events] == ["attempt", "partial"]
    assert len({event.operation_id for event in events}) == 1


def test_bootstrap_winner_assigns_the_admin_role_after_mutex_recheck() -> None:
    member_role = role()
    admin_role = role(UserRole.ADMIN)
    auth_id = uuid7()
    pending_profile = profile(auth_id, member_role)
    client = auth_client(auth_id)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin_role,
        member_role,
        None,
        member_role,
        admin_role,
        0,
        pending_profile,
    ]

    result = invite_user_service(
        database,
        InvitationCreate(
            email="invited@example.com",
            username="bootstrap-admin",
            role_id=admin_role.id,
        ),
        client=client,
        bootstrap=True,
    )

    assert result is pending_profile
    assert pending_profile.role_id == admin_role.id
    assert pending_profile.role is admin_role
    assert pending_profile.status == UserStatus.PENDING.value
    assert pending_profile.invitation_sent_at is not None
    database.commit.assert_called_once()


def test_invitation_leaves_auth_identity_when_trigger_profile_is_missing() -> None:
    assigned_role = role()
    auth_id = uuid7()
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None, assigned_role, None]

    with pytest.raises(InvitationError, match="finalize"):
        invite_user(db, invitation(assigned_role.id), client=client)

    assert db.rollback.call_count >= 2
    client.delete_user.assert_not_called()
    db.commit.assert_not_called()


def test_invitation_rejects_local_duplicate_before_calling_supabase() -> None:
    assigned_role = role()
    duplicate = profile(uuid7(), assigned_role)
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, duplicate]

    with pytest.raises(InvitationConflict, match="already in use"):
        invite_user(db, invitation(assigned_role.id), client=client)

    client.invite_user.assert_not_called()
    db.commit.assert_not_called()


def test_invitation_rejects_a_stranded_pending_auth_profile_without_deleting_auth() -> None:
    assigned_role = role()
    stale_profile = profile(uuid7(), assigned_role)
    stale_profile.email = "invited@example.com"
    stale_profile.username = f"auth_{stale_profile.id.hex}"
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, stale_profile]

    with pytest.raises(InvitationConflict, match="already in use"):
        invite_user(db, invitation(assigned_role.id), client=client)

    client.delete_user.assert_not_called()
    client.invite_user.assert_not_called()


def test_invitation_fails_safely_when_pending_profile_reconciliation_fails() -> None:
    assigned_role = role()
    stale_profile = profile(uuid7(), assigned_role)
    stale_profile.email = "invited@example.com"
    stale_profile.username = f"auth_{stale_profile.id.hex}"
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, stale_profile]

    with pytest.raises(InvitationConflict, match="already in use"):
        invite_user(db, invitation(assigned_role.id), client=client)

    client.invite_user.assert_not_called()


def test_pending_invitation_can_only_be_activated_by_verified_acceptance_and_is_idempotent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    accept = getattr(acceptance, "accept_verified_invitation", None)
    assert callable(accept), "accept_verified_invitation is not implemented"

    assigned_role = role()
    pending_profile = profile(uuid7(), assigned_role)
    pending_profile.invitation_sent_at = datetime.now(UTC)
    db = Mock(spec=Session)
    admin_role = role(UserRole.ADMIN)
    db.scalar.side_effect = [
        admin_role,
        pending_profile,
        assigned_role,
        admin_role,
        pending_profile,
        assigned_role,
    ]

    first = accept(
        db,
        pending_profile.id,
        verified_email=pending_profile.email,
        verified_identity=pending_profile.id,
    )
    accepted_at = first.invitation_accepted_at
    second = accept(
        db,
        pending_profile.id,
        verified_email=pending_profile.email,
        verified_identity=pending_profile.id,
    )

    assert first is pending_profile
    assert second is pending_profile
    assert pending_profile.status == UserStatus.ACTIVE.value
    assert accepted_at is not None
    assert pending_profile.invitation_accepted_at == accepted_at
    assert db.commit.call_count == 1


def test_resend_invitation_reuses_auth_identity_and_releases_preflight_locks() -> None:
    assigned_role = role()
    target = profile(uuid7(), assigned_role)
    target.invitation_sent_at = datetime.now(UTC)
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin_role,
        admin,
        target,
        assigned_role,
        admin_role,
        admin,
        target,
        assigned_role,
    ]
    database.in_transaction.return_value = True

    def release_transaction() -> None:
        database.in_transaction.return_value = False

    database.rollback.side_effect = release_transaction

    def resend(email: str) -> None:
        assert email == target.email
        assert database.in_transaction() is False

    client.resend_invitation.side_effect = resend

    result = users_service.resend_invitation(
        database,
        target.id,
        actor_id=admin.id,
        client=client,
    )

    assert result is target
    client.resend_invitation.assert_called_once_with(target.email)
    client.delete_user.assert_not_called()


def test_resend_invitation_rejects_profile_drift_without_overwriting_it() -> None:
    assigned_role = role()
    target = profile(uuid7(), assigned_role)
    target.invitation_sent_at = datetime.now(UTC)
    changed_target = profile(target.id, assigned_role)
    changed_target.invitation_sent_at = datetime.now(UTC)
    changed_target.invitation_accepted_at = datetime.now(UTC)
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin_role,
        admin,
        target,
        assigned_role,
        admin_role,
        admin,
        changed_target,
        assigned_role,
    ]

    client.resend_invitation.return_value = None

    with pytest.raises(InvitationError, match="changed"):
        users_service.resend_invitation(
            database,
            target.id,
            actor_id=admin.id,
            client=client,
        )

    assert changed_target.invitation_accepted_at is not None
    database.commit.assert_not_called()
    client.delete_user.assert_not_called()


def test_resend_invitation_rechecks_that_its_role_is_still_active() -> None:
    assigned_role = role()
    target = profile(uuid7(), assigned_role)
    target.invitation_sent_at = datetime.now(UTC)
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin_role,
        admin,
        target,
        assigned_role,
        admin_role,
        admin,
        target,
        None,
    ]
    client = Mock(spec=SupabaseAdminClient)

    with pytest.raises(InvitationError, match="active"):
        users_service.resend_invitation(
            database,
            target.id,
            actor_id=admin.id,
            client=client,
        )

    client.resend_invitation.assert_called_once_with(target.email)
    database.commit.assert_not_called()


def test_resend_invitation_records_correlated_provider_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    target = profile(uuid7(), assigned_role)
    target.invitation_sent_at = datetime.now(UTC)
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    client.resend_invitation.side_effect = SupabaseAdminError("upstream", status_code=503)
    database = Mock(spec=Session)
    database.scalar.side_effect = [admin_role, admin, target, assigned_role]
    event_writer = Mock()
    monkeypatch.setattr(users_service, "append_committed_security_event", event_writer)

    with pytest.raises(InvitationError, match="resend invitation"):
        users_service.resend_invitation(
            database,
            target.id,
            actor_id=admin.id,
            client=client,
        )

    events = [call.args[0] for call in event_writer.call_args_list]
    assert [event.outcome.value for event in events] == ["attempt", "failure"]
    assert len({event.operation_id for event in events}) == 1
    database.commit.assert_not_called()


@pytest.mark.parametrize("status_code", [409, 422])
def test_invitation_maps_supabase_duplicate_to_conflict(status_code: int) -> None:
    assigned_role = role()
    client = auth_client()
    client.invite_user.side_effect = SupabaseAdminError("upstream", status_code=status_code)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None]

    with pytest.raises(InvitationConflict, match="already in use"):
        invite_user(db, invitation(assigned_role.id), client=client)


def test_invitation_maps_other_supabase_error_to_safe_error() -> None:
    assigned_role = role()
    client = auth_client()
    client.invite_user.side_effect = SupabaseAdminError("upstream", status_code=503)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None]

    with pytest.raises(InvitationError, match="send invitation"):
        invite_user(db, invitation(assigned_role.id), client=client)


def test_invitation_records_durable_attempt_and_provider_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    client = auth_client()
    client.invite_user.side_effect = SupabaseAdminError("upstream", status_code=503)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None]
    event_writer = Mock()
    monkeypatch.setattr(users_service, "append_committed_security_event", event_writer)

    with pytest.raises(InvitationError):
        invite_user(db, invitation(assigned_role.id), client=client)

    events = [call.args[0] for call in event_writer.call_args_list]
    assert [event.outcome.value for event in events] == ["attempt", "failure"]
    assert len({event.operation_id for event in events}) == 1
