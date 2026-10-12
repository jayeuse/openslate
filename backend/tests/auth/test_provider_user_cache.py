"""Ordinary authorization reuses a recent provider account only to admit."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock
from uuid import uuid4

import pytest

from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    ProviderAccessIdentity,
    ProviderFactor,
    ProviderUser,
)
from app.systems.access.identity import provider_sessions, provider_user_cache
from app.systems.access.identity.mfa import MFARequired
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User, UserRole, UserStatus
from tests.auth.provider_jwt_support import session_database


def _subject(*, assurance: str = "aal1"):
    now = datetime.now(UTC)
    user_id, provider_user_id, provider_session_id = uuid4(), uuid4(), uuid4()
    session = IdentitySession(
        id=uuid4(),
        user_id=user_id,
        provider_user_id=provider_user_id,
        provider_session_id=provider_session_id,
        refresh_token_digest="x" * 64,
        csrf_token_digest="y" * 64,
        created_at=now,
        refreshed_at=now,
        expires_at=now + timedelta(days=1),
    )
    user = User(
        id=user_id,
        supabase_user_id=provider_user_id,
        email="person@example.test",
        username="person",
        status=UserStatus.ACTIVE.value,
        role=UserRole.MEMBER,
    )
    claims = ProviderAccessIdentity(
        provider_user_id, provider_session_id, now, now + timedelta(minutes=10), assurance
    )
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(provider_user_id, None)
    return now, session_database(user, session), claims, client


def test_recent_provider_account_admits_without_another_provider_read() -> None:
    now, db, claims, client = _subject()
    for _ in range(3):
        assert provider_sessions.resolve_provider_session(db, claims, client, now=now)
    assert client.get_admin_user.call_count == 1


def test_provider_account_is_read_again_after_the_reuse_window(monkeypatch) -> None:
    now, db, claims, client = _subject()
    clock = [1000.0]
    monkeypatch.setattr(provider_user_cache, "monotonic", lambda: clock[0])
    assert provider_sessions.resolve_provider_session(db, claims, client, now=now)
    clock[0] += provider_user_cache.PROVIDER_USER_TTL_SECONDS
    assert provider_sessions.resolve_provider_session(db, claims, client, now=now)
    assert client.get_admin_user.call_count == 2


def test_out_of_band_provider_deletion_denies_once_the_window_ends(monkeypatch) -> None:
    now, db, claims, client = _subject()
    clock = [1000.0]
    monkeypatch.setattr(provider_user_cache, "monotonic", lambda: clock[0])
    assert provider_sessions.resolve_provider_session(db, claims, client, now=now)
    client.get_admin_user.side_effect = InvalidProviderCredentials("deleted in provider")
    # The accepted bound: a provider-only deletion may admit until the window ends.
    assert provider_sessions.resolve_provider_session(db, claims, client, now=now)
    clock[0] += provider_user_cache.PROVIDER_USER_TTL_SECONDS
    assert provider_sessions.resolve_provider_session(db, claims, client, now=now) is None


def test_mfa_denial_from_a_cached_account_is_recomputed_from_a_fresh_read(monkeypatch) -> None:
    now, db, claims, client = _subject(assurance="aal2")
    monkeypatch.setattr(provider_sessions, "requires_mfa", lambda *_args: True)
    client.get_admin_user.return_value = ProviderUser(claims.user_id, None)
    with pytest.raises(MFARequired):
        provider_sessions.resolve_provider_session(db, claims, client, now=now)
    # The person finishes enrolling; the stale cached account must not block them.
    factor = ProviderFactor(uuid4(), "totp", "verified")
    client.get_admin_user.return_value = ProviderUser(claims.user_id, None, factors=(factor,))
    provider_user_cache.remember_provider_user(ProviderUser(claims.user_id, None))
    assert provider_sessions.resolve_provider_session(db, claims, client, now=now)
    assert client.get_admin_user.call_count == 2
