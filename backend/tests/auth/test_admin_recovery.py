from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.identity.admin_recovery as recovery
from app.core.security.passwords import hash_password, verify_password
from app.systems.access.identity.admin_recovery import LocalRecoveryError, recover_local_admin
from app.systems.access.identity.models import IdentityCredential, IdentitySession
from app.systems.access.users.models import Role, User, UserRole, UserStatus


def _admin() -> User:
    role = Role(id=uuid7(), role=UserRole.ADMIN, permissions={})
    return User(
        id=uuid7(),
        email="admin@example.com",
        username="admin",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
        role=role,
    )


@pytest.mark.parametrize("local,elevated", [(False, True), (True, False)])
def test_recovery_refuses_nonlocal_or_non_elevated(local: bool, elevated: bool) -> None:
    with pytest.raises(LocalRecoveryError):
        recover_local_admin(Mock(spec=Session), uuid7(), local_invocation=local, elevated=elevated)


def test_recovery_refuses_non_admin_target() -> None:
    user = _admin()
    user.role = Role(id=uuid7(), role=UserRole.MEMBER, permissions={})
    db = Mock(spec=Session)
    db.scalar.return_value = user

    with pytest.raises(LocalRecoveryError):
        recover_local_admin(db, user.id, local_invocation=True, elevated=True)

    db.rollback.assert_called_once()


def test_recovery_rotates_to_a_temporary_secret_revokes_sessions_and_records_safe_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = _admin()
    now = datetime.now(UTC).replace(microsecond=0)
    credential = IdentityCredential(
        user_id=user.id,
        password_digest=hash_password("initial recovery password"),
        must_change_password=False,
        temporary_password_expires_at=None,
        password_changed_at=now - timedelta(days=1),
    )
    existing_session = IdentitySession(
        id=uuid7(),
        user_id=user.id,
        refresh_token_digest="active-refresh-digest",
        csrf_token_digest="active-csrf-digest",
        expires_at=now + timedelta(days=7),
    )
    db = Mock(spec=Session)
    db.scalar.return_value = user
    db.get.return_value = credential
    db.scalars.return_value = [existing_session]
    event = Mock()
    monkeypatch.setattr(recovery, "generated_temporary_password", lambda: "recover-secret-123")
    monkeypatch.setattr(recovery, "append_security_event", event)

    result = recover_local_admin(db, user.id, local_invocation=True, elevated=True)

    assert result.temporary_password == "recover-secret-123"
    assert verify_password(result.temporary_password, credential.password_digest)
    assert credential.must_change_password is True
    assert credential.temporary_password_expires_at == credential.password_changed_at + timedelta(
        hours=24
    )
    assert user.tokens_valid_after == credential.password_changed_at
    assert existing_session.revoked_at == credential.password_changed_at
    db.commit.assert_called_once()
    payload = event.call_args.args[1]
    assert "recover-secret-123" not in str(payload)


def test_recovery_rolls_back_the_password_when_security_event_cannot_commit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = _admin()
    credential = IdentityCredential(
        user_id=user.id,
        password_digest=hash_password("initial recovery password"),
        must_change_password=False,
        temporary_password_expires_at=None,
        password_changed_at=datetime.now(UTC) - timedelta(days=1),
    )
    db = Mock(spec=Session)
    db.scalar.return_value = user
    db.get.return_value = credential
    db.scalars.return_value = []
    db.commit.side_effect = SQLAlchemyError("event write failed")
    monkeypatch.setattr(recovery, "append_security_event", Mock())

    with pytest.raises(LocalRecoveryError):
        recover_local_admin(db, user.id, local_invocation=True, elevated=True)

    db.rollback.assert_called_once()
