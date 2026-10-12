"""Provider access-token verification and the JWKS key set, with generated ES256 keys.

Every token here is signed with a key generated for the test, and ``SupabaseAuthClient``
verifies it for real against a JWKS served over ``httpx.MockTransport``. The claim matrix
(issuer, audience, expiry, subject, session, assurance, foreign key) is owned by
``test_mfa.py::test_verified_provider_access_uses_exact_instance_session_and_assurance``;
this file owns the token size bound, the header refusals, zero leeway, the JWKS key filter
and the key cache timing.
"""

import base64
import json
import threading
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm

from app.core.integrations.supabase_auth import (
    InvalidProviderToken,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
)
from tests.auth.provider_jwt_support import provider_settings, signed_access

JWKS_PATH = "/auth/v1/.well-known/jwks.json"


def _jwk(key: ec.EllipticCurvePrivateKey, kid: str = "test-key", **labels: object) -> dict:
    jwk = ECAlgorithm.to_jwk(key.public_key(), as_dict=True)
    jwk.update({"kid": kid, "alg": "ES256", "use": "sig"})
    jwk.update(labels)
    return jwk


def _client(keys: list[object], seen: list[httpx.Request] | None = None) -> SupabaseAuthClient:
    def respond(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(200, json={"keys": keys})

    return SupabaseAuthClient(provider_settings(), transport=httpx.MockTransport(respond))


def _offline_client() -> SupabaseAuthClient:
    def respond(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("provider unavailable")

    return SupabaseAuthClient(provider_settings(), transport=httpx.MockTransport(respond))


def _token(key: ec.EllipticCurvePrivateKey, **options: object) -> str:
    return signed_access(key, user_id=str(uuid4()), session_id=str(uuid4()), **options)


def _b64(value: object) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _sized_token(key: ec.EllipticCurvePrivateKey, length: int) -> str:
    """A valid signed token of exactly ``length`` characters (padding claims are ignored)."""

    for header_pad in range(4):
        headers = {"kid": "test-key", "pad": "h" * header_pad}
        for size in range(length):
            token = jwt.encode(
                {
                    "sub": str(uuid4()),
                    "session_id": str(uuid4()),
                    "iss": "https://supabase.example.test/auth/v1",
                    "aud": "authenticated",
                    "iat": datetime.now(UTC),
                    "exp": datetime(2999, 1, 1, tzinfo=UTC),
                    "aal": "aal1",
                    "pad": "p" * size,
                },
                key,
                algorithm="ES256",
                headers=headers,
            )
            if len(token) >= length:
                if len(token) == length:
                    return token
                break
    raise AssertionError(f"no token of length {length}")


def test_the_token_size_bound_admits_16384_characters_and_refuses_one_more() -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    client = _client([_jwk(key)])

    largest = _sized_token(key, 16384)
    assert client.verify_access_token(largest).assurance_level == "aal1"
    with pytest.raises(InvalidProviderToken):
        client.verify_access_token(_sized_token(key, 16385))


@pytest.mark.parametrize(
    "header",
    [
        {"alg": "HS256", "kid": "test-key"},
        {"alg": "none", "kid": "test-key"},
        {"alg": "ES256", "kid": ""},
        {"alg": "ES256", "kid": 7},
        {"alg": "ES256"},
    ],
    ids=["hmac algorithm", "no algorithm", "empty kid", "non-string kid", "missing kid"],
)
def test_a_wrong_algorithm_or_key_id_is_refused_before_any_jwks_read(header: dict) -> None:
    # The provider is offline: a JWKS read would turn this 401 into a 503.
    payload = {"sub": str(uuid4()), "session_id": str(uuid4()), "aal": "aal1"}
    token = f"{_b64(header)}.{_b64(payload)}.{_b64('signature')}"

    with pytest.raises(InvalidProviderToken):
        _offline_client().verify_access_token(token)


def test_expiry_has_zero_leeway(monkeypatch: pytest.MonkeyPatch) -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    client = _client([_jwk(key)])
    # Minted before the clock is frozen at 1_900_000_000.5 (2030-03-17T17:46:40.5Z).
    expired_this_second = _token(
        key, expires_at=datetime.fromtimestamp(1_900_000_000, UTC), include_nbf=False
    )
    valid_next_second = _token(
        key, expires_at=datetime.fromtimestamp(1_900_000_001, UTC), include_nbf=False
    )

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromtimestamp(1_900_000_000.5, tz)

    monkeypatch.setattr(jwt.api_jwt, "datetime", FrozenDatetime)

    with pytest.raises(InvalidProviderToken):
        client.verify_access_token(expired_this_second)
    assert client.verify_access_token(valid_next_second).expires_at == datetime.fromtimestamp(
        1_900_000_001, UTC
    )


def test_a_boolean_issued_at_claim_is_refused() -> None:
    key = ec.generate_private_key(ec.SECP256R1())

    with pytest.raises(InvalidProviderToken):
        _client([_jwk(key)]).verify_access_token(_token(key, extra={"iat": True}))


@pytest.mark.parametrize(
    "labels",
    [{"kty": "RSA"}, {"crv": "P-384"}, {"alg": "ES384"}, {"use": "enc"}],
    ids=["not EC", "not P-256", "not ES256", "not a signing key"],
)
def test_only_ec_p256_es256_signing_keys_verify(labels: dict) -> None:
    # The token is signed by the listed key; only its labels disqualify it.
    key = ec.generate_private_key(ec.SECP256R1())

    with pytest.raises(InvalidProviderToken):
        _client([_jwk(key, **labels)]).verify_access_token(_token(key))


def test_a_signing_key_without_use_verifies_and_the_jwks_read_is_a_get() -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    jwk = _jwk(key)
    del jwk["use"]
    seen: list[httpx.Request] = []

    assert _client([jwk], seen).verify_access_token(_token(key)).assurance_level == "aal1"
    assert [(request.method, request.url.path) for request in seen] == [("GET", JWKS_PATH)]


def test_unusable_entries_are_skipped_and_later_keys_still_verify() -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    foreign = ec.generate_private_key(ec.SECP256R1())
    keys: list[object] = [
        7,
        _jwk(foreign, use="enc"),
        _jwk(foreign, kid="broken", x=123),
        _jwk(key),
    ]

    assert _client(keys).verify_access_token(_token(key)).assurance_level == "aal1"


def test_the_key_set_holds_at_most_16_entries() -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    sixteen: list[object] = [*range(15), _jwk(key)]
    seventeen: list[object] = [*range(16), _jwk(key)]

    assert _client(sixteen).verify_access_token(_token(key)).assurance_level == "aal1"
    with pytest.raises(SupabaseAuthUnavailable):
        _client(seventeen).verify_access_token(_token(key))


def test_a_key_set_without_a_key_list_is_an_outage() -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    client = SupabaseAuthClient(
        provider_settings(),
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"keys": None})),
    )

    with pytest.raises(SupabaseAuthUnavailable):
        client.verify_access_token(_token(key))


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    now = [100.0]
    monkeypatch.setattr("app.core.integrations.supabase_auth.time.monotonic", lambda: now[0])
    return now


def test_an_unknown_key_id_is_refetched_exactly_10_seconds_later(clock: list[float]) -> None:
    first = ec.generate_private_key(ec.SECP256R1())
    rotated = ec.generate_private_key(ec.SECP256R1())
    keys: list[object] = [_jwk(first, kid="first")]
    client = _client(keys)
    assert client.verify_access_token(_token(first, kid="first")).assurance_level == "aal1"

    keys.append(_jwk(rotated, kid="rotated"))
    clock[0] += 9.5
    with pytest.raises(InvalidProviderToken):
        client.verify_access_token(_token(rotated, kid="rotated"))
    clock[0] += 0.5
    assert client.verify_access_token(_token(rotated, kid="rotated")).assurance_level == "aal1"


def test_a_cached_key_expires_exactly_300_seconds_after_the_read(clock: list[float]) -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    keys: list[object] = [_jwk(key)]
    client = _client(keys)
    assert client.verify_access_token(_token(key)).assurance_level == "aal1"

    keys.clear()  # the provider retires the key
    clock[0] += 300
    with pytest.raises(InvalidProviderToken):
        client.verify_access_token(_token(key))


def test_a_failed_key_read_stays_an_outage_until_the_next_read(clock: list[float]) -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    client = _offline_client()

    with pytest.raises(SupabaseAuthUnavailable):
        client.verify_access_token(_token(key))
    clock[0] += 5
    with pytest.raises(SupabaseAuthUnavailable):
        client.verify_access_token(_token(key))


class _SignalingLock:
    """Wraps the fetch lock and reports when the second request starts to wait on it."""

    def __init__(self, waiting: threading.Event) -> None:
        self._lock = threading.Lock()
        self._waiting = waiting

    def __enter__(self) -> None:
        if threading.current_thread().name == "second":
            self._waiting.set()
        self._lock.acquire()

    def __exit__(self, *_exc: object) -> None:
        self._lock.release()


def test_a_request_that_waited_for_a_key_read_uses_the_keys_it_brought() -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    fetching, second_waiting = threading.Event(), threading.Event()

    def respond(_request: httpx.Request) -> httpx.Response:
        fetching.set()
        assert second_waiting.wait(timeout=30)  # hang guard, not a timing assertion
        return httpx.Response(200, json={"keys": [_jwk(key)]})

    client = SupabaseAuthClient(provider_settings(), transport=httpx.MockTransport(respond))
    client._jwks_fetch_lock = _SignalingLock(second_waiting)
    results: dict[str, object] = {}

    def verify(name: str) -> None:
        try:
            results[name] = client.verify_access_token(_token(key)).assurance_level
        except Exception as error:  # the assertion below reports the exception type
            results[name] = error

    first = threading.Thread(target=verify, args=("first",), name="first")
    first.start()
    assert fetching.wait(timeout=30)
    second = threading.Thread(target=verify, args=("second",), name="second")
    second.start()
    first.join(timeout=30)
    second.join(timeout=30)

    assert results == {"first": "aal1", "second": "aal1"}
