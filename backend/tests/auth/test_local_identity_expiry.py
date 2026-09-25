"""Account expiry behavior at the local identity boundary."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.identity.models import (
    ActionTokenPurpose,
    IdentityActionToken,
    IdentitySession,
)
from app.systems.access.identity.service import (
    ActionTokenInvalid,
    InvalidCredentials,
    _digest,
    authenticate_password,
    consume_action_token,
    refresh_session,
    validate_access_session,
)
from app.systems.access.users.models import Role, User, UserRole, UserStatus


def test_expired_user_is_denied_password_login_with_the_generic_credential_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An account expiring at the authoritative instant cannot start a session."""

    now = datetime.now(UTC)
    role = Role(id=uuid7(), role=UserRole.MEMBER, permissions={})
    user = User(
        id=uuid7(),
        email="expired@example.test",
        username="expired",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
        role=role,
        expires_at=now,
    )
    credential = Mock(
        password_digest="credential-digest",
        must_change_password=False,
        temporary_password_expires_at=None,
    )
    db = Mock(spec=Session)
    db.scalar.return_value = user
    db.get.return_value = credential
    monkeypatch.setattr("app.systems.access.identity.service.verify_password", lambda *_args: True)

    with pytest.raises(InvalidCredentials, match="Invalid credentials"):
        authenticate_password(db, user.email, "correct password", now=now, enforce_rate_limit=False)


def test_null_account_expiry_remains_eligible_for_password_login(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(UTC)
    role = Role(id=uuid7(), role=UserRole.MEMBER, permissions={})
    user = User(
        id=uuid7(),
        email="permanent@example.test",
        username="permanent",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
        role=role,
        expires_at=None,
    )
    credential = Mock(
        password_digest="credential-digest",
        must_change_password=False,
        temporary_password_expires_at=None,
    )
    db = Mock(spec=Session)
    db.scalar.return_value = user
    db.get.return_value = credential
    monkeypatch.setattr("app.systems.access.identity.service.verify_password", lambda *_args: True)

    assert (
        authenticate_password(db, user.email, "correct password", now=now, enforce_rate_limit=False)
        is user
    )


def test_expired_user_cannot_refresh_or_validate_an_existing_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(UTC)
    user_id = uuid7()
    session_id = uuid7()
    role = Role(id=uuid7(), role=UserRole.MEMBER, permissions={})
    user = User(
        id=user_id,
        email="expired-session@example.test",
        username="expired-session",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
        role=role,
        expires_at=now,
    )
    session = IdentitySession(
        id=session_id,
        user_id=user_id,
        refresh_token_digest=_digest("refresh-id"),
        csrf_token_digest="csrf-digest",
        expires_at=now + timedelta(days=1),
    )
    credential = Mock(must_change_password=False)
    db = Mock(spec=Session)
    db.get.side_effect = [session, credential]
    db.scalar.return_value = user
    monkeypatch.setattr(
        "app.systems.access.identity.service.decode_token",
        lambda *_args, **_kwargs: {
            "sub": str(user_id),
            "sid": str(session_id),
            "jti": "refresh-id",
        },
    )

    with pytest.raises(InvalidCredentials, match="Invalid credentials"):
        refresh_session(db, "refresh-token", now=now)
    assert session.revoked_at == now

    access_session = IdentitySession(
        id=session_id,
        user_id=user_id,
        refresh_token_digest=_digest("refresh-id"),
        csrf_token_digest="csrf-digest",
        expires_at=now + timedelta(days=1),
    )
    access_db = Mock(spec=Session)
    access_db.get.return_value = access_session
    access_db.scalar.return_value = user
    assert (
        validate_access_session(
            access_db,
            {"sub": str(user_id), "sid": str(session_id), "iat": now.timestamp()},
            now=now,
        )
        is None
    )


@pytest.mark.parametrize(
    "purpose,status_value",
    [
        (ActionTokenPurpose.RECOVERY, UserStatus.ACTIVE.value),
        (ActionTokenPurpose.INVITATION, UserStatus.PENDING.value),
    ],
)
def test_expired_user_cannot_consume_recovery_or_setup_action_tokens(
    purpose: ActionTokenPurpose,
    status_value: str,
) -> None:
    now = datetime.now(UTC)
    user_id = uuid7()
    role = Role(id=uuid7(), role=UserRole.MEMBER, permissions={})
    user = User(
        id=user_id,
        email="expired-action@example.test",
        username="expired-action",
        status=status_value,
        role_id=role.id,
        role=role,
        expires_at=now,
    )
    action = IdentityActionToken(
        user_id=user_id,
        purpose=purpose,
        token_digest=_digest("action-token"),
        expires_at=now + timedelta(minutes=30),
    )
    db = Mock(spec=Session)
    db.scalar.side_effect = [action, action]
    db.get.return_value = user

    with pytest.raises(ActionTokenInvalid, match="Token is invalid"):
        consume_action_token(db, "action-token", purpose, now=now)
