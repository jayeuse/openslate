import importlib
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from types import ModuleType, SimpleNamespace
from typing import Any, cast
from unittest.mock import Mock

import jwt
import pytest

SUPABASE_ISSUER = "https://project.supabase.co/auth/v1"
SUPABASE_AUDIENCE = "authenticated"
SUPABASE_JWKS_URL = f"{SUPABASE_ISSUER}/.well-known/jwks.json"
TOKEN = "supabase-jwt"


def _supabase_module() -> ModuleType:
    spec = importlib.util.find_spec("app.core.security.supabase")
    assert spec is not None, "Supabase JWT verifier module is not implemented"
    return importlib.import_module("app.core.security.supabase")


def _verifier() -> Callable[[str], dict[str, Any] | None]:
    verifier = getattr(_supabase_module(), "verify_supabase_jwt", None)
    assert callable(verifier), "verify_supabase_jwt is not implemented"
    return cast(Callable[[str], dict[str, Any] | None], verifier)


def _valid_claims() -> dict[str, Any]:
    return {
        "sub": "00000000-0000-0000-0000-000000000001",
        "iss": SUPABASE_ISSUER,
        "aud": SUPABASE_AUDIENCE,
        "exp": datetime.now(UTC) + timedelta(minutes=5),
    }


def _mock_jwks_and_decode(
    monkeypatch: pytest.MonkeyPatch,
    *,
    decoded: dict[str, Any] | None = None,
    decode_error: Exception | None = None,
) -> tuple[Mock, Mock]:
    module = _supabase_module()
    client = Mock()
    client.get_signing_key_from_jwt.return_value = SimpleNamespace(key="mock-public-key")
    client_factory = Mock(return_value=client)
    decode = Mock(
        side_effect=decode_error
        if decode_error is not None
        else lambda *_args, **_kwargs: decoded,
    )

    monkeypatch.setattr(module, "PyJWKClient", client_factory, raising=False)
    monkeypatch.setattr(module, "decode", decode, raising=False)
    jwt_module = getattr(module, "jwt", None)
    if jwt_module is not None:
        monkeypatch.setattr(jwt_module, "PyJWKClient", client_factory, raising=False)
        monkeypatch.setattr(jwt_module, "decode", decode, raising=False)
    monkeypatch.setattr(module, "SUPABASE_JWKS_URL", SUPABASE_JWKS_URL, raising=False)
    monkeypatch.setattr(module, "SUPABASE_ISSUER", SUPABASE_ISSUER, raising=False)
    monkeypatch.setattr(module, "SUPABASE_AUDIENCE", SUPABASE_AUDIENCE, raising=False)
    return client, decode


def test_supabase_jwt_verification_uses_mocked_jwks_and_strict_claims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    claims = _valid_claims()
    client, decode = _mock_jwks_and_decode(monkeypatch, decoded=claims)

    assert _verifier()(TOKEN) == claims

    client.get_signing_key_from_jwt.assert_called_once_with(TOKEN)
    decode.assert_called_once_with(
        TOKEN,
        "mock-public-key",
        algorithms=["ES256", "RS256"],
        issuer=SUPABASE_ISSUER,
        audience=SUPABASE_AUDIENCE,
    )


@pytest.mark.parametrize(
    ("claim_error", "case"),
    [
        (jwt.InvalidIssuerError("bad issuer"), "issuer"),
        (jwt.InvalidAudienceError("bad audience"), "audience"),
        (jwt.InvalidAlgorithmError("bad algorithm"), "algorithm"),
        (jwt.ExpiredSignatureError("expired"), "expiry"),
    ],
)
def test_supabase_jwt_verification_rejects_invalid_signature_claims(
    monkeypatch: pytest.MonkeyPatch,
    claim_error: Exception,
    case: str,
) -> None:
    _mock_jwks_and_decode(monkeypatch, decode_error=claim_error)

    assert _verifier()(TOKEN) is None, case


@pytest.mark.parametrize(
    "bad_subject",
    [None, "", "not-a-uuid"],
)
def test_supabase_jwt_verification_rejects_bad_subject(
    monkeypatch: pytest.MonkeyPatch,
    bad_subject: Any,
) -> None:
    claims = _valid_claims()
    claims["sub"] = bad_subject
    _mock_jwks_and_decode(monkeypatch, decoded=claims)

    assert _verifier()(TOKEN) is None


@pytest.mark.parametrize("missing_claim", ["sub", "iss", "aud", "exp"])
def test_supabase_jwt_verification_rejects_missing_required_claims(
    monkeypatch: pytest.MonkeyPatch,
    missing_claim: str,
) -> None:
    claims = _valid_claims()
    del claims[missing_claim]
    _mock_jwks_and_decode(monkeypatch, decoded=claims)

    assert _verifier()(TOKEN) is None


def test_supabase_jwt_verification_rejects_an_algorithm_outside_the_allowlist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_jwks_and_decode(
        monkeypatch,
        decode_error=jwt.InvalidAlgorithmError("HS256 is not allowed"),
    )

    assert _verifier()(TOKEN) is None
