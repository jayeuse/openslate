"""Real Supabase refresh-token replay and backend liveness acceptance."""

import json
import os
import re
import subprocess
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from threading import Event
from time import monotonic
from uuid import UUID

import pytest
from cryptography.fernet import Fernet, InvalidToken
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    InvalidProviderToken,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User

pytest_plugins = ("tests.auth.provider_account_support",)
pytestmark = pytest.mark.integration

_EXPECTED_REUSE_INTERVAL_SECONDS = 10
_REUSE_WAIT_MARGIN_SECONDS = 0.25
_REUSE_WAIT_DEADLINE_MARGIN_SECONDS = 2
_MAX_PROVIDER_JWT_WAIT_SECONDS = 60


def _fingerprint(value: str | bytes) -> str:
    raw = value.encode("utf-8") if isinstance(value, str) else value
    return sha256(raw).hexdigest()


def _auth_replay_settings() -> tuple[int, bool, int, bool]:
    """Read only the relevant non-secret settings from this runner-owned Auth container."""
    try:
        manifest_path = Path(os.environ["OPENSLATE_TEST_DATABASE_MANIFEST"])
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        auth_id = manifest["ownership"]["service_ids"]["auth"]
    except (OSError, KeyError, TypeError, ValueError):
        pytest.fail("Owned Supabase Auth runtime manifest is unavailable", pytrace=False)
    if not isinstance(auth_id, str) or re.fullmatch(r"[a-f0-9]{12,64}", auth_id) is None:
        pytest.fail("Owned Supabase Auth container identity is invalid", pytrace=False)

    try:
        inspected = subprocess.run(
            ["docker", "inspect", auth_id, "--format", "{{json .Config.Env}}"],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        pytest.fail("Owned Supabase Auth configuration could not be inspected", pytrace=False)
    if inspected.returncode != 0:
        pytest.fail("Owned Supabase Auth configuration could not be inspected", pytrace=False)
    try:
        entries = json.loads(inspected.stdout)
        variables = dict(entry.split("=", 1) for entry in entries if "=" in entry)
        reuse_interval = int(variables["GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL"])
        rotation_enabled = variables["GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED"].lower()
        algorithm_version = int(variables["GOTRUE_SECURITY_REFRESH_TOKEN_ALGORITHM_VERSION"])
        allow_reuse = variables["GOTRUE_SECURITY_REFRESH_TOKEN_ALLOW_REUSE"].lower()
    except (KeyError, TypeError, ValueError):
        pytest.fail(
            "Owned Supabase Auth must expose explicit refresh rotation settings", pytrace=False
        )
    if rotation_enabled not in {"true", "false"} or allow_reuse not in {"true", "false"}:
        pytest.fail("Owned Supabase Auth rotation setting is invalid", pytrace=False)
    return reuse_interval, rotation_enabled == "true", algorithm_version, allow_reuse == "true"


def _owned_session_and_provider_refresh(
    owner: Engine, local_user_id: UUID, settings
) -> tuple[UUID, UUID, UUID, str]:
    with Session(owner) as db:
        sessions = db.scalars(
            select(IdentitySession).where(IdentitySession.user_id == local_user_id)
        ).all()
        if len(sessions) != 1:
            pytest.fail("Expected exactly one fixture-owned identity session", pytrace=False)
        session = sessions[0]
        encrypted_refresh = session.provider_refresh_token_encrypted
        if not encrypted_refresh:
            pytest.fail("Fixture-owned identity session has no encrypted provider credential")
        encryption_key = settings.supabase_session_encryption_key.get_secret_value()
        try:
            refresh_token = Fernet(encryption_key.encode("ascii")).decrypt(
                encrypted_refresh.encode("ascii")
            )
        except InvalidToken:
            pytest.fail("Fixture-owned provider credential could not be decrypted", pytrace=False)
        if session.provider_user_id is None or session.provider_session_id is None:
            pytest.fail("Fixture-owned identity session has no provider binding", pytrace=False)
        return (
            session.id,
            session.provider_user_id,
            session.provider_session_id,
            refresh_token.decode("utf-8"),
        )


def _wait_past_reuse_interval(first_rotation_completed: float, interval: int) -> None:
    target = first_rotation_completed + interval + _REUSE_WAIT_MARGIN_SECONDS
    deadline = first_rotation_completed + interval + _REUSE_WAIT_DEADLINE_MARGIN_SECONDS
    wake = Event()
    while True:
        remaining = target - monotonic()
        if remaining <= 0:
            return
        budget = deadline - monotonic()
        if budget <= 0:
            pytest.fail(
                "Refresh replay grace period did not elapse within its bound", pytrace=False
            )
        wake.wait(min(remaining, budget))


def _provider_jwt_expiry(auth, access_token: str) -> datetime:
    try:
        claims = auth.verify_access_token(access_token)
    except (InvalidProviderToken, SupabaseAuthUnavailable):
        pytest.fail(
            "Original provider JWT expired or failed cryptographic validation", pytrace=False
        )
    remaining = (claims.expires_at - datetime.now(UTC)).total_seconds()
    assert remaining > 0, "Original provider JWT must still be within its signed lifetime"
    assert remaining <= _MAX_PROVIDER_JWT_WAIT_SECONDS, (
        "Disposable Auth JWT lifetime exceeds the bounded replay acceptance window"
    )
    return claims.expires_at


def _wait_for_provider_jwt_expiry(expiry: datetime) -> None:
    deadline = monotonic() + _MAX_PROVIDER_JWT_WAIT_SECONDS
    wake = Event()
    while True:
        remaining = (expiry - datetime.now(UTC)).total_seconds()
        if remaining < 0:
            return
        budget = deadline - monotonic()
        if budget <= 0:
            pytest.fail(
                "Provider access JWT did not expire within its bounded lifetime", pytrace=False
            )
        wake.wait(min(remaining + 0.01, budget))


def _provider_refresh_is_rejected(auth, refresh_token: str) -> bool:
    try:
        auth.refresh(refresh_token)
    except InvalidProviderCredentials:
        return True
    return False


def test_old_provider_refresh_replay_revokes_auth_session_and_local_handle_cannot_restore(
    provider_account,
):
    email, password, provider_id, local_id, owner = provider_account
    settings = get_settings()
    interval, rotation_enabled, algorithm_version, allow_reuse = _auth_replay_settings()
    assert rotation_enabled, "The owned Auth stack must enable refresh-token rotation"
    assert algorithm_version == 2, "The owned Auth stack must issue counter-based refresh tokens"
    assert not allow_reuse, "The owned Auth stack must reject refresh-token replay"
    assert interval == _EXPECTED_REUSE_INTERVAL_SECONDS, (
        "The owned Auth stack must use the documented 10-second refresh reuse interval"
    )

    app = create_app()
    browser = TestClient(app, base_url=settings.public_origin)
    browser.headers["Origin"] = settings.public_origin
    try:
        with Session(owner) as db:
            user = db.get(User, local_id)
            assert user is not None, "Fixture-owned local profile was not created"
            assert user.supabase_user_id is None, "Fixture profile must begin unbound"
            user.supabase_user_id = provider_id
            db.commit()

        login = browser.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200, "Real Supabase email login must succeed"
        original_access = browser.cookies.get("openslate_access")
        original_csrf = browser.cookies.get("openslate_csrf")
        assert original_access is not None, "Provider login must set its browser access cookie"
        assert original_csrf is not None, "Provider login must set the browser CSRF cookie"

        app_session_id, session_provider_id, provider_session_id, original_refresh = (
            _owned_session_and_provider_refresh(owner, local_id, settings)
        )
        assert session_provider_id == provider_id, (
            "Fixture identity session must bind to the provisioned provider user"
        )
        original_refresh_fingerprint = _fingerprint(original_refresh)
        assert len(original_refresh) > 12, "The provider must issue a counter-based refresh token"

        auth = get_supabase_auth_client()
        try:
            first = auth.refresh(original_refresh)
        except (InvalidProviderCredentials, SupabaseAuthUnavailable):
            pytest.fail("Real Supabase Auth did not rotate the fixture refresh credential")
        first_claims = auth.verify_access_token(first.access_token)
        assert first.user_id == provider_id and first_claims.user_id == provider_id, (
            "First provider refresh must preserve the fixture user identity"
        )
        assert first_claims.session_id == provider_session_id, (
            "First provider refresh must preserve the provider session identity"
        )
        first_refresh_fingerprint = _fingerprint(first.refresh_token)
        assert first_refresh_fingerprint != original_refresh_fingerprint, (
            "First real provider refresh must rotate its refresh credential"
        )

        try:
            second = auth.refresh(first.refresh_token)
        except (InvalidProviderCredentials, SupabaseAuthUnavailable):
            pytest.fail("Second real Supabase Auth rotation did not advance the provider chain")
        second_rotation_completed = monotonic()
        second_claims = auth.verify_access_token(second.access_token)
        assert second.user_id == provider_id and second_claims.user_id == provider_id, (
            "Second provider refresh must preserve the fixture user identity"
        )
        assert second_claims.session_id == provider_session_id, (
            "Second provider refresh must preserve the provider session identity"
        )
        second_refresh_fingerprint = _fingerprint(second.refresh_token)
        assert second_refresh_fingerprint != first_refresh_fingerprint, (
            "Second real provider refresh must advance to a new credential"
        )
        assert second_refresh_fingerprint != original_refresh_fingerprint, (
            "The original credential must be an ancestor of the newest provider token"
        )

        assert browser.get("/api/auth/me").status_code == 200, (
            "Original JWT must remain admitted before the provider detects replay"
        )
        _wait_past_reuse_interval(second_rotation_completed, interval)

        replay_rejected = _provider_refresh_is_rejected(auth, original_refresh)
        assert replay_rejected, (
            "Supabase Auth must reject the grandparent refresh credential after its reuse window"
        )
        newest_rejected = _provider_refresh_is_rejected(auth, second.refresh_token)
        assert newest_rejected, "Replay detection must invalidate the newest provider descendant"

        original_expiry = _provider_jwt_expiry(auth, original_access)
        assert browser.get("/api/auth/me").status_code == 401, (
            "FastAPI must deny an unexpired JWT after Supabase removes its live session"
        )
        with Session(owner) as db:
            local_session = db.get(IdentitySession, app_session_id)
            assert local_session is not None and local_session.revoked_at is None, (
                "Provider replay detection must not depend on an application-side revocation"
            )
            assert local_session.provider_user_id == provider_id, (
                "Application session must retain its original provider binding"
            )

        _wait_for_provider_jwt_expiry(original_expiry)
        refresh = browser.post("/api/auth/refresh", headers={"X-CSRF-Token": original_csrf})
        assert refresh.status_code == 401, (
            "The opaque application refresh handle must not restore a revoked provider session"
        )
        assert browser.get("/api/auth/me").status_code == 401, (
            "Rejected local refresh must not restore browser access"
        )
        with Session(owner) as db:
            persisted = db.get(IdentitySession, app_session_id)
            assert persisted is not None and persisted.revoked_at is not None, (
                "Provider exchange failure must revoke the application session"
            )
    finally:
        browser.close()
