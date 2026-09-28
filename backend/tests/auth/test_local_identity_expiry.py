"""Backend account expiry remains authoritative after provider authentication."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from cryptography.fernet import Fernet
from sqlalchemy.orm import Session

from app.core.integrations.supabase_auth import ProviderAccessIdentity, ProviderTokens, ProviderUser
from app.systems.access.identity import provider_actions, provider_sessions
from app.systems.access.identity.contracts import ActionTokenInvalid, InvalidCredentials
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_login import login_with_provider
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import User, UserRole, UserStatus


def _subject(monkeypatch, *, expired: bool, status=UserStatus.ACTIVE.value):
    now = datetime.now(UTC)
    monkeypatch.setattr(provider_sessions, "utc_now", lambda: now)
    monkeypatch.setattr("app.systems.access.identity.eligibility.utc_now", lambda: now)
    provider_id, provider_session_id = uuid4(), uuid4()
    role = UserRole.MEMBER
    user = User(
        id=uuid4(),
        email="expiry@example.test",
        username="expiry",
        status=status,
        role=role,
        supabase_user_id=provider_id,
        expires_at=now if expired else None,
        invitation_sent_at=now - timedelta(minutes=1),
        invitation_accepted_at=now if status == UserStatus.ACTIVE.value else None,
        provider_invitation_operation_id=uuid4(),
    )
    tokens = ProviderTokens("provider-access", "provider-refresh", provider_id, 600)
    claims = ProviderAccessIdentity(
        provider_id, provider_session_id, now - timedelta(seconds=1), now + timedelta(minutes=10)
    )
    provider_user = ProviderUser(
        provider_id,
        None,
        user.email,
        {
            "openslate_user_id": str(user.id),
            "openslate_invitation_operation_id": str(user.provider_invitation_operation_id),
        },
    )
    client = Mock()
    client.password_grant.return_value = tokens
    client.verify_access_token.return_value = claims
    client.get_admin_user.return_value = provider_user
    client.verify_email_action.return_value = tokens
    client.get_user.return_value = provider_user
    cipher = Fernet(Fernet.generate_key())
    monkeypatch.setattr(provider_sessions, "_fernet", lambda: cipher)
    monkeypatch.setattr(
        provider_sessions, "get_settings", lambda: SimpleNamespace(auth_refresh_token_days=7)
    )
    session = IdentitySession(
        id=uuid4(),
        user_id=user.id,
        provider_user_id=provider_id,
        provider_session_id=provider_session_id,
        provider_access_token_encrypted=cipher.encrypt(tokens.access_token.encode()).decode(),
        provider_refresh_token_encrypted=cipher.encrypt(tokens.refresh_token.encode()).decode(),
        refresh_token_digest=provider_sessions._digest("r" * 48),
        csrf_token_digest="csrf-digest",
        expires_at=now + timedelta(days=1),
    )
    return now, user, session, claims, client


def test_expired_user_is_denied_password_login_with_the_generic_credential_error(monkeypatch):
    now, user, _session, _claims, client = _subject(monkeypatch, expired=True)
    db = Mock(spec=Session)
    db.scalar.return_value = user
    with pytest.raises(InvalidCredentials, match="Invalid credentials"):
        login_with_provider(
            db, user.email, "correct password", client, now=now, enforce_rate_limit=False
        )
    db.add.assert_not_called()
    client.sign_out.assert_called_once_with("provider-access")


def test_null_account_expiry_remains_eligible_for_password_login(monkeypatch):
    now, user, _session, _claims, client = _subject(monkeypatch, expired=False)
    db = Mock(spec=Session)
    db.scalar.return_value = user
    db.execute.return_value.scalar_one.return_value = True
    issued = login_with_provider(
        db, user.email, "correct password", client, now=now, enforce_rate_limit=False
    )
    persisted = db.add.call_args.args[0]
    assert persisted.user_id == user.id
    assert persisted.provider_user_id == user.supabase_user_id
    assert issued.access_token == "provider-access"
    assert issued.setup_only is False


def test_expired_user_cannot_refresh_or_validate_an_existing_session(monkeypatch):
    now, user, session, claims, client = _subject(monkeypatch, expired=True)
    access_db = Mock(spec=Session)
    access_db.scalar.side_effect = [session, user]
    assert provider_sessions.resolve_provider_session(access_db, claims, client, now=now) is None

    db = Mock(spec=Session)
    db.scalar.side_effect = [session, session, user]
    with pytest.raises(InvalidCredentials, match="Invalid credentials"):
        provider_sessions.refresh_provider_session(db, "r" * 48, client, now=now)
    assert session.revoked_at == now
    client.refresh.assert_not_called()


@pytest.mark.parametrize("kind", ["recovery", "invite"])
def test_expired_user_cannot_complete_provider_email_actions(monkeypatch, kind):
    _now, user, _session, _claims, client = _subject(
        monkeypatch,
        expired=True,
        status=UserStatus.PENDING.value if kind == "invite" else UserStatus.ACTIVE.value,
    )
    db = Mock(spec=Session)
    db.scalar.return_value = user
    action = (
        provider_actions.complete_invitation
        if kind == "invite"
        else provider_actions.complete_recovery
    )
    error = InvitationError if kind == "invite" else ActionTokenInvalid
    with pytest.raises(error):
        action(db, "a" * 56, "replacement password", client)
    client.update_password.assert_not_called()
    db.commit.assert_not_called()
    client.sign_out.assert_called_once_with("provider-access", scope="global")
