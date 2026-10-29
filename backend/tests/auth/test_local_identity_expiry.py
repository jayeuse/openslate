"""Membership expiry limits organization authority, not global account admission."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from cryptography.fernet import Fernet
from sqlalchemy.orm import Session

from app.core.integrations.supabase_auth import ProviderAccessIdentity, ProviderTokens, ProviderUser
from app.systems.access.identity import provider_actions, provider_sessions
from app.systems.access.identity.contracts import InvalidCredentials
from app.systems.access.identity.models import IdentityMfaObservation, IdentitySession
from app.systems.access.identity.provider_login import login_with_provider
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile
from tests.conftest import create_member


def _subject(monkeypatch, *, expired: bool, status=UserStatus.ACTIVE.value):
    now = datetime.now(UTC)
    monkeypatch.setattr(provider_sessions, "utc_now", lambda: now)
    monkeypatch.setattr("app.systems.access.identity.eligibility.utc_now", lambda: now)
    provider_id, provider_session_id = uuid4(), uuid4()
    role = UserRole.MEMBER
    user, membership = create_member(None, WorkspaceProfile(id=uuid4()),
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
    monkeypatch.setattr(provider_sessions, "eligible_memberships",
                        lambda _db, _user_id: [] if expired else [membership])
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
            "openslate_invitation_operation_id": str(membership.provider_invitation_operation_id),
        },
        email_confirmed_at=now - timedelta(minutes=1),
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
        created_at=now,
        refreshed_at=now,
        expires_at=now + timedelta(days=1),
    )
    return now, user, membership, session, claims, client


def _identity_database(user, membership, now, *, session=None):
    observation = IdentityMfaObservation(
        user_id=user.id,
        observed_provider_user_id=user.supabase_user_id,
        verified_totp=False,
        observed_at=now - timedelta(seconds=1),
    )
    rows = {
        User: user,
        User.id: user.id,
        User.supabase_user_id: user.supabase_user_id,
        IdentitySession: session,
        IdentityMfaObservation: observation,
        SecurityEvent.id: uuid4(),
    }
    db = Mock(spec=Session)
    db.dirty = set()
    db.scalars.side_effect = lambda query: (
        Mock(all=lambda: [membership])
        if query.column_descriptions[0]["entity"] is Membership else
        [session] if query.column_descriptions[0]["entity"] is IdentitySession and session else []
    )
    db.scalar.side_effect = lambda query: rows[query.column_descriptions[0]["expr"]]

    def get(model, identifier, **_kwargs):
        row = rows[model]
        key = "user_id" if model is IdentityMfaObservation else "id"
        return row if row is not None and getattr(row, key) == identifier else None

    def add(instance):
        if isinstance(instance, IdentitySession):
            rows[IdentitySession] = instance

    db.get.side_effect = get
    db.add.side_effect = add
    db.execute.return_value.scalar_one.return_value = True
    return db


def test_expired_membership_still_allows_account_login_without_an_organization(monkeypatch):
    now, user, membership, _session, _claims, client = _subject(monkeypatch, expired=True)
    db = _identity_database(user, membership, now)
    issued = login_with_provider(
        db, user.email, "correct password", client, now=now, enforce_rate_limit=False
    )
    persisted = next(
        call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], IdentitySession)
    )
    assert issued.setup_only is False and persisted.active_org_id is None
    client.sign_out.assert_not_called()


def test_null_account_expiry_remains_eligible_for_password_login(monkeypatch):
    now, user, membership, _session, _claims, client = _subject(monkeypatch, expired=False)
    db = _identity_database(user, membership, now)
    issued = login_with_provider(
        db, user.email, "correct password", client, now=now, enforce_rate_limit=False
    )
    persisted = next(
        call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], IdentitySession)
    )
    assert persisted.user_id == user.id
    assert persisted.provider_user_id == user.supabase_user_id
    assert issued.access_token == "provider-access"
    assert issued.setup_only is False


def test_membership_expiry_does_not_revoke_the_account_session(monkeypatch):
    now, user, membership, session, claims, client = _subject(monkeypatch, expired=True)
    access_db = _identity_database(user, membership, now, session=session)
    resolved = provider_sessions.resolve_provider_session(access_db, claims, client, now=now)
    assert resolved is not None and resolved[0] is user

    db = _identity_database(user, membership, now, session=session)
    issued = provider_sessions.refresh_provider_session(db, "r" * 48, client, now=now)
    assert issued.session_id == session.id and session.revoked_at is None
    client.refresh.assert_not_called()


@pytest.mark.parametrize("kind", ["invite", "recovery"])
def test_expired_membership_blocks_invitation_but_not_bound_account_recovery(monkeypatch, kind):
    now, user, membership, session, _claims, client = _subject(
        monkeypatch,
        expired=True,
        status=UserStatus.PENDING.value if kind == "invite" else UserStatus.ACTIVE.value,
    )
    db = _identity_database(user, membership, now, session=session)
    if kind == "invite":
        with pytest.raises(InvitationError):
            provider_actions.complete_invitation(db, "a" * 56, "Replacement password", client)
        client.update_password.assert_not_called()
        db.commit.assert_not_called()
    else:
        monkeypatch.setattr(
            provider_actions.audit_service, "append_committed_security_event", Mock()
        )
        client.update_password.return_value = client.get_user.return_value
        provider_actions.complete_recovery(db, "a" * 56, "Replacement password", client)
        client.update_password.assert_called_once_with("provider-access", "Replacement password")
        assert session.revoked_at is not None and session.provider_signout_pending_at is not None
        db.commit.assert_called_once()
    client.sign_out.assert_called_once_with("provider-access", scope="global")


@pytest.mark.parametrize("minutes", [15, 30, 60, 480])
def test_admission_uses_workspace_session_timeout(monkeypatch, minutes):
    now, user, membership, _session, _claims, client = _subject(monkeypatch, expired=False)
    policy = PlatformSettings(session_timeout_minutes=minutes)
    monkeypatch.setattr(
        provider_sessions, "load_platform_policy", lambda _db: policy
    )
    db = _identity_database(user, membership, now)

    provider_sessions.admit_provider_session(
        db, client.password_grant.return_value, client, now=now
    )

    admitted = db.add.call_args.args[0]
    assert admitted.expires_at == now + timedelta(minutes=minutes)
    assert admitted.refreshed_at == now


@pytest.mark.parametrize("cached", [True, False])
def test_successful_refresh_renews_workspace_timeout_on_both_paths(monkeypatch, cached):
    now, user, membership, session, claims, client = _subject(monkeypatch, expired=False)
    policy = PlatformSettings(session_timeout_minutes=30)
    monkeypatch.setattr(
        provider_sessions, "load_platform_policy", lambda _db: policy
    )
    session.refreshed_at = now - timedelta(minutes=5)
    session.expires_at = now + timedelta(minutes=1)
    db = _identity_database(user, membership, now, session=session)
    if not cached:
        from app.core.integrations.supabase_auth import InvalidProviderToken

        client.verify_access_token.side_effect = [InvalidProviderToken("expired"), claims]
        client.refresh.return_value = client.password_grant.return_value

    issued = provider_sessions.refresh_provider_session(db, "r" * 48, client, now=now)

    assert issued.session_id == session.id
    assert session.refreshed_at == now
    assert session.expires_at == now + timedelta(minutes=30)
    db.commit.assert_called_once()
    assert client.refresh.call_count == (0 if cached else 1)


def test_expired_workspace_session_cannot_be_revived(monkeypatch):
    now, _user, _membership, session, _claims, client = _subject(monkeypatch, expired=False)
    session.expires_at = now
    session.refreshed_at = now - timedelta(minutes=30)
    db = Mock(spec=Session)
    db.scalar.return_value = session

    with pytest.raises(InvalidCredentials):
        provider_sessions.refresh_provider_session(db, "r" * 48, client, now=now)

    assert session.expires_at == now
    assert session.refreshed_at == now - timedelta(minutes=30)
    client.refresh.assert_not_called()
    db.commit.assert_not_called()


def test_failed_provider_refresh_never_extends_workspace_expiry(monkeypatch):
    from app.core.integrations.supabase_auth import InvalidProviderToken, SupabaseAuthUnavailable

    now, _user, _membership, session, _claims, client = _subject(monkeypatch, expired=False)
    session.refreshed_at = now - timedelta(minutes=5)
    session.expires_at = now + timedelta(minutes=1)
    db = Mock(spec=Session)
    db.scalar.return_value = session
    client.verify_access_token.side_effect = InvalidProviderToken("expired")
    client.refresh.side_effect = SupabaseAuthUnavailable("unavailable")

    with pytest.raises(SupabaseAuthUnavailable):
        provider_sessions.refresh_provider_session(db, "r" * 48, client, now=now)

    assert session.refreshed_at == now - timedelta(minutes=5)
    assert session.expires_at == now + timedelta(minutes=1)


@pytest.mark.parametrize("outage", ["auth_unavailable", "fresh_token_refused"])
def test_a_short_auth_outage_keeps_the_session_for_the_next_refresh(monkeypatch, outage):
    # Live seven-pack run: an Auth timeout or a fresh token that failed a local check
    # revoked the session, so a short Auth outage signed users out. Auth accepts the
    # same refresh token again for 10 s, so the next refresh can succeed.
    from app.core.integrations.supabase_auth import InvalidProviderToken, SupabaseAuthUnavailable

    now, user, membership, session, claims, client = _subject(monkeypatch, expired=False)
    monkeypatch.setattr(
        provider_sessions, "load_platform_policy", lambda _db: PlatformSettings(
            session_timeout_minutes=30
        )
    )
    session.refreshed_at = now - timedelta(minutes=5)
    session.expires_at = now + timedelta(minutes=1)
    db = _identity_database(user, membership, now, session=session)
    tokens = client.password_grant.return_value
    if outage == "auth_unavailable":
        client.verify_access_token.side_effect = [InvalidProviderToken("expired"),
                                                  InvalidProviderToken("expired"), claims]
        client.refresh.side_effect = [SupabaseAuthUnavailable("timeout"), tokens]
    else:
        client.verify_access_token.side_effect = [
            InvalidProviderToken("expired"),
            InvalidProviderToken("immature", kind="ImmatureSignatureError"),
            InvalidProviderToken("expired"),
            claims,
        ]
        client.refresh.return_value = tokens

    with pytest.raises(SupabaseAuthUnavailable):
        provider_sessions.refresh_provider_session(db, "r" * 48, client, now=now)
    assert session.revoked_at is None

    issued = provider_sessions.refresh_provider_session(db, "r" * 48, client, now=now)
    assert issued.session_id == session.id and session.revoked_at is None


def test_a_definite_auth_refusal_still_revokes_the_session(monkeypatch):
    from app.core.integrations.supabase_auth import (
        InvalidProviderCredentials,
        InvalidProviderToken,
    )

    now, user, membership, session, _claims, client = _subject(monkeypatch, expired=False)
    session.expires_at = now + timedelta(minutes=1)
    db = _identity_database(user, membership, now, session=session)
    client.verify_access_token.side_effect = InvalidProviderToken("expired")
    client.refresh.side_effect = InvalidProviderCredentials("refused")

    with pytest.raises(InvalidCredentials) as refused:
        provider_sessions.refresh_provider_session(db, "r" * 48, client, now=now)
    assert refused.value.reason == "provider_refused"
    assert session.revoked_at == now
