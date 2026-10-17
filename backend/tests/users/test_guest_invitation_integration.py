"""Guest invitations read the sponsor and duration rules from PostgreSQL (S3-8)."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.service as user_service
from app.core.integrations.supabase_auth import ProviderUser
from app.systems.access.policy.models import Group, GroupMember
from app.systems.access.users.coordination import InvitationError, ProfileValidationError
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.access.users.schemas import InvitationCreate
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.rbac.support import add_user, organization

pytestmark = pytest.mark.integration


@pytest.fixture
def quiet_invitation_events(monkeypatch: pytest.MonkeyPatch) -> None:
    # Security events use their own session; they are outside this contract.
    monkeypatch.setattr(user_service, "require_fresh_exact_admin", lambda *_args: None)
    monkeypatch.setattr(user_service, "append_security_event", lambda *_args: None)
    monkeypatch.setattr(user_service, "_record_invitation_failure", lambda *_args, **_kwargs: None)


def _provider() -> Mock:
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
    provider.admin_send_invitation.side_effect = lambda email: ProviderUser(
        provider_id, None, email
    )
    return provider


def _guest_payload(sponsor: User | None) -> InvitationCreate:
    label = uuid7().hex[-12:]
    return InvitationCreate(
        email=f"guest-{label}@example.com",
        username=f"guest-{label}",
        role=UserRole.GUEST,
        sponsor_user_id=sponsor.id if sponsor is not None else None,
    )


def _set_guest_duration(db: Session, days: int) -> None:
    profile = db.get(WorkspaceProfile, organization(db).id)
    assert isinstance(profile, WorkspaceProfile)
    profile.guest_duration_days = days
    db.flush()


@pytest.mark.usefixtures("quiet_invitation_events")
def test_guest_invitation_expiry_follows_the_workspace_guest_duration(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    admin = add_user(db, role=UserRole.ADMIN)
    sponsor = add_user(db, role=UserRole.MEMBER)

    for days in (12, 90):
        _set_guest_duration(db, days)
        before = datetime.now(UTC)

        invited = user_service.invite_user(
            db, _guest_payload(sponsor), actor_id=admin.id, client=_provider()
        )
        guest = db.scalars(select(Membership).where(
            Membership.user_id == invited.id,
            Membership.org_id == organization(db).id,
        )).one()

        assert guest.role == UserRole.GUEST.value
        assert guest.sponsor_user_id == sponsor.id
        assert guest.expires_at is not None
        assert (
            before + timedelta(days=days)
            <= guest.expires_at
            <= datetime.now(UTC) + timedelta(days=days)
        )


@pytest.mark.usefixtures("quiet_invitation_events")
def test_guest_invitation_without_a_sponsor_creates_no_profile(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    admin = add_user(db, role=UserRole.ADMIN)
    provider = _provider()
    payload = _guest_payload(None)

    with pytest.raises(InvitationError, match="sponsor"):
        user_service.invite_user(db, payload, actor_id=admin.id, client=provider)

    assert db.scalar(select(User.id).where(User.email == payload.email)) is None
    provider.admin_create_invitation_user.assert_not_called()


@pytest.mark.parametrize("sponsor_kind", ["guest", "disabled"])
@pytest.mark.usefixtures("quiet_invitation_events")
def test_guest_invitation_naming_an_unusable_sponsor_creates_no_profile(
    integration_owner_db: Session, sponsor_kind: str
) -> None:
    db = integration_owner_db
    admin = add_user(db, role=UserRole.ADMIN)
    # A guest cannot sponsor a guest, and a disabled member sponsors nobody.
    sponsor = (
        add_user(db, role=UserRole.GUEST)
        if sponsor_kind == "guest"
        else add_user(db, role=UserRole.MEMBER, status=UserStatus.DISABLED)
    )
    provider = _provider()
    payload = _guest_payload(sponsor)

    with pytest.raises(
        InvitationError, match="^Guest sponsor is not an active member or administrator$"
    ):
        user_service.invite_user(db, payload, actor_id=admin.id, client=provider)

    assert db.scalar(select(User.id).where(User.email == payload.email)) is None
    provider.admin_create_invitation_user.assert_not_called()


@pytest.mark.usefixtures("quiet_invitation_events")
def test_an_invitation_joins_only_active_groups(integration_owner_db: Session) -> None:
    db = integration_owner_db
    admin = add_user(db, role=UserRole.ADMIN)
    org_id = organization(db).id
    active = Group(org_id=org_id, name=f"Active {uuid7().hex}")
    # Another active group that nobody asks for.
    other = Group(org_id=org_id, name=f"Other {uuid7().hex}")
    deleted = Group(
        org_id=org_id, name=f"Deleted {uuid7().hex}",
        is_deleted=True, deleted_at=datetime.now(UTC),
    )
    db.add_all([active, other, deleted])
    db.flush()
    label = uuid7().hex[-12:]
    joined = InvitationCreate(
        email=f"member-{label}@example.com", username=f"member-{label}", group_ids=[active.id]
    )
    refused = InvitationCreate(
        email=f"other-{label}@example.com",
        username=f"other-{label}",
        group_ids=[active.id, deleted.id],
    )

    member = user_service.invite_user(db, joined, actor_id=admin.id, client=_provider())
    with pytest.raises(ProfileValidationError, match="^Group is not active$"):
        user_service.invite_user(db, refused, actor_id=admin.id, client=_provider())

    assert db.scalars(
        select(GroupMember.group_id).where(GroupMember.user_id == member.id)
    ).all() == [active.id]
    assert db.scalar(select(User.id).where(User.email == refused.email)) is None
