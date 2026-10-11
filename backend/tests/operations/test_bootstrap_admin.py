from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest
from uuid6 import uuid7

from app.core.config import Settings
from app.systems.access.users.models import UserRole
from app.systems.access.users.schemas import InvitationCreate
from operations import bootstrap_admin as bootstrap


@pytest.mark.parametrize("existing_profile,admin_count", [(False, 0), (True, 0), (False, 1)])
def test_bootstrap_invites_once_and_recovers_the_exact_pending_reservation(
    monkeypatch, existing_profile, admin_count
) -> None:
    member = UserRole.MEMBER.value
    admin = UserRole.ADMIN.value
    invitation = InvitationCreate(email="admin@example.test", username="first-admin")
    profile = SimpleNamespace(
        id=uuid7(),
        role=admin if existing_profile else member,
        status="pending",
        email=invitation.email,
        username=invitation.username,
        is_deleted=False,
        invitation_sent_at=None,
        provider_invitation_operation_id=uuid7(),
        invitation_accepted_at=None,
    )
    database = MagicMock()
    database.__enter__.return_value = database
    existing = profile if existing_profile else None
    database.scalar.side_effect = [None, existing, existing, admin_count]
    monkeypatch.setattr(bootstrap, "AuditSession", lambda _: database)
    monkeypatch.setattr(bootstrap, "get_engine", lambda: object())
    invite = Mock(return_value=profile)
    monkeypatch.setattr(bootstrap, "invite_user", invite)
    reconcile = Mock(return_value=profile)
    monkeypatch.setattr(bootstrap, "reconcile_invitation", reconcile, raising=False)
    if admin_count:
        with pytest.raises(bootstrap.BootstrapError):
            bootstrap._provision(Mock(spec=Settings), invitation)
        invite.assert_not_called()
        reconcile.assert_not_called()
    elif existing_profile:
        result = bootstrap._provision(Mock(spec=Settings), invitation)
        assert result == bootstrap.BootstrapResult(
            user_id=profile.id,
            email=profile.email,
            username=profile.username,
            status=profile.status,
        )
        reconcile.assert_called_once_with(database, profile.id, actor_id=None, bootstrap=True)
    else:
        result = bootstrap._provision(Mock(spec=Settings), invitation)
        assert result == bootstrap.BootstrapResult(
            user_id=profile.id,
            email=profile.email,
            username=profile.username,
            status=profile.status,
        )
        assert invite.call_args.kwargs["bootstrap"] is True
        assert invite.call_args.args[1].role == UserRole.ADMIN
    assert profile.role == (admin if existing_profile else member)
    assert profile.status == "pending"
    if not existing_profile:
        database.commit.assert_not_called()


def test_bootstrap_requires_explicit_confirmation_outside_local_environments() -> None:
    settings = SimpleNamespace(environment="production")

    with pytest.raises(bootstrap.BootstrapError, match="--confirm"):
        bootstrap._validate_confirmation(settings, False)

    bootstrap._validate_confirmation(settings, True)
