"""Shared router settings and the MFA service context for local-identity contract tests."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

import app.common.dependencies.auth as auth_dependencies
import app.systems.access.auth.request_security as request_security
import app.systems.access.auth.router as auth_router
from app.core.integrations.supabase_auth import (
    ProviderAccessIdentity,
    ProviderFactor,
    ProviderUser,
)
from app.systems.access.identity import mfa, provider_actions, provider_login, provider_sessions
from app.systems.access.identity.models import IdentityMfaObservation, IdentitySession
from app.systems.access.users import sessions_router
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile


@pytest.fixture(autouse=True)
def unit_workspace_policy(request, monkeypatch: pytest.MonkeyPatch) -> WorkspaceProfile | None:
    """Unit identity fakes now include the persisted workspace policy boundary.

    Provider integration journeys always load the actual singleton through PostgreSQL.
    """
    if request.node.get_closest_marker("integration") is not None:
        return
    profile = WorkspaceProfile(
        session_timeout_minutes=60,
        password_min_length=12,
        password_require_mixed_case=True,
        password_require_number=False,
        mfa_require_admin=False,
        mfa_require_member=False,
        mfa_require_guest=False,
        mfa_grace_days=0,
        session_absolute_lifetime_minutes=None,
        session_concurrent_limit=None,
        login_failed_attempt_threshold=5,
        login_window_minutes=15,
        login_cooldown_minutes=15,
        ip_allow_list=[],
    )
    monkeypatch.setattr(
        provider_actions, "load_workspace_policy", lambda _db: profile, raising=False
    )
    monkeypatch.setattr(
        provider_sessions, "load_workspace_policy", lambda _db: profile, raising=False
    )
    monkeypatch.setattr(sessions_router, "load_workspace_policy", lambda _db: profile)
    monkeypatch.setattr(mfa, "load_workspace_policy", lambda _db: profile)
    monkeypatch.setattr(provider_login, "load_workspace_policy", lambda _db: profile)
    monkeypatch.setattr(
        auth_dependencies, "load_workspace_policy", lambda _db: profile, raising=False
    )

    return profile


@pytest.fixture
def local_auth_router_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        request_security,
        "get_settings",
        lambda: SimpleNamespace(public_origin="https://app.example.test"),
    )
    monkeypatch.setattr(
        auth_router, "invitation_completion_permitted", lambda *_args, **_kwargs: True
    )


@pytest.fixture
def mfa_context(monkeypatch):
    from cryptography.fernet import Fernet
    from pydantic import SecretStr

    from app.core.integrations.supabase_auth import (
        ProviderTokens,
    )
    from app.systems.access.identity import mfa as service

    key = Fernet.generate_key()
    cipher = Fernet(key)
    provider_id, provider_session, factor_id = uuid4(), uuid4(), uuid4()
    user = User(
        id=uuid4(),
        supabase_user_id=provider_id,
        email="mfa@example.test",
        username="mfa",
        status="active",
        role="member",
    )
    session = IdentitySession(
        id=uuid4(),
        user_id=user.id,
        provider_user_id=provider_id,
        provider_session_id=provider_session,
        provider_access_token_encrypted=cipher.encrypt(b"old-access").decode(),
        provider_refresh_token_encrypted=cipher.encrypt(b"old-refresh").decode(),
        refresh_token_digest="stable-handle",
        csrf_token_digest="stable-csrf",
        created_at=datetime.now(UTC),
        refreshed_at=datetime.now(UTC),
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    db = Mock(spec=Session)
    db.scalar.side_effect = lambda query: (
        None if query.column_descriptions[0]["entity"] is IdentityMfaObservation else user
    )
    db.get.return_value = session
    db.scalars.return_value = [session]
    auth, mfa_client = Mock(), Mock()
    auth.get_user.return_value = ProviderUser(
        provider_id, None, user.email, factors=(ProviderFactor(factor_id, "totp", "unverified"),)
    )

    def rotate(*_args):
        auth.get_user.return_value = ProviderUser(
            provider_id, None, user.email, factors=(ProviderFactor(factor_id, "totp", "verified"),)
        )
        return ProviderTokens("new-access", "new-refresh", provider_id, 600)

    mfa_client.challenge_and_verify.side_effect = rotate
    context = SimpleNamespace(
        service=service,
        db=db,
        user=user,
        session=session,
        auth=auth,
        mfa=mfa_client,
        cipher=cipher,
        factor_id=factor_id,
        assurance="aal1",
    )
    auth.verify_access_token.side_effect = lambda token: ProviderAccessIdentity(
        provider_id,
        provider_session,
        datetime.now(UTC),
        datetime.now(UTC) + timedelta(minutes=10),
        "aal2" if token == "new-access" else context.assurance,
    )
    monkeypatch.setattr(
        service,
        "get_settings",
        lambda: SimpleNamespace(supabase_session_encryption_key=SecretStr(key.decode())),
        raising=False,
    )
    monkeypatch.setattr(service, "SupabaseMfaClient", lambda _auth: mfa_client, raising=False)
    # Durable admission is exercised with real PostgreSQL in test_mfa_budget_integration.
    monkeypatch.setattr(service.rate_limits, "mfa_verification_retry_after", lambda *_a, **_k: None)
    monkeypatch.setattr(service.rate_limits, "lock_bucket", lambda *_a: None)
    monkeypatch.setattr(service, "append_security_event", lambda *_args: None, raising=False)
    return context
