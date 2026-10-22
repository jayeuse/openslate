"""Realtime channel tokens: claims Realtime and the join policy read, and the route."""

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import jwt
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.systems.platform.realtime.tokens import mint_realtime_token
from tests.config_support import settings_values
from tests.route_app_support import route_app


def _settings() -> Settings:
    return Settings(**settings_values(), _env_file=None)


def _public_key(settings: Settings) -> jwt.PyJWK:
    private = json.loads(settings.realtime_token_signing_key.get_secret_value())
    return jwt.PyJWK({key: value for key, value in private.items() if key != "d"})


def test_token_carries_the_claims_realtime_and_the_join_policy_require() -> None:
    settings = _settings()
    user_id, org_id = uuid4(), uuid4()
    now = datetime(2026, 10, 17, 9, 30, 15, 987654, tzinfo=UTC)

    issued = mint_realtime_token(settings, user_id=user_id, org_id=org_id, now=now)

    header = jwt.get_unverified_header(issued.token)
    assert header["alg"] == "ES256"
    assert (
        header["kid"] == json.loads(settings.realtime_token_signing_key.get_secret_value())["kid"]
    )
    claims = jwt.decode(
        issued.token,
        _public_key(settings).key,
        algorithms=["ES256"],
        options={"verify_exp": False, "verify_iat": False},
    )
    issued_at = int(now.replace(microsecond=0).timestamp())
    assert claims == {
        "iss": "http://frontend.test/api/realtime",
        "sub": str(user_id),
        "role": "authenticated",
        "org_id": str(org_id),
        "purpose": "realtime",
        "iat": issued_at,
        "exp": issued_at + 300,
    }
    # No audience: a provider-session consumer must not mistake it for a GoTrue token.
    assert "aud" not in claims
    assert issued.expires_at == now.replace(microsecond=0) + timedelta(minutes=5)
    assert issued.topic_prefix == f"org:{org_id}:"


@pytest.mark.parametrize("headers", [{}, {"X-Org": str(uuid4())}])
def test_route_refuses_requests_without_a_session(headers: dict[str, str]) -> None:
    with TestClient(route_app()) as client:
        response = client.post("/api/realtime/token", headers=headers)

    assert response.status_code == 401
    assert "access_token" not in response.text
