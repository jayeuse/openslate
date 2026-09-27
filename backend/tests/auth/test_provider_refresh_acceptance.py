"""Real-provider acceptance for expiry-driven concurrent session refresh."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from threading import Barrier, Event
from time import monotonic, time
from uuid import UUID

import httpx
import jwt
import pytest
from cryptography.fernet import Fernet, InvalidToken
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.config.settings import Settings
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User

pytest_plugins = ("tests.auth.test_provider_auth_integration",)
pytestmark = pytest.mark.integration

_MAX_PROVIDER_JWT_WAIT_SECONDS = 90


def _cookie_has_flag(headers: list[str], name: str, flag: str) -> bool:
    for header in headers:
        cookie_name, separator, attributes = header.partition(";")
        if separator and cookie_name.startswith(f"{name}="):
            if flag.casefold() in {item.strip().casefold() for item in attributes.split(";")}:
                return True
    return False


def _cookie_was_set(headers: list[str], name: str) -> bool:
    return any(header.partition(";")[0].startswith(f"{name}=") for header in headers)


def _token_fingerprint(value: str | bytes) -> str:
    encoded = value.encode("utf-8") if isinstance(value, str) else value
    return sha256(encoded).hexdigest()


def _provider_jwt_expiry(access_token: str) -> int:
    """Read only exp for bounded waiting; authentication still verifies signatures."""
    try:
        claims = jwt.decode(
            access_token,
            options={"verify_signature": False, "verify_exp": False, "verify_aud": False},
        )
        expiry = claims.get("exp")
    except jwt.PyJWTError:
        pytest.fail("Provider access JWT did not expose a readable expiry claim", pytrace=False)
    if type(expiry) is not int:
        pytest.fail("Provider access JWT expiry claim was not an integer", pytrace=False)
    return expiry


def _wait_for_provider_expiry(expiry: int) -> None:
    remaining = expiry - time()
    if remaining <= 0:
        return
    if remaining > _MAX_PROVIDER_JWT_WAIT_SECONDS:
        pytest.fail(
            "Disposable Supabase Auth JWT lifetime exceeds 90 seconds; "
            "start the acceptance stack with JWT_EXPIRY=60",
            pytrace=False,
        )

    deadline = monotonic() + _MAX_PROVIDER_JWT_WAIT_SECONDS
    wake = Event()
    while True:
        remaining = expiry - time()
        if remaining < 0:
            return
        budget = deadline - monotonic()
        if budget <= 0:
            pytest.fail("Provider access JWT did not expire within 90 seconds", pytrace=False)
        wake.wait(min(remaining + 0.01, budget))


def _owned_session_state(owner: Engine, local_user_id: UUID, settings: Settings):
    with Session(owner) as db:
        sessions = db.scalars(
            select(IdentitySession).where(IdentitySession.user_id == local_user_id)
        ).all()
        if len(sessions) != 1:
            pytest.fail("Expected exactly one owned application identity session", pytrace=False)
        session = sessions[0]
        encrypted_refresh = session.provider_refresh_token_encrypted
        if not encrypted_refresh:
            pytest.fail("Owned identity session did not retain its encrypted provider credential")
        secret = settings.supabase_session_encryption_key.get_secret_value()
        try:
            provider_refresh = Fernet(secret.encode("ascii")).decrypt(
                encrypted_refresh.encode("ascii")
            )
        except InvalidToken:
            pytest.fail("Owned identity session provider credential could not be decrypted")
        return (
            session.id,
            session.provider_user_id,
            session.provider_session_id,
            session.refreshed_at,
            session.revoked_at,
            _token_fingerprint(provider_refresh),
        )


def _refresh_after_barrier(client: TestClient, barrier: Barrier, csrf: str):
    barrier.wait(timeout=15)
    return client.post("/api/auth/refresh", headers={"X-CSRF-Token": csrf})


def test_expired_provider_access_refreshes_concurrently_and_preserves_revocation(
    provider_account,
):
    email, password, provider_id, local_id, owner = provider_account
    settings = get_settings()
    app = create_app()
    login_client = TestClient(app, base_url=settings.public_origin)
    clients: list[TestClient] = [login_client]
    login_client.headers["Origin"] = settings.public_origin
    try:
        with Session(owner) as db:
            user = db.get(User, local_id)
            assert user is not None, "Owned local profile was not created"
            assert user.supabase_user_id is None, "Fixture profile must begin unbound"
            user.supabase_user_id = provider_id
            db.commit()

        login = login_client.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200, "Real Supabase email login must succeed"
        login_headers = login.headers.get_list("set-cookie")
        assert _cookie_has_flag(login_headers, "openslate_access", "httponly"), (
            "Browser access cookie must remain HttpOnly"
        )
        assert _cookie_has_flag(login_headers, "openslate_refresh", "httponly"), (
            "Browser refresh cookie must remain HttpOnly"
        )
        assert _cookie_was_set(login_headers, "openslate_csrf"), (
            "Browser login must set the separate CSRF cookie"
        )
        assert not _cookie_has_flag(login_headers, "openslate_csrf", "httponly"), (
            "Browser JavaScript must be able to read the CSRF cookie"
        )

        original_access = login_client.cookies.get("openslate_access")
        original_csrf = login_client.cookies.get("openslate_csrf")
        assert original_access is not None, "Provider login must set an access cookie"
        assert original_csrf is not None, "Provider login must set a CSRF cookie"
        original_csrf_fingerprint = _token_fingerprint(original_csrf)
        original_access_fingerprint = _token_fingerprint(original_access)
        expiry = _provider_jwt_expiry(original_access)
        _wait_for_provider_expiry(expiry)

        expired_me = login_client.get(
            "/api/auth/me",
            headers={"Cookie": f"openslate_access={original_access}"},
        )
        assert expired_me.status_code == 401, (
            "The provider-issued access JWT must be rejected after its exp claim"
        )

        before = _owned_session_state(owner, local_id, settings)
        (
            session_id,
            before_provider_id,
            before_provider_session_id,
            before_refreshed_at,
            revoked_at,
            before_refresh_fingerprint,
        ) = before
        assert session_id is not None and before_provider_id == provider_id, (
            "Owned local session must remain bound to the fixture's provider user"
        )
        assert before_provider_session_id is not None, (
            "Owned local session must retain the provider session identity"
        )
        assert revoked_at is None, "Owned local session must still be active before refresh"

        seed_cookies = httpx.Cookies(login_client.cookies)
        refresh_clients = [
            TestClient(app, base_url=settings.public_origin, cookies=httpx.Cookies(seed_cookies))
            for _ in range(2)
        ]
        clients.extend(refresh_clients)
        for client in refresh_clients:
            client.headers["Origin"] = settings.public_origin

        missing_csrf = refresh_clients[0].post("/api/auth/refresh")
        assert missing_csrf.status_code == 401, (
            "Refresh must reject a browser request without its CSRF header"
        )

        barrier = Barrier(2)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(_refresh_after_barrier, client, barrier, original_csrf)
                for client in refresh_clients
            ]
            refreshed = [future.result(timeout=45) for future in futures]

        assert all(response.status_code == 200 for response in refreshed), (
            "Both simultaneous real-provider refresh requests must succeed"
        )
        for response in refreshed:
            response_headers = response.headers.get_list("set-cookie")
            assert _cookie_has_flag(response_headers, "openslate_access", "httponly"), (
                "Refreshed access cookie must remain HttpOnly"
            )
            assert _cookie_has_flag(response_headers, "openslate_refresh", "httponly"), (
                "Refreshed application session cookie must remain HttpOnly"
            )
            assert _cookie_was_set(response_headers, "openslate_csrf"), (
                "Refreshed browser session must retain its CSRF cookie"
            )

        refreshed_accesses = [client.cookies.get("openslate_access") for client in refresh_clients]
        assert all(token is not None for token in refreshed_accesses), (
            "Each successful refresh must set a provider access cookie"
        )
        refreshed_access_fingerprints = [
            _token_fingerprint(token) for token in refreshed_accesses if token is not None
        ]
        assert all(
            fingerprint != original_access_fingerprint
            for fingerprint in refreshed_access_fingerprints
        ), "Expired access must be replaced with a newly issued provider JWT"
        for client in refresh_clients:
            csrf_after = client.cookies.get("openslate_csrf")
            assert csrf_after is not None, "Refreshed browser session lost its CSRF cookie"
            assert _token_fingerprint(csrf_after) == original_csrf_fingerprint, (
                "Refresh must preserve the session-bound CSRF value"
            )
            profile = client.get("/api/auth/me")
            assert profile.status_code == 200, (
                "A refreshed provider JWT must admit its explicitly bound local profile"
            )
            assert profile.json().get("id") == str(local_id), (
                "Provider refresh must resolve to the same local user"
            )

        after = _owned_session_state(owner, local_id, settings)
        (
            after_session_id,
            after_provider_id,
            after_provider_session_id,
            after_refreshed_at,
            after_revoked_at,
            after_refresh_fingerprint,
        ) = after
        assert after_session_id == session_id, "Refresh must keep the application session identity"
        assert after_provider_id == before_provider_id == provider_id, (
            "Refresh must preserve the provider user binding"
        )
        assert after_provider_session_id == before_provider_session_id, (
            "Refresh must preserve the provider session identity"
        )
        assert after_refreshed_at > before_refreshed_at, (
            "Successful provider rotation must update the persisted refresh time"
        )
        assert after_refresh_fingerprint != before_refresh_fingerprint, (
            "The encrypted provider refresh credential must rotate after expiry"
        )
        assert after_revoked_at is None, "Successful refresh must leave the session active"

        sessions = refresh_clients[0].get("/api/auth/sessions")
        assert sessions.status_code == 200, "Refreshed session must remain manageable"
        current = [item for item in sessions.json() if item["current"]]
        assert len(current) == 1, "Refresh requests must resolve to one current app session"
        revoked = refresh_clients[0].delete(
            f"/api/auth/sessions/{current[0]['id']}",
            headers={"X-CSRF-Token": original_csrf},
        )
        assert revoked.status_code == 204, "The refreshed application session must be revocable"
        assert refresh_clients[1].get("/api/auth/me").status_code == 401, (
            "A provider JWT from a revoked application session must be denied"
        )

        with Session(owner) as db:
            persisted = db.get(IdentitySession, session_id)
            assert persisted is not None and persisted.revoked_at is not None, (
                "Application revocation must persist for the rotated provider session"
            )
    finally:
        for client in clients:
            client.close()
