"""Elevated administrator recovery sends provider email without a local secret."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.identity.admin_recovery as recovery
from app.core.integrations.supabase_auth import ProviderUser
from app.systems.access.identity.admin_recovery import LocalRecoveryError, recover_local_admin
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus


def _admin() -> User:
    role = Role(id=uuid7(), role=UserRole.ADMIN, permissions={})
    return User(
        id=uuid7(),
        email="admin@example.com",
        username="admin",
        supabase_user_id=uuid7(),
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
        role=role,
        identity_kind=IdentityKind.INTERNAL.value,
    )


@pytest.mark.parametrize("local,elevated", [(False, True), (True, False)])
def test_recovery_refuses_nonlocal_or_non_elevated(local: bool, elevated: bool) -> None:
    with pytest.raises(LocalRecoveryError):
        recover_local_admin(Mock(spec=Session), uuid7(), local_invocation=local, elevated=elevated)


def test_recovery_refuses_unbound_or_ineligible_administrator() -> None:
    user = _admin()
    user.supabase_user_id = None
    db = Mock(spec=Session)
    db.scalar.return_value = user
    with pytest.raises(LocalRecoveryError):
        recover_local_admin(db, user.id, local_invocation=True, elevated=True)
    db.commit.assert_not_called()


def test_recovery_revokes_sessions_then_sends_provider_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = _admin()
    session = IdentitySession(
        id=uuid7(),
        user_id=user.id,
        refresh_token_digest="digest",
        csrf_token_digest="csrf",
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    db = Mock(spec=Session)
    db.scalar.return_value = user
    db.scalars.return_value = [session]
    events: list[str] = []
    db.commit.side_effect = lambda: events.append("commit")
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(user.supabase_user_id, None, user.email)
    client.request_recovery.side_effect = lambda _email: events.append("mail")
    monkeypatch.setattr(recovery, "get_supabase_auth_client", lambda: client, raising=False)
    monkeypatch.setattr(recovery, "append_security_event", lambda *_a: None)
    monkeypatch.setattr(
        recovery, "append_committed_security_event", lambda *_a: None, raising=False
    )

    result = recover_local_admin(db, user.id, local_invocation=True, elevated=True)

    assert result.user_id == user.id
    assert not hasattr(result, "temporary_password")
    assert session.revoked_at is not None
    assert events == ["commit", "mail"]
    client.request_recovery.assert_called_once_with(user.email)


def test_recovery_commit_failure_does_not_send_mail(monkeypatch: pytest.MonkeyPatch) -> None:
    user = _admin()
    db = Mock(spec=Session)
    db.scalar.return_value = user
    db.scalars.return_value = []
    db.commit.side_effect = SQLAlchemyError("offline")
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(user.supabase_user_id, None, user.email)
    monkeypatch.setattr(recovery, "get_supabase_auth_client", lambda: client, raising=False)
    monkeypatch.setattr(recovery, "append_security_event", lambda *_a: None)

    with pytest.raises(LocalRecoveryError):
        recover_local_admin(db, user.id, local_invocation=True, elevated=True)
    client.request_recovery.assert_not_called()
