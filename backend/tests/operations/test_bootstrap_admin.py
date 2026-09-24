import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest
from uuid6 import uuid7

from app.core.config import Settings
from app.systems.access.users.models import Role, UserRole
from app.systems.access.users.schemas import InvitationCreate
from operations import bootstrap_admin as bootstrap


def test_standalone_bootstrap_loads_the_complete_model_registry() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from sqlalchemy.orm import configure_mappers; "
            "import operations.bootstrap_admin; configure_mappers()",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_standalone_recovery_loads_the_complete_model_registry() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from sqlalchemy.orm import configure_mappers; "
            "import operations.recover_local_admin; configure_mappers()",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("existing_profile,admin_count", [(False, 0), (True, 0), (False, 1)])
def test_bootstrap_invites_once_and_recovers_the_exact_pending_reservation(
    monkeypatch, existing_profile, admin_count
) -> None:
    member = Role(id=uuid7(), role=UserRole.MEMBER, permissions={})
    admin = Role(id=uuid7(), role=UserRole.ADMIN, permissions={})
    invitation = InvitationCreate(email="admin@example.test", username="first-admin")
    profile = SimpleNamespace(
        id=uuid7(),
        role_id=admin.id if existing_profile else member.id,
        status="pending",
        email=invitation.email,
        username=invitation.username,
        is_deleted=False,
        invitation_sent_at=object() if existing_profile else None,
        invitation_accepted_at=None,
    )
    database = MagicMock()
    database.__enter__.return_value = database
    existing = profile if existing_profile else None
    database.scalar.side_effect = [None, member, admin, existing, existing, admin_count]
    monkeypatch.setattr(bootstrap, "AuditSession", lambda _: database)
    monkeypatch.setattr(bootstrap, "get_engine", lambda: object())
    invite = Mock(return_value=profile)
    monkeypatch.setattr(bootstrap, "invite_user", invite)
    replace = Mock()
    monkeypatch.setattr(bootstrap, "replace_password", replace)
    if admin_count:
        with pytest.raises(bootstrap.BootstrapError):
            bootstrap._provision(Mock(spec=Settings), invitation, "temporary-password")
        invite.assert_not_called()
        replace.assert_not_called()
    elif existing_profile:
        result = bootstrap._provision(Mock(spec=Settings), invitation, "temporary-password")
        assert result == bootstrap.BootstrapResult(
            user_id=profile.id,
            email=profile.email,
            username=profile.username,
            status=profile.status,
        )
        replace.assert_called_once_with(database, profile, "temporary-password", temporary=True)
        database.commit.assert_called_once()
    else:
        result = bootstrap._provision(Mock(spec=Settings), invitation, "temporary-password")
        assert result == bootstrap.BootstrapResult(
            user_id=profile.id,
            email=profile.email,
            username=profile.username,
            status=profile.status,
        )
        assert invite.call_args.kwargs["bootstrap"] is True
        assert invite.call_args.args[1].role_id == admin.id
    assert profile.role_id == (admin.id if existing_profile else member.id)
    assert profile.status == "pending"
    if not existing_profile:
        database.commit.assert_not_called()


def test_bootstrap_requires_explicit_confirmation_outside_local_environments() -> None:
    settings = SimpleNamespace(environment="production")

    with pytest.raises(bootstrap.BootstrapError, match="--confirm"):
        bootstrap._validate_confirmation(settings, False)

    bootstrap._validate_confirmation(settings, True)
