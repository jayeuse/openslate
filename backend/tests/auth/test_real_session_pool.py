"""The real-session pool leases sessions whose tokens Auth issued ahead of this host's clock."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

import tests.fake_provider_support as fake_support
from app.core.integrations.supabase_auth import InvalidProviderToken
from tests.auth.provider_jwt_support import client_for_key, provider_settings, signed_access


def test_pool_leases_sessions_whose_iat_leads_the_host_clock(monkeypatch) -> None:
    # Auth runs in the Docker VM; its clock can lead this host. The pool reads session ids
    # without verification, so it leases even a token the verifier's allowance refuses.
    key = ec.generate_private_key(ec.SECP256R1())
    provider_id = uuid4()
    session_ids = [uuid4() for _ in range(fake_support.SESSIONS_PER_USER)]
    leading = datetime.now(UTC) + timedelta(seconds=10)
    tokens = [
        signed_access(key, user_id=str(provider_id), session_id=str(session_id),
                      extra={"iat": leading})
        for session_id in session_ids
    ]
    real = client_for_key(key)
    # The production verifier refuses these tokens: the case is real.
    with pytest.raises(InvalidProviderToken):
        real.verify_access_token(tokens[0])
    issued = iter(tokens)
    monkeypatch.setattr(
        real, "password_grant", lambda *_args: SimpleNamespace(access_token=next(issued))
    )
    monkeypatch.setattr(fake_support, "get_settings", provider_settings)
    monkeypatch.setattr(fake_support, "SupabaseAuthClient", lambda _settings: real)
    monkeypatch.setattr(
        fake_support.RealSessionPool,
        "_admin",
        lambda _self: httpx.Client(
            base_url="https://supabase.example.test/auth/v1/",
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(201, json={"id": str(provider_id)})
            ),
        ),
    )

    assert fake_support.RealSessionPool().user(0) == (provider_id, tuple(session_ids))
