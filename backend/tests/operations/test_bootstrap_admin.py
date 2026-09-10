from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest
from uuid6 import uuid7

from app.core.config import Settings
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import Role, UserRole
from scripts import bootstrap_admin as bootstrap


@pytest.mark.parametrize("existing_profile,admin_count", [(False, 0), (True, 0), (False, 1)])
def test_bootstrap_invites_once_and_never_promotes_existing_profiles(
    monkeypatch, existing_profile, admin_count
) -> None:
    member = Role(id=uuid7(), role=UserRole.MEMBER, permissions={})
    admin = Role(id=uuid7(), role=UserRole.ADMIN, permissions={})
    invitation = InvitationCreate(email="admin@example.test", username="first-admin")
    profile = SimpleNamespace(
        id=uuid7(),
        role_id=member.id,
        status="pending",
        email=invitation.email,
        username=invitation.username,
        is_deleted=False,
    )
    database = MagicMock()
    database.__enter__.return_value = database
    existing = profile if existing_profile else None
    database.scalar.side_effect = [None, member, admin, existing, existing, admin_count]
    monkeypatch.setattr(bootstrap, "AuditSession", lambda _: database)
    monkeypatch.setattr(bootstrap, "get_engine", lambda: object())
    auth = Mock()
    monkeypatch.setattr(bootstrap, "SupabaseAdminClient", lambda _: auth)
    invite = Mock(return_value=profile)
    monkeypatch.setattr(bootstrap, "invite_user", invite)
    if existing_profile or admin_count:
        with pytest.raises(bootstrap.BootstrapError):
            bootstrap._provision(Mock(spec=Settings), invitation)
        invite.assert_not_called()
    else:
        assert bootstrap._provision(Mock(spec=Settings), invitation) is profile
        assert invite.call_args.kwargs["bootstrap"] is True
        assert invite.call_args.args[1].role_id == admin.id
    assert profile.role_id == member.id
    assert profile.status == "pending"
    auth.delete_user.assert_not_called()
    database.commit.assert_not_called()


def test_bootstrap_requires_explicit_confirmation_outside_local_environments() -> None:
    settings = SimpleNamespace(environment="production")

    with pytest.raises(bootstrap.BootstrapError, match="--confirm"):
        bootstrap._validate_confirmation(settings, False)

    bootstrap._validate_confirmation(settings, True)
