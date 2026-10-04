"""Signed MFA enforcement and the real-provider TOTP session journey."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Annotated
from unittest.mock import Mock
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from tests.auth.test_supabase_auth_core import _client_for_key, _signed_access


def test_verified_provider_access_uses_exact_instance_session_and_assurance() -> None:
    from app.core.integrations.supabase_auth import InvalidProviderToken

    key = ec.generate_private_key(ec.SECP256R1())
    client = _client_for_key(key)
    user_id, session_id = uuid4(), uuid4()
    valid = _signed_access(key, user_id=str(user_id), session_id=str(session_id))
    identity = client.verify_access_token(valid)
    assert identity.user_id == user_id
    assert identity.session_id == session_id
    assert identity.issued_at <= datetime.now(UTC)
    for invalid in (
        _signed_access(
            key,
            user_id=str(user_id),
            session_id=str(session_id),
            issuer="https://other.example.test/auth/v1",
        ),
        _signed_access(key, user_id=str(user_id), session_id=str(session_id), audience="anon"),
        _signed_access(key, user_id=str(user_id), session_id=str(session_id), extra={"sub": "bad"}),
        _signed_access(
            key, user_id=str(user_id), session_id=str(session_id), extra={"session_id": "bad"}
        ),
        _signed_access(
            key,
            user_id=str(user_id),
            session_id=str(session_id),
            expires_at=datetime.now(UTC) - timedelta(minutes=1),
        ),
        _signed_access(key, user_id=str(user_id), session_id=str(session_id), extra={"aal": None}),
        _signed_access(
            key, user_id=str(user_id), session_id=str(session_id), extra={"aal": "aal9"}
        ),
    ):
        with pytest.raises(InvalidProviderToken):
            client.verify_access_token(invalid)
    claims = jwt.decode(valid, options={"verify_signature": False})
    del claims["aal"]
    missing = jwt.encode(claims, key, algorithm="ES256", headers={"kid": "test-key"})
    with pytest.raises(InvalidProviderToken):
        client.verify_access_token(missing)
    foreign_key = ec.generate_private_key(ec.SECP256R1())
    with pytest.raises(InvalidProviderToken):
        client.verify_access_token(
            _signed_access(
                foreign_key, user_id=str(user_id), session_id=str(session_id), extra={"aal": "aal2"}
            )
        )
    assert identity.assurance_level == "aal1"
    upgraded = _signed_access(
        key, user_id=str(user_id), session_id=str(session_id), extra={"aal": "aal2"}
    )
    assert client.verify_access_token(upgraded).assurance_level == "aal2"


@pytest.mark.parametrize(
    "policy,role,factor_status,assurance,expected",
    [
        ("optional", "member", None, "aal1", 200),
        ("optional", "member", "unverified", "aal1", 200),
        ("optional", "member", "verified", "aal1", 403),
        ("optional", "member", "verified", "aal2", 200),
        ("everyone", "member", None, "aal1", 403),
        ("everyone", "member", "verified", "aal2", 200),
        ("admins", "member", None, "aal1", 200),
        ("admins", "admin", None, "aal1", 403),
        ("admins", "admin", "verified", "aal2", 200),
    ],
)
def test_signed_assurance_policy_cannot_be_bypassed_by_request_parameters(
    monkeypatch, policy, role, factor_status, assurance, expected
) -> None:
    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import Session

    from app.common.dependencies import auth as dependency
    from app.core.database import get_db
    from app.systems.access.identity import provider_sessions
    from app.systems.access.identity.models import IdentitySession
    from app.systems.access.users.models import User
    from app.systems.manage.workspace.models import WorkspaceProfile

    key = ec.generate_private_key(ec.SECP256R1())
    local_id, provider_id, provider_session = uuid4(), uuid4(), uuid4()
    factor = {"id": str(uuid4()), "factor_type": "totp", "status": factor_status}
    provider = _client_for_key(key, user_id=provider_id, factors=[factor] if factor_status else [])
    user = User(
        id=local_id,
        supabase_user_id=provider_id,
        email="mfa@example.test",
        username="mfa",
        role=role,
        status="active",
    )
    session = IdentitySession(
        id=uuid4(),
        user_id=local_id,
        provider_user_id=provider_id,
        provider_session_id=provider_session,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    db = Mock(spec=Session)
    db.scalar.side_effect = lambda query: (
        session if query.column_descriptions[0]["entity"] is IdentitySession else user
    )
    db.execute.return_value.scalar_one.return_value = True
    profile = WorkspaceProfile(mfa_policy=policy, ip_allow_list=[])
    reads = []

    def read_policy(_db):
        reads.append(profile)
        return profile

    # Both import sites share one counter: the real resolver may not read it again.
    monkeypatch.setattr(provider_sessions, "load_workspace_policy", read_policy)
    monkeypatch.setattr(dependency, "load_workspace_policy", read_policy, raising=False)
    monkeypatch.setattr(dependency, "get_supabase_auth_client", lambda: provider)
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db

    @app.get("/protected")
    def protected(
        identity: Annotated[dependency.CurrentIdentity, Depends(dependency.get_current_identity)],
    ):
        return {"user_id": str(identity.user.id)}

    token = _signed_access(
        key, user_id=str(provider_id), session_id=str(provider_session), extra={"aal": assurance}
    )
    with TestClient(app) as browser:
        response = browser.get(
            "/protected?allow_aal1=true", headers={"Authorization": f"Bearer {token}"}
        )
    assert response.status_code == expected
    if expected == 403:
        assert response.json()["detail"]["code"] == "mfa_required"
    assert reads == [profile]


@pytest.mark.parametrize(
    "source,expected", [("10.1.2.3", 200), ("203.0.113.8", 403), ("unknown", 403)]
)
def test_authenticated_ip_policy_uses_transport_peer_not_forwarded_header(
    monkeypatch, source, expected
):
    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import Session

    from app.common.dependencies import auth as dependency
    from app.core.database import get_db
    from app.systems.access.identity import provider_sessions
    from app.systems.access.identity.models import IdentitySession
    from app.systems.access.users.models import User
    from app.systems.manage.workspace.models import WorkspaceProfile

    key = ec.generate_private_key(ec.SECP256R1())
    local_id, provider_id, provider_session = uuid4(), uuid4(), uuid4()
    provider = _client_for_key(key, user_id=provider_id)
    user = User(
        id=local_id,
        supabase_user_id=provider_id,
        email="ip@example.test",
        username="ip",
        role="member",
        status="active",
    )
    session = IdentitySession(
        id=uuid4(),
        user_id=local_id,
        provider_user_id=provider_id,
        provider_session_id=provider_session,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    db = Mock(spec=Session)
    db.scalar.side_effect = lambda query: (
        session if query.column_descriptions[0]["entity"] is IdentitySession else user
    )
    db.execute.return_value.scalar_one.return_value = True
    profile = WorkspaceProfile(mfa_policy="optional", ip_allow_list=["10.0.0.0/8"])
    reads = []

    def read_policy(_db):
        reads.append(profile)
        return profile

    # Both import sites share one counter: the real resolver may not read it again.
    monkeypatch.setattr(provider_sessions, "load_workspace_policy", read_policy)
    monkeypatch.setattr(dependency, "load_workspace_policy", read_policy, raising=False)
    monkeypatch.setattr(dependency, "get_supabase_auth_client", lambda: provider)
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db

    @app.get("/protected")
    def protected(
        identity: Annotated[dependency.CurrentIdentity, Depends(dependency.get_current_identity)],
    ):
        return {"user_id": str(identity.user.id)}

    token = _signed_access(key, user_id=str(provider_id), session_id=str(provider_session))
    with TestClient(app, client=(source, 50000)) as browser:
        response = browser.get(
            "/protected",
            headers={"Authorization": f"Bearer {token}", "X-Forwarded-For": "10.1.2.3"},
        )
    assert response.status_code == expected
    if expected == 403:
        assert response.json()["detail"]["code"] == "ip_not_allowed"
    assert reads == [profile]


@pytest.mark.parametrize(
    "path,payload",
    [
        ("/login", {"email": "mfa@example.test", "password": "ValidPassword12345"}),
        ("/token", {"email": "mfa@example.test", "password": "ValidPassword12345"}),
        ("/refresh", None),
        ("/token/refresh", {"refresh_token": "r" * 48}),
        ("/logout", None),
        ("/recovery/request", {"email": "mfa@example.test"}),
        ("/recovery/complete", {"token_hash": "a" * 56, "password": "ValidPassword12345"}),
        ("/invitations/complete", {"token_hash": "a" * 56, "password": "ValidPassword12345"}),
    ],
)
def test_auth_actions_reject_disallowed_transport_address_before_provider_work(
    monkeypatch, path, payload
):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.common.dependencies import auth as dependency
    from app.core.config import get_settings
    from app.core.database import get_db
    from app.systems.access.auth import router as auth_routes
    from app.systems.manage.workspace.models import WorkspaceProfile

    profile = WorkspaceProfile(mfa_policy="optional", ip_allow_list=["10.0.0.0/8"])
    provider = Mock()
    monkeypatch.setattr(dependency, "load_workspace_policy", lambda _db: profile)
    monkeypatch.setattr(auth_routes, "get_supabase_auth_client", lambda: provider)
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: Mock()
    app.include_router(auth_routes.auth_router, prefix="/api")
    with TestClient(
        app, base_url=get_settings().public_origin, client=("203.0.113.8", 50000)
    ) as browser:
        if path == "/refresh":
            browser.cookies.set("openslate_refresh", "r" * 48)
        response = browser.post(
            "/api/auth" + path,
            json=payload,
            headers={
                "Origin": get_settings().public_origin,
                "X-CSRF-Token": "c" * 48,
                "X-Forwarded-For": "10.1.2.3",
            },
        )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "ip_not_allowed"
    assert provider.mock_calls == []


@pytest.fixture
def mfa_context(monkeypatch):
    from cryptography.fernet import Fernet
    from pydantic import SecretStr
    from sqlalchemy.orm import Session

    from app.core.integrations.supabase_auth import (
        ProviderAccessIdentity,
        ProviderFactor,
        ProviderTokens,
        ProviderUser,
    )
    from app.systems.access.identity import mfa as service
    from app.systems.access.identity.models import IdentitySession
    from app.systems.access.users.models import User
    from app.systems.manage.workspace.models import WorkspaceProfile

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
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    db = Mock(spec=Session)
    db.scalar.return_value = user
    db.get.return_value = session
    db.scalars.return_value = [session]
    auth, mfa_client = Mock(), Mock()
    auth.get_user.return_value = ProviderUser(
        provider_id, None, user.email, factors=(ProviderFactor(factor_id, "totp", "unverified"),)
    )
    mfa_client.challenge_and_verify.return_value = ProviderTokens(
        "new-access", "new-refresh", provider_id, 600
    )
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
    monkeypatch.setattr(
        service,
        "load_workspace_policy",
        lambda _db: WorkspaceProfile(mfa_policy="optional", session_timeout_minutes=60),
        raising=False,
    )
    monkeypatch.setattr(service, "append_security_event", lambda *_args: None, raising=False)
    return context


def test_mfa_verification_commits_both_rotated_credentials_before_return(mfa_context):
    c = mfa_context
    committed = []
    c.db.commit.side_effect = lambda: committed.append(
        (
            c.cipher.decrypt(c.session.provider_access_token_encrypted.encode()),
            c.cipher.decrypt(c.session.provider_refresh_token_encrypted.encode()),
        )
    )
    result = c.service.verify_factor(
        c.db, c.user.id, c.session.id, c.factor_id, "123456", "old-access", c.auth
    )
    assert result == "new-access"
    assert committed == [(b"new-access", b"new-refresh")]
    assert c.session.refresh_token_digest == "stable-handle"
    assert c.session.csrf_token_digest == "stable-csrf"
    assert c.session.revoked_at is None


@pytest.mark.parametrize("mismatch", ["subject", "session", "aal"])
def test_mfa_upgrade_refuses_wrong_signed_binding_or_assurance(mfa_context, mismatch):
    from app.core.integrations.supabase_auth import ProviderAccessIdentity, SupabaseAuthUnavailable

    c = mfa_context
    original = c.auth.verify_access_token.side_effect

    def claims(token):
        claim = original(token)
        if token != "new-access":
            return claim
        return ProviderAccessIdentity(
            uuid4() if mismatch == "subject" else claim.user_id,
            uuid4() if mismatch == "session" else claim.session_id,
            claim.issued_at,
            claim.expires_at,
            "aal1" if mismatch == "aal" else "aal2",
        )

    c.auth.verify_access_token.side_effect = claims
    with pytest.raises(SupabaseAuthUnavailable):
        c.service.verify_factor(
            c.db, c.user.id, c.session.id, c.factor_id, "123456", "old-access", c.auth
        )
    assert c.session.revoked_at is not None
    assert c.cipher.decrypt(c.session.provider_refresh_token_encrypted.encode()) == b"old-refresh"


def test_mfa_rotated_pair_commit_failure_revokes_and_signs_out(mfa_context):
    from sqlalchemy.exc import SQLAlchemyError

    from app.core.integrations.supabase_auth import SupabaseAuthUnavailable

    c = mfa_context
    c.db.commit.side_effect = [SQLAlchemyError("write unavailable"), None]
    with pytest.raises(SupabaseAuthUnavailable):
        c.service.verify_factor(
            c.db, c.user.id, c.session.id, c.factor_id, "123456", "old-access", c.auth
        )
    assert c.session.revoked_at is not None
    c.auth.sign_out.assert_called_once_with("new-access")


@pytest.mark.parametrize("state", ["expired", "revoked"])
def test_expired_or_revoked_session_cannot_complete_mfa(mfa_context, state):
    from app.systems.access.identity.contracts import InvalidCredentials

    c = mfa_context
    if state == "expired":
        c.session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    else:
        c.session.revoked_at = datetime.now(UTC)
    with pytest.raises(InvalidCredentials):
        c.service.verify_factor(
            c.db, c.user.id, c.session.id, c.factor_id, "123456", "old-access", c.auth
        )
    c.mfa.challenge_and_verify.assert_not_called()


@pytest.mark.parametrize("status", ["unverified", "verified"])
def test_factor_removal_revokes_only_when_authoritatively_verified(mfa_context, status):
    from app.core.integrations.supabase_auth import ProviderFactor, ProviderUser

    c = mfa_context
    c.assurance = "aal2" if status == "verified" else "aal1"
    c.auth.get_user.return_value = ProviderUser(
        c.user.supabase_user_id,
        None,
        c.user.email,
        factors=(ProviderFactor(c.factor_id, "totp", status),),
    )
    verified = c.service.unenroll_factor(
        c.db, c.user.id, c.session.id, c.factor_id, "old-access", c.auth
    )
    assert verified is (status == "verified")
    assert (c.session.revoked_at is not None) is (status == "verified")


def test_other_users_factor_is_refused_before_provider_mutation(mfa_context):
    c = mfa_context
    with pytest.raises(c.service.MFAFactorUnavailable):
        c.service.verify_factor(
            c.db, c.user.id, c.session.id, uuid4(), "123456", "old-access", c.auth
        )
    c.mfa.challenge_and_verify.assert_not_called()


def test_stale_aal1_cannot_borrow_stored_aal2_to_remove_verified_factor(mfa_context):
    from app.core.integrations.supabase_auth import ProviderFactor, ProviderUser

    c = mfa_context
    c.session.provider_access_token_encrypted = c.cipher.encrypt(b"new-access").decode()
    c.auth.get_user.return_value = ProviderUser(
        c.user.supabase_user_id,
        None,
        c.user.email,
        factors=(ProviderFactor(c.factor_id, "totp", "verified"),),
    )
    with pytest.raises(c.service.MFARequired):
        c.service.unenroll_factor(c.db, c.user.id, c.session.id, c.factor_id, "old-access", c.auth)
    c.mfa.unenroll.assert_not_called()


def test_session_expiring_during_provider_verification_cannot_revive(mfa_context):
    from app.systems.access.identity.contracts import InvalidCredentials

    c = mfa_context
    tokens = c.mfa.challenge_and_verify.return_value

    def expire(*_args):
        c.session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        return tokens

    c.mfa.challenge_and_verify.side_effect = expire
    with pytest.raises(InvalidCredentials):
        c.service.verify_factor(
            c.db, c.user.id, c.session.id, c.factor_id, "123456", "old-access", c.auth
        )
    assert c.session.revoked_at is not None
