from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

import app.core.security.supabase as jwt_security
from app.core.database import get_db
from app.main import create_app
from tests.rbac.support import make_role, make_user

ISSUER = "https://signed-test.local/auth/v1"
AUDIENCE = "authenticated"
PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
WRONG_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class SignedAuthHarness:
    def __init__(self, application: FastAPI, database: Mock) -> None:
        self.application = application
        self.database = database

    def token(
        self,
        user_id,
        *,
        key=PRIVATE_KEY,
        sub: object | None = None,
        include_sub: bool = True,
        **overrides: object,
    ) -> str:
        now = datetime.now(UTC)
        claims: dict[str, object] = {
            "sub": str(user_id),
            "iss": ISSUER,
            "aud": AUDIENCE,
            "exp": (now + timedelta(minutes=5)).timestamp(),
            "iat": now.timestamp(),
        }
        if not include_sub:
            claims.pop("sub")
        elif sub is not None:
            claims["sub"] = sub
        claims.update(overrides)
        return jwt.encode(claims, key, algorithm="RS256")


@pytest.fixture
def signed_auth(monkeypatch: pytest.MonkeyPatch) -> Generator[SignedAuthHarness, None, None]:
    application = create_app()
    database = Mock(spec=Session)
    application.dependency_overrides[get_db] = lambda: database

    def get_key(_token: str) -> SimpleNamespace:
        return SimpleNamespace(key=PRIVATE_KEY.public_key())

    def client_factory(_url: str) -> SimpleNamespace:
        return SimpleNamespace(get_signing_key_from_jwt=get_key)

    monkeypatch.setattr(jwt_security, "PyJWKClient", client_factory)
    monkeypatch.setattr(
        jwt_security,
        "get_settings",
        lambda: SimpleNamespace(
            supabase_jwks_url="https://signed-test.local/jwks",
            supabase_jwt_issuer=ISSUER,
            supabase_jwt_audience=AUDIENCE,
        ),
    )
    jwt_security._cached_jwks_client.cache_clear()
    try:
        yield SignedAuthHarness(application, database)
    finally:
        jwt_security._cached_jwks_client.cache_clear()
        application.dependency_overrides.clear()


def test_auth_me_requires_bearer_credentials(signed_auth: SignedAuthHarness) -> None:
    with TestClient(signed_auth.application) as client:
        missing = client.get("/api/auth/me")
        malformed = client.get(
            "/api/auth/me",
            headers={"Authorization": "Basic not-a-bearer-token"},
        )

    assert missing.status_code == 401
    assert malformed.status_code == 401


def test_auth_me_accepts_a_cryptographically_signed_established_token(
    signed_auth: SignedAuthHarness,
) -> None:
    user = make_user("signed-member", role=make_role("member"))
    signed_auth.database.scalar.return_value = user
    token = signed_auth.token(user.id)

    with TestClient(signed_auth.application) as client:
        response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json()["id"] == str(user.id)


@pytest.mark.parametrize(
    ("token_kwargs", "key"),
    [
        ({}, WRONG_PRIVATE_KEY),
        ({"iss": "https://wrong.example"}, PRIVATE_KEY),
        ({"aud": "wrong-audience"}, PRIVATE_KEY),
        ({"exp": (datetime.now(UTC) - timedelta(minutes=5)).timestamp()}, PRIVATE_KEY),
        ({"include_sub": False}, PRIVATE_KEY),
        ({"sub": "not-a-uuid"}, PRIVATE_KEY),
    ],
    ids=[
        "wrong-signature",
        "wrong-issuer",
        "wrong-audience",
        "expired",
        "missing-sub",
        "invalid-uuid",
    ],
)
def test_auth_me_rejects_invalid_signed_tokens(
    signed_auth: SignedAuthHarness,
    token_kwargs: dict[str, object],
    key: object,
) -> None:
    user = make_user("signed-member", role=make_role("member"))
    signed_auth.database.scalar.return_value = user
    token = signed_auth.token(user.id, key=key, **token_kwargs)

    with TestClient(signed_auth.application) as client:
        response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401


@pytest.mark.parametrize("state", ["pending", "unaccepted", "deleted"])
def test_valid_signed_token_still_requires_established_local_profile(
    signed_auth: SignedAuthHarness,
    state: str,
) -> None:
    user = make_user(
        f"signed-{state}",
        role=make_role("member"),
        status="pending" if state == "pending" else "active",
        deleted=state == "deleted",
    )
    if state == "unaccepted":
        user.invitation_sent_at = datetime.now(UTC) - timedelta(minutes=5)
    signed_auth.database.scalar.return_value = user
    token = signed_auth.token(user.id)

    with TestClient(signed_auth.application) as client:
        response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401


def test_auth_me_rejects_token_issued_before_the_local_cutoff(
    signed_auth: SignedAuthHarness,
) -> None:
    user = make_user("signed-revoked", role=make_role("member"))
    cutoff = datetime.now(UTC) - timedelta(minutes=5)
    user.tokens_valid_after = cutoff
    signed_auth.database.scalar.return_value = user
    token = signed_auth.token(user.id, iat=(cutoff - timedelta(seconds=1)).timestamp())

    with TestClient(signed_auth.application) as client:
        response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401
