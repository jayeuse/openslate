from typing import cast
from unittest.mock import Mock

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.acceptance as invitation_acceptance
import app.systems.access.users.service as users_service
from app.core.base_model import utc_now
from app.core.integrations.supabase import (
    SupabaseAuthUser,
)
from app.systems.access.users.models import UserRole, UserStatus
from app.systems.access.users.schemas import InvitationCreate
from app.systems.access.users.service import (
    InvitationError,
)
from app.systems.access.users.service import invite_user as invite_user_service
from app.systems.manage.audit.models import SecurityEventOutcome
from tests.users.user_invitations_support import auth_client, invitation, profile, role


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
        # Bootstrap finalization must lock admin before member.
        admin_role,
        member_role,
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
        # Bootstrap finalization must lock admin before member.
        admin_role,
        member_role,
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


@pytest.fixture
def acceptance_events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []

    def record_event(**event: object) -> None:
        events.append(event)

    monkeypatch.setattr(invitation_acceptance, "_security_event", record_event)
    return events


def test_acceptance_rejects_a_verified_identity_for_another_profile(
    acceptance_events: list[dict[str, object]],
) -> None:
    database = Mock(spec=Session)
    user_id = uuid7()

    with pytest.raises(InvitationError, match="Verified identity"):
        invitation_acceptance.accept_verified_invitation(
            database,
            user_id,
            verified_email="invited@example.com",
            verified_identity=uuid7(),
        )

    database.rollback.assert_called_once()
    database.commit.assert_not_called()
    assert _event_outcomes(acceptance_events) == ["attempt", "failure"]
    assert acceptance_events[-1]["reason"] == "verified identity does not match profile"


def test_acceptance_rejects_a_malformed_verified_email_before_locks(
    acceptance_events: list[dict[str, object]],
) -> None:
    database = Mock(spec=Session)
    user_id = uuid7()

    with pytest.raises(InvitationError, match="Verified email"):
        invitation_acceptance.accept_verified_invitation(
            database,
            user_id,
            verified_email="not-an-email",
            verified_identity=user_id,
        )

    database.rollback.assert_called_once()
    database.scalar.assert_not_called()
    database.commit.assert_not_called()
    assert acceptance_events[-1]["reason"] == "verified email is invalid"


def test_acceptance_reports_a_profile_lock_failure_without_a_commit(
    acceptance_events: list[dict[str, object]],
) -> None:
    database = Mock(spec=Session)
    database.scalar.side_effect = [role(UserRole.ADMIN), SQLAlchemyError("database unavailable")]
    user_id = uuid7()

    with pytest.raises(InvitationError, match="Unable to lock invitation profile"):
        invitation_acceptance.accept_verified_invitation(
            database,
            user_id,
            verified_email="invited@example.com",
            verified_identity=user_id,
        )

    assert database.rollback.call_count == 2
    database.commit.assert_not_called()
    assert acceptance_events[-1]["reason"] == "unable to lock invitation profile"


def test_acceptance_rejects_a_missing_or_mismatched_invitation_profile(
    acceptance_events: list[dict[str, object]],
) -> None:
    database = Mock(spec=Session)
    database.scalar.side_effect = [role(UserRole.ADMIN), None]
    user_id = uuid7()

    with pytest.raises(InvitationError, match="Verified email"):
        invitation_acceptance.accept_verified_invitation(
            database,
            user_id,
            verified_email="invited@example.com",
            verified_identity=user_id,
        )

    database.rollback.assert_called_once()
    database.commit.assert_not_called()
    assert acceptance_events[-1]["reason"] == "verified email does not match invitation"


def test_acceptance_reports_a_role_lock_failure_without_a_commit(
    acceptance_events: list[dict[str, object]],
) -> None:
    assigned_role = role()
    user_id = uuid7()
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        role(UserRole.ADMIN),
        profile(user_id, assigned_role),
        SQLAlchemyError("database unavailable"),
    ]

    with pytest.raises(InvitationError, match="Unable to lock invitation role"):
        invitation_acceptance.accept_verified_invitation(
            database,
            user_id,
            verified_email="invited@example.com",
            verified_identity=user_id,
        )

    assert database.rollback.call_count == 2
    database.commit.assert_not_called()
    assert acceptance_events[-1]["reason"] == "unable to lock invitation role"


def test_acceptance_rejects_a_deleted_invitation_role(
    acceptance_events: list[dict[str, object]],
) -> None:
    user_id = uuid7()
    assigned_role = role()
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        role(UserRole.ADMIN),
        profile(user_id, assigned_role),
        role(deleted=True),
    ]

    with pytest.raises(InvitationError, match="Invitation role is not active"):
        invitation_acceptance.accept_verified_invitation(
            database,
            user_id,
            verified_email="invited@example.com",
            verified_identity=user_id,
        )

    database.rollback.assert_called_once()
    database.commit.assert_not_called()
    assert acceptance_events[-1]["reason"] == "invitation role is not active"


def test_acceptance_is_idempotent_for_an_already_accepted_invitation(
    acceptance_events: list[dict[str, object]],
) -> None:
    user_id = uuid7()
    assigned_role = role()
    accepted_profile = profile(user_id, assigned_role, status=UserStatus.ACTIVE.value)
    accepted_profile.invitation_accepted_at = utc_now()
    database = Mock(spec=Session)
    database.scalar.side_effect = [role(UserRole.ADMIN), accepted_profile, assigned_role]

    result = invitation_acceptance.accept_verified_invitation(
        database,
        user_id,
        verified_email="invited@example.com",
        verified_identity=user_id,
    )

    assert result is accepted_profile
    database.rollback.assert_called_once()
    database.commit.assert_not_called()
    assert _event_outcomes(acceptance_events) == ["attempt", "success"]


def test_acceptance_rejects_a_profile_without_a_pending_invitation(
    acceptance_events: list[dict[str, object]],
) -> None:
    user_id = uuid7()
    assigned_role = role()
    pending_profile = profile(user_id, assigned_role)
    database = Mock(spec=Session)
    database.scalar.side_effect = [role(UserRole.ADMIN), pending_profile, assigned_role]

    with pytest.raises(InvitationError, match="Invitation is not pending"):
        invitation_acceptance.accept_verified_invitation(
            database,
            user_id,
            verified_email="invited@example.com",
            verified_identity=user_id,
        )

    database.rollback.assert_called_once()
    database.commit.assert_not_called()
    assert acceptance_events[-1]["reason"] == "invitation is not pending"


def test_acceptance_rolls_back_when_final_commit_fails(
    acceptance_events: list[dict[str, object]],
) -> None:
    user_id = uuid7()
    assigned_role = role()
    pending_profile = profile(user_id, assigned_role)
    pending_profile.invitation_sent_at = utc_now()
    database = Mock(spec=Session)
    database.scalar.side_effect = [role(UserRole.ADMIN), pending_profile, assigned_role]
    database.commit.side_effect = SQLAlchemyError("commit failed")

    with pytest.raises(InvitationError, match="Unable to finalize invitation acceptance"):
        invitation_acceptance.accept_verified_invitation(
            database,
            user_id,
            verified_email="invited@example.com",
            verified_identity=user_id,
        )

    database.commit.assert_called_once()
    database.rollback.assert_called_once()
    assert acceptance_events[-1]["reason"] == "unable to finalize invitation acceptance"


def _event_outcomes(events: list[dict[str, object]]) -> list[str]:
    return [cast(SecurityEventOutcome, event["outcome"]).value for event in events]
