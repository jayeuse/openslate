from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.users.service as users_service
from app.core.integrations.supabase import (
    SupabaseAuthUser,
)
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import UserRole, UserStatus
from app.systems.users.service import (
    InvitationError,
)
from app.systems.users.service import invite_user as invite_user_service
from tests.user_invitations_support import auth_client, invitation, profile, role


@pytest.fixture(autouse=True)
def committed_security_events(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(users_service, "append_committed_security_event", lambda _payload: None)


def test_application_invitation_requires_an_explicit_actor() -> None:
    with pytest.raises(InvitationError, match="actor is required"):
        invite_user_service(Mock(spec=Session), invitation(), client=auth_client())


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


def test_invitation_requires_an_active_default_member_role() -> None:
    client = auth_client()
    db = Mock(spec=Session)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [admin.role, admin, None]

    with pytest.raises(InvitationError, match="Default member role"):
        invite_user_service(db, invitation(), client=client, actor_id=admin.id)

    client.invite_user.assert_not_called()
