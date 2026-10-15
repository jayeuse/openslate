"""Generated ES256 provider tokens, a JWKS peer and a session-row fake for Auth unit tests.

The keys are generated per test; no test reads a real provider key. ``client_for_key``
serves the public key as JWKS (and one admin user read) over ``httpx.MockTransport``.
"""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm
from pydantic import SecretStr
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentityMfaObservation, IdentitySession
from app.systems.access.users.models import Membership, User


def provider_settings() -> SimpleNamespace:
    return SimpleNamespace(
        supabase_url="https://supabase.example.test",
        supabase_auth_issuer="https://supabase.example.test/auth/v1",
        supabase_auth_audience="authenticated",
        supabase_publishable_key=SecretStr("sb_publishable_test"),
        supabase_secret_key=SecretStr("sb_secret_test"),
        supabase_timeout_seconds=2,
    )


def signed_access(
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


def client_for_key(private_key: ec.EllipticCurvePrivateKey, *, user_id=None, factors=None):
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

    return SupabaseAuthClient(provider_settings(), transport=httpx.MockTransport(respond))


def session_database(user: User, membership: Membership, session: IdentitySession) -> Mock:
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
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]
    db.scalar.side_effect = lambda query: rows[query.column_descriptions[0]["expr"]]

    def get(model, identifier, **_kwargs):
        row = rows[model]
        key = "user_id" if model is IdentityMfaObservation else "id"
        return row if getattr(row, key) == identifier else None

    db.get.side_effect = get
    db.execute.return_value.scalar_one.return_value = True
    return db
