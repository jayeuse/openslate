"""Behavior coverage for user administration after local Identity cutover."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.account_operations as account_operations
import app.systems.access.users.service as user_service
from app.core.integrations.supabase_auth import ProviderUser
from app.systems.access.policy.models import GroupMember
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.access.users.schemas import InvitationCreate, UserCreate, UserResponse, UserUpdate
from tests.users.user_support import local_user

pytestmark = pytest.mark.usefixtures("local_identity_security_events")


def test_profile_create_defaults_to_a_member_without_groups() -> None:
    payload = UserCreate(email="member@example.com", username="member")

    assert payload.role is UserRole.MEMBER
    assert payload.group_ids == []
    assert payload.display_name is None
    assert payload.job_title is None
    assert payload.sponsor_user_id is None
    assert payload.expires_at is None


def test_user_response_exposes_the_role_and_no_department_membership() -> None:
    user, membership = local_user(UserRole.GUEST)
    user.display_name = "Guest"
    invitation_sent_at = datetime.now(UTC)
    membership.invitation_sent_at = invitation_sent_at

    response = UserResponse(**{key: getattr(
        user if key in User.__table__.columns else membership, key
    ) for key in UserResponse.model_fields})

    assert response.role is UserRole.GUEST
    assert response.display_name == "Guest"
    assert response.invitation_sent_at == invitation_sent_at
    assert "department_ids" not in response.model_dump()
    assert "role_id" not in response.model_dump()


def test_guest_invitation_rejects_missing_sponsor_before_creating_credentials() -> None:
    payload = InvitationCreate(
        email="guest@example.com",
        username="guest",
        role=UserRole.GUEST,
        expires_at=datetime.now(UTC) + timedelta(days=5),
    )
    db = Mock(spec=Session)

    with pytest.raises(InvitationError, match="sponsor"):
        user_service.invite_user(db, payload, bootstrap=True)

    db.add.assert_not_called()
    db.commit.assert_not_called()


def test_guest_cannot_receive_administrator_role_during_profile_update() -> None:
    actor, actor_membership = local_user(UserRole.ADMIN)
    guest, membership = local_user(UserRole.GUEST)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, guest]
    # A promotion first reads the groups to lock; a guest is in none here.
    db.dirty = set()
    db.scalars.return_value.all.side_effect = [[actor_membership], [], [membership]]

    with pytest.raises(HTTPException) as error:
        account_operations.update_user(guest.id, UserUpdate(role=UserRole.ADMIN), actor, db)

    assert error.value.status_code == 409
    assert membership.role == UserRole.GUEST.value
    db.commit.assert_not_called()


@pytest.mark.parametrize(
    "sponsor",
    [
        lambda: local_user(status=UserStatus.DISABLED),
        lambda: local_user(UserRole.GUEST),
    ],
    ids=["inactive", "guest"],
)
def test_guest_invitation_rejects_ineligible_sponsor(
    sponsor,  # type: ignore[no-untyped-def]
) -> None:
    payload = InvitationCreate(
        email="guest@example.com",
        username="guest",
        role=UserRole.GUEST,
        sponsor_user_id=uuid7(),
        expires_at=datetime.now(UTC) + timedelta(days=365),
    )
    db = Mock(spec=Session)
    user, membership = sponsor()
    db.scalar.side_effect = [user]
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]

    with pytest.raises(InvitationError, match="sponsor"):
        user_service.invite_user(db, payload, bootstrap=True)

    db.add.assert_not_called()
    db.commit.assert_not_called()


def test_administrator_invitation_rejects_groups_before_persisting() -> None:
    payload = InvitationCreate(
        email="admin@example.com",
        username="admin",
        role=UserRole.ADMIN,
        group_ids=[uuid7()],
    )
    db = Mock(spec=Session)

    with pytest.raises(InvitationError, match="not group members"):
        user_service.invite_user(db, payload, bootstrap=True)

    db.add.assert_not_called()
    db.commit.assert_not_called()


def _provider_for(payload: InvitationCreate) -> tuple[Mock, object]:
    provider = Mock()
    provider_id = uuid7()
    provider.admin_create_invitation_user.side_effect = lambda email, local_id, operation_id: (
        ProviderUser(
            provider_id,
            None,
            email,
            {
                "openslate_user_id": str(local_id),
                "openslate_invitation_operation_id": str(operation_id),
            },
        )
    )
    provider.admin_send_invitation.return_value = ProviderUser(provider_id, None, payload.email)
    return provider, provider_id


def _capture_profile(db: Mock, monkeypatch: pytest.MonkeyPatch) -> None:
    def created_profile() -> User:
        return next(
            call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], User)
        )

    db.flush.side_effect = lambda: setattr(created_profile(), "id", uuid7())
    monkeypatch.setattr(user_service, "get_user", lambda *_args: created_profile())
    monkeypatch.setattr(user_service, "append_security_event", Mock())


def test_guest_invitation_gets_the_configured_guest_duration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sponsor, sponsor_membership = local_user()
    payload = InvitationCreate(
        email="guest@example.com",
        username="guest",
        role=UserRole.GUEST,
        sponsor_user_id=sponsor.id,
    )
    db = Mock(spec=Session)
    db.scalar.side_effect = [45, sponsor, None]
    db.dirty = set()
    db.scalars.return_value.all.return_value = [sponsor_membership]
    _capture_profile(db, monkeypatch)
    provider, _ = _provider_for(payload)
    before = datetime.now(UTC)

    user_service.invite_user(db, payload, bootstrap=True, client=provider)

    membership = next(call.args[0] for call in db.add.call_args_list
                      if isinstance(call.args[0], Membership))
    assert membership.role == UserRole.GUEST.value
    assert membership.sponsor_user_id == sponsor.id
    assert membership.expires_at is not None
    assert (before + timedelta(days=45) <= membership.expires_at
            <= datetime.now(UTC) + timedelta(days=45))


def test_guest_invitation_persists_profile_and_deduplicated_group_memberships(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sponsor, sponsor_membership = local_user()
    group_a = uuid7()
    group_b = uuid7()
    payload = InvitationCreate(
        email="guest@example.com",
        username="guest",
        display_name="Guest person",
        role=UserRole.GUEST,
        job_title="Observer",
        sponsor_user_id=sponsor.id,
        expires_at=datetime.now(UTC) + timedelta(days=365),
        group_ids=[group_b, group_a, group_b],
    )
    db = Mock(spec=Session)
    db.scalar.side_effect = [sponsor, None]
    db.dirty = set()
    db.scalars.return_value.all.side_effect = [[sponsor_membership], [group_a, group_b]]
    _capture_profile(db, monkeypatch)
    provider, provider_id = _provider_for(payload)

    user = user_service.invite_user(db, payload, bootstrap=True, client=provider)

    assert user.display_name == "Guest person"
    membership = next(call.args[0] for call in db.add.call_args_list
                      if isinstance(call.args[0], Membership))
    assert membership.role == UserRole.GUEST.value
    assert user.job_title == "Observer"
    assert membership.sponsor_user_id == sponsor.id
    memberships = [
        call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], GroupMember)
    ]
    assert [item.group_id for item in memberships] == [group_b, group_a]
    assert user.supabase_user_id == provider_id
    assert user.status == UserStatus.PENDING.value


def test_expired_member_cannot_sponsor_a_guest(monkeypatch: pytest.MonkeyPatch) -> None:
    now = datetime(2026, 9, 22, tzinfo=UTC)
    sponsor, membership = local_user()
    membership.expires_at = now
    db = Mock(spec=Session)
    db.scalar.side_effect = [sponsor]
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]
    monkeypatch.setattr(user_service, "utc_now", lambda: now)
    monkeypatch.setattr("app.systems.access.users.coordination.utc_now", lambda: now)
    payload = InvitationCreate(
        email="guest@example.com",
        username="guest",
        role=UserRole.GUEST,
        sponsor_user_id=sponsor.id,
        expires_at=now + timedelta(days=1),
    )

    with pytest.raises(InvitationError, match="sponsor"):
        user_service.invite_user(db, payload, bootstrap=True)
