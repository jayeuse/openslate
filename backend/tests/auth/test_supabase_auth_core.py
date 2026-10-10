"""Supabase Auth boundary contracts with generated signing keys and a local HTTP peer."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Annotated
from unittest.mock import Mock
from uuid import uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm
from pydantic import SecretStr
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentityMfaObservation, IdentitySession
from app.systems.access.users.models import User, UserRole, UserStatus


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        supabase_url="https://supabase.example.test",
        supabase_auth_issuer="https://supabase.example.test/auth/v1",
        supabase_auth_audience="authenticated",
        supabase_publishable_key=SecretStr("sb_publishable_test"),
        supabase_secret_key=SecretStr("sb_secret_test"),
        supabase_timeout_seconds=2,
    )


def _signed_access(
    private_key: ec.EllipticCurvePrivateKey,
    *,
    user_id: str,
    session_id: str,
    issuer: str = "https://supabase.example.test/auth/v1",
    audience: str = "authenticated",
    expires_at: datetime | None = None,
    include_nbf: bool = True,
    kid: str = "test-key",
    extra: dict[str, object] | None = None,
) -> str:
    now = datetime.now(UTC)
    claims: dict[str, object] = {
        "sub": user_id,
        "session_id": session_id,
        "iss": issuer,
        "aud": audience,
        "iat": now,
        "exp": expires_at or now + timedelta(minutes=10),
        "role": "admin",
        "aal": "aal1",
        "user_metadata": {"role": "admin"},
        **(extra or {}),
    }
    if include_nbf and "nbf" not in claims:
        claims["nbf"] = now
    return jwt.encode(claims, private_key, algorithm="ES256", headers={"kid": kid})


def _client_for_key(private_key: ec.EllipticCurvePrivateKey, *, user_id=None, factors=None):
    from app.core.integrations.supabase_auth import SupabaseAuthClient

    jwk = ECAlgorithm.to_jwk(private_key.public_key(), as_dict=True)
    jwk.update({"kid": "test-key", "alg": "ES256", "use": "sig"})

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/auth/v1/admin/users/"):
            assert request.headers["apikey"] == "sb_secret_test"
            assert "authorization" not in request.headers
            return httpx.Response(
                200,
                json={"id": str(user_id), **({"factors": factors} if factors is not None else {})},
            )
        assert request.headers["apikey"] == "sb_publishable_test"
        if request.url.path.endswith("/.well-known/jwks.json"):
            return httpx.Response(200, json={"keys": [jwk]})
        return httpx.Response(404)

    return SupabaseAuthClient(_settings(), transport=httpx.MockTransport(respond))


def _session_database(user: User, session: IdentitySession) -> Mock:
    observation = IdentityMfaObservation(
        user_id=user.id,
        observed_provider_user_id=user.supabase_user_id,
        verified_totp=False,
        observed_at=session.created_at - timedelta(seconds=1),
    )
    rows = {
        User: user,
        User.supabase_user_id: user.supabase_user_id,
        IdentitySession: session,
        IdentityMfaObservation: observation,
    }
    db = Mock(spec=Session)
    db.scalar.side_effect = lambda query: rows[query.column_descriptions[0]["expr"]]

    def get(model, identifier, **_kwargs):
        row = rows[model]
        key = "user_id" if model is IdentityMfaObservation else "id"
        return row if getattr(row, key) == identifier else None

    db.get.side_effect = get
    db.execute.return_value.scalar_one.return_value = True
    return db


def test_provider_access_accepts_missing_nbf_but_enforces_nbf_when_present() -> None:
    from app.core.integrations.supabase_auth import InvalidProviderToken

    key = ec.generate_private_key(ec.SECP256R1())
    client = _client_for_key(key)
    user_id, session_id = uuid4(), uuid4()
    real_shape = _signed_access(
        key, user_id=str(user_id), session_id=str(session_id), include_nbf=False
    )
    assert client.verify_access_token(real_shape).session_id == session_id

    premature = _signed_access(
        key,
        user_id=str(user_id),
        session_id=str(session_id),
        extra={"nbf": datetime.now(UTC) + timedelta(minutes=5)},
    )
    with pytest.raises(InvalidProviderToken):
        client.verify_access_token(premature)


def test_unknown_signing_kids_have_one_bounded_refresh_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.integrations.supabase_auth import InvalidProviderToken, SupabaseAuthClient

    clock = [100.0]
    monkeypatch.setattr("app.core.integrations.supabase_auth.time.monotonic", lambda: clock[0])
    first_key = ec.generate_private_key(ec.SECP256R1())
    rotated_key = ec.generate_private_key(ec.SECP256R1())
    first_jwk = ECAlgorithm.to_jwk(first_key.public_key(), as_dict=True)
    first_jwk.update({"kid": "first", "alg": "ES256", "use": "sig"})
    rotated_jwk = ECAlgorithm.to_jwk(rotated_key.public_key(), as_dict=True)
    rotated_jwk.update({"kid": "rotated", "alg": "ES256", "use": "sig"})
    state = {"fetches": 0, "keys": [first_jwk]}

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/.well-known/jwks.json")
        state["fetches"] += 1
        return httpx.Response(200, json={"keys": state["keys"]})

    client = SupabaseAuthClient(_settings(), transport=httpx.MockTransport(respond))
    user_id, session_id = uuid4(), uuid4()
    first = _signed_access(first_key, user_id=str(user_id), session_id=str(session_id), kid="first")
    rotated = _signed_access(
        rotated_key, user_id=str(user_id), session_id=str(session_id), kid="rotated"
    )
    assert client.verify_access_token(first).session_id == session_id
    assert state["fetches"] == 1
    for _ in range(3):
        with pytest.raises(InvalidProviderToken):
            client.verify_access_token(rotated)
    assert state["fetches"] == 1
    clock[0] += 11
    with pytest.raises(InvalidProviderToken):
        client.verify_access_token(rotated)
    assert state["fetches"] == 2
    state["keys"] = [first_jwk, rotated_jwk]
    clock[0] += 11
    assert client.verify_access_token(rotated).session_id == session_id
    assert state["fetches"] == 3


def test_provider_password_and_refresh_failures_keep_denial_distinct_from_outage() -> None:
    from app.core.integrations.supabase_auth import (
        InvalidProviderCredentials,
        SupabaseAuthClient,
        SupabaseAuthUnavailable,
    )

    def invalid(request: httpx.Request) -> httpx.Response:
        assert request.headers["apikey"] == "sb_publishable_test"
        assert "sb_secret_test" not in str(request.headers)
        return httpx.Response(400, json={"error_code": "invalid_credentials"})

    client = SupabaseAuthClient(_settings(), transport=httpx.MockTransport(invalid))
    with pytest.raises(InvalidProviderCredentials):
        client.password_grant("person@example.test", "wrong")

    def outage(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("provider unavailable")

    unavailable = SupabaseAuthClient(_settings(), transport=httpx.MockTransport(outage))
    with pytest.raises(SupabaseAuthUnavailable):
        unavailable.refresh("opaque-provider-refresh")


def test_provider_session_admission_requires_explicit_subject_mapping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cryptography.fernet import Fernet

    from app.core.integrations.supabase_auth import (
        ProviderAccessIdentity,
        ProviderTokens,
        ProviderUser,
    )
    from app.systems.access.identity.provider_sessions import admit_provider_session

    key = Fernet.generate_key().decode("ascii")
    settings = SimpleNamespace(
        supabase_session_encryption_key=SecretStr(key), auth_refresh_token_days=7
    )
    monkeypatch.setattr(
        "app.systems.access.identity.provider_sessions.get_settings", lambda: settings
    )
    user_id, provider_user_id, provider_session_id = uuid4(), uuid4(), uuid4()
    user = User(
        id=user_id,
        supabase_user_id=provider_user_id,
        email="person@example.test",
        username="person",
        status=UserStatus.ACTIVE.value,
        role=UserRole.MEMBER,
    )
    db = Mock(spec=Session)
    db.scalar.return_value = user
    db.execute.return_value.scalar_one.return_value = True
    client = Mock()
    client.verify_access_token.return_value = ProviderAccessIdentity(
        provider_user_id,
        provider_session_id,
        datetime.now(UTC),
        datetime.now(UTC) + timedelta(minutes=10),
    )
    client.get_admin_user.return_value = ProviderUser(
        provider_user_id, None, email="person@example.test", email_confirmed_at=datetime.now(UTC)
    )
    tokens = ProviderTokens("provider-access", "provider-refresh", provider_user_id, 600)

    issued = admit_provider_session(db, tokens, client, user_agent="test")

    session = db.add.call_args.args[0]
    assert isinstance(session, IdentitySession)
    assert issued.session_id == session.id
    assert issued.access_token == "provider-access"
    assert issued.refresh_token != "provider-refresh"
    assert session.user_id == user_id
    assert session.provider_user_id == provider_user_id
    assert session.provider_session_id == provider_session_id
    assert session.refresh_token_digest != issued.refresh_token
    assert "provider-refresh" not in session.provider_refresh_token_encrypted
    assert (
        Fernet(key).decrypt(session.provider_refresh_token_encrypted.encode())
        == b"provider-refresh"
    )

    user.supabase_user_id = uuid4()
    with pytest.raises(Exception, match="Invalid credentials"):
        admit_provider_session(db, tokens, client)


def test_valid_provider_jwt_still_requires_live_local_and_provider_sessions() -> None:
    from app.core.integrations.supabase_auth import (
        InvalidProviderCredentials,
        ProviderAccessIdentity,
        ProviderUser,
    )
    from app.systems.access.identity.provider_sessions import resolve_provider_session

    now = datetime.now(UTC)
    user_id, provider_user_id, provider_session_id = uuid4(), uuid4(), uuid4()
    local_session = IdentitySession(
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
    db = _session_database(user, local_session)
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(provider_user_id, None)
    identity = ProviderAccessIdentity(
        provider_user_id,
        provider_session_id,
        now,
        now + timedelta(minutes=10),
    )

    resolved = resolve_provider_session(db, identity, client, now=now)
    assert resolved is not None
    assert resolved[0] is user
    assert resolved[1] is local_session
    assert user.role == UserRole.MEMBER.value

    local_session.revoked_at = now
    assert resolve_provider_session(db, identity, client, now=now) is None

    local_session.revoked_at = None
    client.get_admin_user.side_effect = InvalidProviderCredentials("admin user deleted")
    assert resolve_provider_session(db, identity, client, now=now) is None

    from app.core.integrations.supabase_auth import ProviderUserNotFound

    client.get_admin_user.side_effect = ProviderUserNotFound("admin user deleted")
    assert resolve_provider_session(db, identity, client, now=now) is None


def test_concurrent_refresh_reuses_current_provider_token_and_stable_handle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cryptography.fernet import Fernet

    from app.core.integrations.supabase_auth import ProviderAccessIdentity, ProviderUser
    from app.systems.access.identity.provider_sessions import refresh_provider_session

    now = datetime.now(UTC)
    key = Fernet.generate_key().decode("ascii")
    monkeypatch.setattr(
        "app.systems.access.identity.provider_sessions.get_settings",
        lambda: SimpleNamespace(supabase_session_encryption_key=SecretStr(key)),
    )
    user_id, provider_user_id, provider_session_id = uuid4(), uuid4(), uuid4()
    user = User(
        id=user_id,
        supabase_user_id=provider_user_id,
        email="person@example.test",
        username="person",
        status=UserStatus.ACTIVE.value,
        role=UserRole.MEMBER,
    )
    session = IdentitySession(
        id=uuid4(),
        user_id=user_id,
        provider_user_id=provider_user_id,
        provider_session_id=provider_session_id,
        provider_access_token_encrypted=Fernet(key).encrypt(b"current-access").decode(),
        provider_refresh_token_encrypted=Fernet(key).encrypt(b"current-refresh").decode(),
        refresh_token_digest=__import__("hashlib").sha256(b"h" * 48).hexdigest(),
        csrf_token_digest=__import__("hashlib").sha256(b"c" * 48).hexdigest(),
        created_at=now,
        refreshed_at=now,
        expires_at=now + timedelta(days=1),
    )
    db = _session_database(user, session)
    client = Mock()
    client.verify_access_token.return_value = ProviderAccessIdentity(
        provider_user_id,
        provider_session_id,
        now,
        now + timedelta(minutes=10),
    )
    client.get_admin_user.return_value = ProviderUser(provider_user_id, None)

    issued = refresh_provider_session(db, "h" * 48, client, csrf_token="c" * 48, now=now)

    assert issued.access_token == "current-access"
    assert issued.refresh_token == "h" * 48
    assert issued.csrf_token == "c" * 48
    client.refresh.assert_not_called()
    db.commit.assert_called_once()


def test_api_dependency_requires_bound_provider_and_rejects_mixed_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient

    from app.common.dependencies import auth as dependency
    from app.core.database import get_db

    now = datetime.now(UTC)
    monkeypatch.setattr("app.systems.access.identity.provider_sessions.utc_now", lambda: now)
    key = ec.generate_private_key(ec.SECP256R1())
    user_id, provider_id, provider_session_id = uuid4(), uuid4(), uuid4()
    access = _signed_access(key, user_id=str(provider_id), session_id=str(provider_session_id))
    client = _client_for_key(key, user_id=provider_id)
    monkeypatch.setattr(dependency, "get_supabase_auth_client", lambda: client)
    user = User(
        id=user_id,
        supabase_user_id=provider_id,
        email="person@example.test",
        username="person",
        status=UserStatus.ACTIVE.value,
        role=UserRole.MEMBER,
    )
    session = IdentitySession(
        id=uuid4(),
        user_id=user_id,
        provider_user_id=provider_id,
        provider_session_id=provider_session_id,
        refresh_token_digest="x" * 64,
        csrf_token_digest="y" * 64,
        created_at=now,
        refreshed_at=now,
        expires_at=now + timedelta(days=1),
    )
    db = _session_database(user, session)
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db

    @app.get("/protected")
    def protected(
        identity: Annotated[dependency.CurrentIdentity, Depends(dependency.get_current_identity)],
    ):
        return {"user_id": str(identity.user.id), "session_id": str(identity.session_id)}

    with TestClient(app) as browser:
        authorized = browser.get("/protected", headers={"Authorization": f"Bearer {access}"})
        assert authorized.status_code == 200
        assert authorized.json() == {"user_id": str(user_id), "session_id": str(session.id)}
        mixed = browser.get(
            "/protected",
            headers={"Authorization": f"Bearer {access}"},
            cookies={"openslate_access": access},
        )
        assert mixed.status_code == 401


def test_ambiguous_refresh_persistence_failure_revokes_the_local_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cryptography.fernet import Fernet
    from sqlalchemy.exc import SQLAlchemyError

    from app.core.integrations.supabase_auth import (
        InvalidProviderToken,
        ProviderAccessIdentity,
        ProviderTokens,
        ProviderUser,
        SupabaseAuthUnavailable,
    )
    from app.systems.access.identity.provider_sessions import refresh_provider_session

    now = datetime.now(UTC)
    key = Fernet.generate_key().decode("ascii")
    monkeypatch.setattr(
        "app.systems.access.identity.provider_sessions.get_settings",
        lambda: SimpleNamespace(supabase_session_encryption_key=SecretStr(key)),
    )
    user_id, provider_user_id, provider_session_id = uuid4(), uuid4(), uuid4()
    user = User(
        id=user_id,
        supabase_user_id=provider_user_id,
        email="person@example.test",
        username="person",
        status=UserStatus.ACTIVE.value,
        role=UserRole.MEMBER,
    )
    session = IdentitySession(
        id=uuid4(),
        user_id=user_id,
        provider_user_id=provider_user_id,
        provider_session_id=provider_session_id,
        provider_access_token_encrypted=Fernet(key).encrypt(b"expired-access").decode(),
        provider_refresh_token_encrypted=Fernet(key).encrypt(b"old-refresh").decode(),
        refresh_token_digest=__import__("hashlib").sha256(b"h" * 48).hexdigest(),
        csrf_token_digest=__import__("hashlib").sha256(b"c" * 48).hexdigest(),
        created_at=now,
        refreshed_at=now,
        expires_at=now + timedelta(days=1),
    )
    db = _session_database(user, session)
    db.commit.side_effect = [SQLAlchemyError("transient write failure"), None]
    client = Mock()
    client.verify_access_token.side_effect = [
        InvalidProviderToken("expired"),
        ProviderAccessIdentity(
            provider_user_id,
            provider_session_id,
            now,
            now + timedelta(minutes=10),
        ),
    ]
    client.refresh.return_value = ProviderTokens("new-access", "new-refresh", provider_user_id, 600)
    client.get_admin_user.return_value = ProviderUser(provider_user_id, None)

    with pytest.raises(SupabaseAuthUnavailable):
        refresh_provider_session(db, "h" * 48, client, csrf_token="c" * 48, now=now)

    assert session.revoked_at is not None
    assert db.commit.call_count == 2
    client.sign_out.assert_called_once_with("new-access")
