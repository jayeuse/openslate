"""Signed MFA enforcement and the real-provider TOTP session journey."""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Annotated
from unittest.mock import Mock
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.common.dependencies import auth as dependency
from app.core.database import get_db
from app.core.integrations.supabase_auth import (
    ProviderAccessIdentity,
    ProviderFactor,
    ProviderUser,
    SupabaseAuthUnavailable,
)
from app.systems.access.identity import provider_sessions
from app.systems.access.identity.contracts import InvalidCredentials
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import Membership, User
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile
from tests.auth.provider_jwt_support import client_for_key, signed_access
from tests.conftest import create_member


def test_verified_provider_access_uses_exact_instance_session_and_assurance() -> None:
    from app.core.integrations.supabase_auth import InvalidProviderToken

    key = ec.generate_private_key(ec.SECP256R1())
    client = client_for_key(key)
    user_id, session_id = uuid4(), uuid4()
    valid = signed_access(key, user_id=str(user_id), session_id=str(session_id))
    identity = client.verify_access_token(valid)
    assert identity.user_id == user_id
    assert identity.session_id == session_id
    assert identity.issued_at <= datetime.now(UTC)
    for invalid in (
        signed_access(
            key,
            user_id=str(user_id),
            session_id=str(session_id),
            issuer="https://other.example.test/auth/v1",
        ),
        signed_access(key, user_id=str(user_id), session_id=str(session_id), audience="anon"),
        signed_access(key, user_id=str(user_id), session_id=str(session_id), extra={"sub": "bad"}),
        signed_access(
            key, user_id=str(user_id), session_id=str(session_id), extra={"session_id": "bad"}
        ),
        signed_access(
            key,
            user_id=str(user_id),
            session_id=str(session_id),
            expires_at=datetime.now(UTC) - timedelta(minutes=1),
        ),
        signed_access(key, user_id=str(user_id), session_id=str(session_id), extra={"aal": None}),
        signed_access(key, user_id=str(user_id), session_id=str(session_id), extra={"aal": "aal9"}),
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
            signed_access(
                foreign_key, user_id=str(user_id), session_id=str(session_id), extra={"aal": "aal2"}
            )
        )
    assert identity.assurance_level == "aal1"
    upgraded = signed_access(
        key, user_id=str(user_id), session_id=str(session_id), extra={"aal": "aal2"}
    )
    assert client.verify_access_token(upgraded).assurance_level == "aal2"


def _protected_app(
    monkeypatch: pytest.MonkeyPatch,
    profile: WorkspaceProfile,
    *,
    role: str,
    name: str,
    factors: list[dict[str, str]] | None = None,
) -> tuple[FastAPI, Callable[..., str]]:
    """A route behind the real ``get_current_identity`` and a signer for its provider tokens.

    The provider serves a generated key's JWKS and the user's ``factors``; the database
    returns one active local user and its provider session; ``profile`` is the policy.
    """

    key = ec.generate_private_key(ec.SECP256R1())
    local_id, provider_id, provider_session = uuid4(), uuid4(), uuid4()
    profile.id = uuid4()
    provider = client_for_key(key, user_id=provider_id, factors=factors)
    user, membership = create_member(None, profile,
        id=local_id,
        supabase_user_id=provider_id,
        email=f"{name}@example.test",
        username=name,
        role=role,
        status="active",
    )
    session = IdentitySession(
        id=uuid4(),
        user_id=local_id,
        active_org_id=profile.id,
        provider_user_id=provider_id,
        provider_session_id=provider_session,
        created_at=datetime.now(UTC),
        refreshed_at=datetime.now(UTC),
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    db = Mock(spec=Session)
    db.dirty = set()
    db.info = {}
    db.in_transaction.return_value = False
    db.scalars.return_value.all.return_value = [membership]
    db.scalar.side_effect = lambda query: {
        IdentitySession: session, Membership: membership, User: user,
    }[query.column_descriptions[0]["entity"]]
    db.get.side_effect = lambda model, _identifier, **_kwargs: {
        IdentitySession: session, WorkspaceProfile: profile,
    }[model]
    db.execute.return_value.scalar_one.return_value = True
    monkeypatch.setattr(provider_sessions, "load_workspace_policy", lambda _db, **_kwargs: profile)
    platform = PlatformSettings(session_timeout_minutes=60, session_absolute_lifetime_minutes=None)
    monkeypatch.setattr(provider_sessions, "load_platform_policy", lambda _db: platform)
    monkeypatch.setattr(dependency, "load_platform_policy", lambda _db: platform)
    monkeypatch.setattr(dependency, "get_supabase_auth_client", lambda: provider)
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db

    @app.get("/protected")
    def protected(
        identity: Annotated[dependency.CurrentIdentity, Depends(dependency.get_current_identity)],
    ):
        return {"user_id": str(identity.user.id)}

    def signed_token(**claims: object) -> str:
        return signed_access(
            key, user_id=str(provider_id), session_id=str(provider_session), extra=claims or None
        )

    return app, signed_token


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

    factor = {"id": str(uuid4()), "factor_type": "totp", "status": factor_status}
    profile = WorkspaceProfile(
        mfa_require_admin=policy != "optional",
        mfa_require_member=policy == "everyone",
        mfa_require_guest=policy == "everyone",
        mfa_grace_days=0,
        ip_allow_list=[],
    )
    app, signed_token = _protected_app(
        monkeypatch, profile, role=role, name="mfa", factors=[factor] if factor_status else []
    )
    token = signed_token(aal=assurance)
    with TestClient(app) as browser:
        response = browser.get(
            "/protected?allow_aal1=true", headers={"Authorization": f"Bearer {token}"}
        )
    assert response.status_code == expected
    if expected == 403:
        assert response.json()["detail"]["code"] == "mfa_required"


@pytest.mark.integration
@pytest.mark.parametrize(
    "source,expected", [("10.1.2.3", 200), ("203.0.113.8", 403), ("unknown", 403)]
)
def test_authenticated_ip_policy_uses_transport_peer_not_forwarded_header(
    monkeypatch, source, expected
):

    profile = WorkspaceProfile(
        ip_allow_list=["10.0.0.0/8"],
    )
    app, signed_token = _protected_app(monkeypatch, profile, role="member", name="ip")
    token = signed_token()
    with TestClient(app, client=(source, 50000)) as browser:
        response = browser.get(
            "/protected",
            headers={"Authorization": f"Bearer {token}", "X-Forwarded-For": "10.1.2.3"},
        )
    assert response.status_code == expected
    if expected == 403:
        assert response.json()["detail"]["code"] == "ip_not_allowed"


@pytest.mark.integration
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
def test_auth_actions_are_not_gated_by_an_organization_allow_list(
    monkeypatch, path, payload
):
    """Owner decision (2026-10-16): allow lists gate organization entry, not sign-in.

    No organization is known before sign-in, so an anonymous auth action from an address
    that some organization blocks is never refused with ``ip_not_allowed``; sign-in budgets
    (H1, H2) limit it instead.
    """

    from app.core.config import get_settings
    from app.systems.access.auth import router as auth_routes

    provider = Mock()
    monkeypatch.setattr(auth_routes, "get_supabase_auth_client", lambda: provider)
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: Mock()
    app.include_router(auth_routes.auth_router, prefix="/api")
    with TestClient(
        app, base_url=get_settings().public_origin, client=("203.0.113.8", 50000),
        raise_server_exceptions=False,
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
    try:
        body = response.json()
    except ValueError:
        body = None
    detail = body.get("detail") if isinstance(body, dict) else None
    assert not (isinstance(detail, dict) and detail.get("code") == "ip_not_allowed")


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

    c = mfa_context
    rotate = c.mfa.challenge_and_verify.side_effect

    def expire(*args):
        tokens = rotate(*args)
        c.session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        return tokens

    c.mfa.challenge_and_verify.side_effect = expire
    with pytest.raises(InvalidCredentials):
        c.service.verify_factor(
            c.db, c.user.id, c.session.id, c.factor_id, "123456", "old-access", c.auth
        )
    assert c.session.revoked_at is not None
