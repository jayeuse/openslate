"""Guest invitations read the sponsor and duration rules from PostgreSQL (S3-8)."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.service as user_service
from app.core.integrations.supabase_auth import ProviderUser
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.access.users.schemas import InvitationCreate
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.rbac.support import add_user

pytestmark = pytest.mark.integration


@pytest.fixture
def quiet_invitation_events(monkeypatch: pytest.MonkeyPatch) -> None:
    # Security events use their own session; they are outside this contract.
    monkeypatch.setattr(user_service, "require_fresh_exact_admin", lambda *_args: None)
    monkeypatch.setattr(user_service, "append_security_event", lambda *_args: None)
    monkeypatch.setattr(user_service, "_record_invitation_failure", lambda *_args: None)


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
    profile = db.scalar(select(WorkspaceProfile).where(WorkspaceProfile.singleton_key.is_(True)))
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

        guest = user_service.invite_user(
            db, _guest_payload(sponsor), actor_id=admin.id, client=_provider()
        )

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
