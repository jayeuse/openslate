"""Real provider MFA lifecycle and application-session guarantees."""

import base64
import hashlib
import hmac
import struct
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from time import time
from uuid import UUID, uuid4

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.integrations.supabase_auth import get_supabase_auth_client
from app.core.integrations.supabase_mfa import SupabaseMfaClient
from app.main import create_app
from app.systems.access.identity import mfa as mfa_service
from app.systems.access.identity import provider_sessions
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.auth.test_provider_auth_integration import provider_account  # noqa: F401

pytestmark = pytest.mark.integration


def _totp(secret: str, offset: int = 0) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", int(time() + offset) // 30), hashlib.sha1).digest()
    index = digest[-1] & 15
    number = (struct.unpack(">I", digest[index : index + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{number:06d}"


def _mfa_session_state(owner, local_id, handle):
    with Session(owner) as db:
        session = db.scalar(
            select(IdentitySession).where(
                IdentitySession.user_id == local_id,
                IdentitySession.refresh_token_digest == hashlib.sha256(handle.encode()).hexdigest(),
            )
        )
        assert session is not None
        cipher = Fernet(get_settings().supabase_session_encryption_key.get_secret_value().encode())
        access = cipher.decrypt(session.provider_access_token_encrypted.encode()).decode()
        refresh = cipher.decrypt(session.provider_refresh_token_encrypted.encode())
        expiry = get_supabase_auth_client().verify_access_token(access).expires_at
        return (
            session.id,
            hashlib.sha256(access.encode()).hexdigest(),
            hashlib.sha256(refresh).hexdigest(),
            session.csrf_token_digest,
            expiry,
        )


def test_real_totp_cancellation_upgrade_refresh_and_concurrent_removal(
    provider_account,  # noqa: F811
    monkeypatch,
):
    email, password, provider_id, local_id, owner = provider_account
    settings = get_settings()
    app = create_app()
    browser = TestClient(app, base_url=settings.public_origin)
    browser.headers["Origin"] = settings.public_origin
    clients = [browser]
    seed = ""
    try:
        with Session(owner) as db:
            user = db.get(User, local_id)
            user.supabase_user_id = provider_id
            db.commit()
        assert (
            browser.post("/api/auth/login", json={"email": email, "password": password}).status_code
            == 200
        )
        initial = browser.get("/api/auth/mfa")
        assert initial.status_code == 200
        assert initial.json()["required"] is False and initial.json()["factors"] == []
        handle = browser.cookies.get("openslate_refresh")
        csrf = browser.cookies.get("openslate_csrf")
        browser.headers["X-CSRF-Token"] = csrf
        cancelled = browser.post("/api/auth/mfa/factors", json={"friendly_name": "Cancel me"})
        assert cancelled.status_code == 201
        cancelled_id = cancelled.json()["id"]
        assert (
            browser.delete(f"/api/auth/mfa/factors/{cancelled_id}?unverified_only=true").status_code
            == 204
        )
        assert browser.get("/api/auth/me").status_code == 200
        assert browser.cookies.get("openslate_refresh") == handle
        assert browser.cookies.get("openslate_csrf") == csrf
        enrollment = browser.post("/api/auth/mfa/factors", json={"friendly_name": "Authenticator"})
        assert enrollment.status_code == 201
        factor_id = enrollment.json()["id"]
        seed = enrollment.json()["totp"]["secret"]
        stale = TestClient(
            app, base_url=settings.public_origin, cookies=httpx.Cookies(browser.cookies)
        )
        stale.headers.update({"Origin": settings.public_origin, "X-CSRF-Token": csrf})
        clients.append(stale)
        assert stale.get("/api/auth/mfa").json()["factors"][0]["status"] == "unverified"
        assert (
            browser.post(
                f"/api/auth/mfa/factors/{factor_id}/verification", json={"code": "abc"}
            ).status_code
            == 422
        )
        assert (
            browser.post(
                f"/api/auth/mfa/factors/{uuid4()}/verification", json={"code": _totp(seed)}
            ).status_code
            == 404
        )
        valid_codes = {_totp(seed, offset) for offset in (-60, -30, 0, 30, 60)}
        invalid_code = next(
            f"{number:06d}" for number in range(10) if f"{number:06d}" not in valid_codes
        )
        assert (
            browser.post(
                f"/api/auth/mfa/factors/{factor_id}/verification", json={"code": invalid_code}
            ).status_code
            == 400
        )
        before = _mfa_session_state(owner, local_id, handle)
        verified = browser.post(
            f"/api/auth/mfa/factors/{factor_id}/verification", json={"code": _totp(seed)}
        )
        assert verified.status_code == 200
        assert verified.json() == {"verified": True, "access_token": None}
        assert all(
            header.startswith("openslate_access=")
            for header in verified.headers.get_list("set-cookie")
        )
        after = _mfa_session_state(owner, local_id, handle)
        assert after[0] == before[0] and after[3] == before[3]
        assert after[1] != before[1] and after[2] != before[2]
        event_count = (
            select(func.count())
            .select_from(SecurityEvent)
            .where(SecurityEvent.subject_id == local_id, SecurityEvent.source == "identity.mfa")
        )
        with Session(owner) as db:
            events_before = db.scalar(event_count)
        cleanup = f"/api/auth/mfa/factors/{factor_id}?unverified_only=true"
        for caller in (stale, browser):
            cancelled = caller.delete(cleanup)
            assert cancelled.status_code == 204
            assert cancelled.headers.get_list("set-cookie") == []
        assert stale.get("/api/auth/me").status_code == 403
        assert stale.delete(f"/api/auth/mfa/factors/{factor_id}").status_code == 403
        assert (
            stale.delete(f"/api/auth/mfa/factors/{uuid4()}?unverified_only=true").status_code == 404
        )
        assert _mfa_session_state(owner, local_id, handle) == after
        assert any(
            factor["id"] == factor_id and factor["status"] == "verified"
            for factor in browser.get("/api/auth/mfa").json()["factors"]
        )
        with Session(owner) as db:
            assert db.scalar(event_count) == events_before
        assert browser.get("/api/auth/me").status_code == 200
        with Session(owner) as db:
            profile = db.scalar(select(WorkspaceProfile))
            profile.mfa_require_admin = profile.mfa_require_member = profile.mfa_require_guest = (
                True
            )
            db.commit()
        get_supabase_auth_client().admin_delete_factor(provider_id, UUID(factor_id))
        missing = browser.get("/api/auth/mfa")
        assert missing.status_code == 200
        assert missing.json()["assurance_level"] == "aal2"
        assert missing.json()["required"] is True and missing.json()["factors"] == []
        denied = browser.get("/api/auth/session")
        assert denied.status_code == 403
        assert denied.json()["detail"]["code"] == "mfa_required"
        assert browser.get("/api/auth/me").status_code == 403
        enrollment = browser.post("/api/auth/mfa/factors", json={})
        assert enrollment.status_code == 201
        factor_id, seed = enrollment.json()["id"], enrollment.json()["totp"]["secret"]
        verification = f"/api/auth/mfa/factors/{factor_id}/verification"
        assert browser.post(verification, json={"code": _totp(seed)}).status_code == 200
        with Session(owner) as db:
            profile = db.scalar(select(WorkspaceProfile))
            profile.mfa_require_admin = profile.mfa_require_member = profile.mfa_require_guest = (
                False
            )
            db.commit()
        pending = TestClient(app, base_url=settings.public_origin)
        clients.append(pending)
        pending.headers["Origin"] = settings.public_origin
        assert (
            pending.post("/api/auth/login", json={"email": email, "password": password}).status_code
            == 200
        )
        assert pending.get("/api/auth/me").status_code == 403
        assert pending.get("/api/auth/session").json()["detail"]["code"] == "mfa_required"
        pending.headers["X-CSRF-Token"] = pending.cookies.get("openslate_csrf")
        pending_handle = pending.cookies.get("openslate_refresh")
        assert pending.post("/api/auth/refresh").status_code == 200
        assert pending.get("/api/auth/me").status_code == 403
        bearer = TestClient(app, base_url=settings.public_origin)
        clients.append(bearer)
        issued = bearer.post("/api/auth/token", json={"email": email, "password": password})
        assert issued.status_code == 200
        bearer.headers["Authorization"] = "Bearer " + issued.json()["access_token"]
        assert bearer.get("/api/auth/me").status_code == 403
        assert bearer.post("/api/auth/logout").status_code == 204
        assert (
            pending.post(
                f"/api/auth/mfa/factors/{factor_id}/verification", json={"code": _totp(seed)}
            ).status_code
            == 200
        )
        pending_state = _mfa_session_state(owner, local_id, pending_handle)
        with monkeypatch.context() as clock:
            clock.setattr(
                provider_sessions, "utc_now", lambda: pending_state[4] - timedelta(seconds=20)
            )
            assert pending.post("/api/auth/refresh").status_code == 200
        refreshed = _mfa_session_state(owner, local_id, pending_handle)
        assert refreshed[2] != pending_state[2] and refreshed[3] == pending_state[3]
        assert pending.get("/api/auth/me").status_code == 200
        entered, delete_entered, release = Event(), Event(), Event()
        verify_real = SupabaseMfaClient.challenge_and_verify
        delete_real = mfa_service.unenroll_factor

        def paused_verify(self, *args, **kwargs):
            entered.set()
            if not release.wait(10):
                pytest.fail("Verification barrier timed out", pytrace=False)
            return verify_real(self, *args, **kwargs)

        def entered_delete(*args, **kwargs):
            delete_entered.set()
            return delete_real(*args, **kwargs)

        duplicates = [
            TestClient(app, base_url=settings.public_origin, cookies=httpx.Cookies(pending.cookies))
            for _ in range(2)
        ]
        clients.extend(duplicates)
        for client in duplicates:
            client.headers.update(
                {
                    "Origin": settings.public_origin,
                    "X-CSRF-Token": pending.cookies.get("openslate_csrf"),
                }
            )
        with monkeypatch.context() as race:
            race.setattr(SupabaseMfaClient, "challenge_and_verify", paused_verify)
            race.setattr(mfa_service, "unenroll_factor", entered_delete)
            with ThreadPoolExecutor(max_workers=2) as pool:
                verification = pool.submit(
                    duplicates[0].post,
                    f"/api/auth/mfa/factors/{factor_id}/verification",
                    json={"code": _totp(seed)},
                )
                assert entered.wait(10), "Verification must reach the locked provider boundary"
                removal = pool.submit(
                    duplicates[1].delete,
                    f"/api/auth/mfa/factors/{factor_id}?unverified_only=true",
                )
                assert delete_entered.wait(10), "Concurrent removal must reach factor coordination"
                release.set()
                assert verification.result(timeout=30).status_code == 200
                assert removal.result(timeout=30).status_code == 204
        assert browser.get("/api/auth/me").status_code == 200
        assert pending.get("/api/auth/me").status_code == 200
        assert pending.delete(f"/api/auth/mfa/factors/{factor_id}").status_code == 204
        assert browser.get("/api/auth/me").status_code == 401
        assert pending.get("/api/auth/me").status_code == 401
        with Session(owner) as db:
            sessions = db.scalars(
                select(IdentitySession).where(IdentitySession.user_id == local_id)
            ).all()
            assert sessions and all(row.revoked_at is not None for row in sessions)
    finally:
        seed = ""
        for client in clients:
            client.close()
