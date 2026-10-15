"""Real route admission and committed-state proof across provider latency."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEvent
from tests.access.user_security_support import open_security_world
from tests.fake_provider_support import fake_provider as fake_provider
from tests.fake_provider_support import owned_account

pytestmark = pytest.mark.integration


@pytest.fixture
def provider_account(fake_provider):
    yield from owned_account(fake_provider)


@pytest.fixture
def world(provider_account, monkeypatch):
    yield from open_security_world(provider_account, monkeypatch)


def post(world, action="recovery", body=None, *, self_target=False, aal="aal2"):
    target = world.actor_id if self_target else world.target_id
    return world.client.post(
        f"/api/users/{target}/{action}",
        headers=world.headers(aal),
        json={} if body is None else body,
    )


def test_revoke_first_recovery_is_committed_before_email(world):
    observed = []

    def during_mail(request):
        if request.url.path.endswith("/recover"):
            observed.extend(session.revoked_at for session in world.sessions())
            assert world.events()[0].outcome == "attempt"
        return None

    world.hook = during_mail
    response = post(world, body={"revoke_sessions": True})
    assert response.status_code == 200, response.text
    assert observed and all(value is not None for value in observed)
    assert response.json()["local_revocation"] == "committed"
    assert response.json()["revoked_sessions"] == 1
    with Session(world.owner) as db:
        assert db.get(User, world.target_id).tokens_valid_after is not None


@pytest.mark.parametrize("stage", ["attempt", "final"])
def test_event_commit_failure_never_claims_complete_or_replays_mail(world, monkeypatch, stage):
    original = AuditSession.commit

    def fail(db):
        desired = "attempt" if stage == "attempt" else "success"
        if any(isinstance(row, SecurityEvent) and row.outcome == desired for row in db.new):
            raise OperationalError("owned fault", None, Exception("Private persistence detail"))
        return original(db)

    monkeypatch.setattr(AuditSession, "commit", fail)
    response = post(world)
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["email_request"] == ("not_attempted" if stage == "attempt" else "accepted")
    assert sum(path.endswith("/recover") for _, path in world.calls) == (
        0 if stage == "attempt" else 1
    )
    assert "Private persistence detail" not in response.text
    assert all(session.revoked_at is None for session in world.sessions())


@pytest.mark.parametrize("change", ["role", "session", "disabled", "binding"])
def test_reset_attempt_requires_cleanup_even_after_authority_loss(world, change):
    world.factors.append({"id": str(uuid4()), "factor_type": "totp", "status": "verified"})
    changed = []

    def during_delete(request):
        if request.method == "DELETE" and not changed:
            changed.append(True)
            with Session(world.owner) as db:
                if change == "role":
                    db.get(User, world.actor_id).role = "member"
                elif change == "session":
                    db.get(IdentitySession, world.session_id).revoked_at = datetime.now(UTC)
                elif change == "disabled":
                    db.get(User, world.target_id).status = "disabled"
                else:
                    db.get(User, world.target_id).supabase_user_id = uuid4()
                db.commit()
        return None

    world.hook = during_delete
    response = post(world, "mfa/reset")
    assert response.status_code == 503
    assert len([call for call in world.calls if call[0] == "DELETE"]) == 1
    detail = response.json()["detail"]
    if change == "binding":
        assert detail["local_revocation"] == "unconfirmed"
        assert all(session.revoked_at is None for session in world.sessions())
    else:
        assert detail["local_revocation"] == "committed"
        assert all(session.revoked_at is not None for session in world.sessions())
    assert world.events()[-1].outcome == "partial"


@pytest.mark.parametrize("failure", ["malformed_delete", "remaining", "late_session"])
def test_reset_confirms_inventory_and_sweeps_late_sessions(world, failure):
    inventories = []

    def during_provider(request):
        if request.method == "DELETE" and failure == "malformed_delete":
            world.factors.clear()
            return httpx.Response(200, json={"id": str(uuid4())})
        if request.url.path.endswith("/factors"):
            inventories.append(True)
            if len(inventories) == 2:
                if failure == "remaining":
                    return httpx.Response(200, json=[{"id": str(uuid4())}])
                if failure == "late_session":
                    with Session(world.owner) as db:
                        db.add(
                            IdentitySession(
                                user_id=world.target_id,
                                provider_user_id=world.target_provider_id,
                                provider_session_id=uuid4(),
                                refresh_token_digest=uuid4().hex * 2,
                                csrf_token_digest=uuid4().hex * 2,
                                expires_at=datetime.now(UTC) + timedelta(days=1),
                            )
                        )
                        db.commit()
        return None

    world.hook = during_provider
    response = post(world, "mfa/reset")
    assert response.status_code == (200 if failure == "late_session" else 503)
    assert all(session.revoked_at is not None for session in world.sessions())
    if failure == "late_session":
        assert response.json()["revoked_sessions"] == 2
    else:
        assert response.json()["detail"]["local_revocation"] == "committed"
        assert world.events()[-1].outcome == "partial"


@pytest.mark.parametrize("action", ["mfa/reset", "recovery"])
def test_self_effect_clears_cookies_and_completes_only_admitted_action(world, action):
    def self_provider(request):
        if request.url.path.endswith(f"/{world.provider_id}/factors"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/recover"):
            with Session(world.owner) as db:
                assert db.get(IdentitySession, world.session_id).revoked_at is not None
            return httpx.Response(200, json={})
        return None

    world.hook = self_provider
    response = post(
        world, action, {"revoke_sessions": True} if action == "recovery" else {}, self_target=True
    )
    assert response.status_code == 200, response.text
    cookies = response.headers.get_list("set-cookie")
    assert all(
        any(name in cookie and "Max-Age=0" in cookie for cookie in cookies)
        for name in ["openslate_access", "openslate_refresh", "openslate_csrf"]
    )
    with Session(world.owner) as db:
        assert db.get(IdentitySession, world.session_id).revoked_at is not None
    assert world.client.get("/api/auth/me", headers=world.headers()).status_code == 401


@pytest.mark.parametrize("self_target", [False, True])
def test_mail_failure_after_revoke_keeps_committed_effect_and_clears_self_cookies(
    world, self_target
):
    def failed_mail(request):
        if request.url.path.endswith("/recover"):
            return httpx.Response(503, json={"private": "Private provider detail"})
        return None

    world.hook = failed_mail
    response = post(world, body={"revoke_sessions": True}, self_target=self_target)
    assert response.status_code == 503
    assert response.json()["detail"]["local_revocation"] == "committed"
    assert response.json()["detail"]["email_request"] == "unconfirmed"
    if self_target:
        assert any(
            "openslate_access" in cookie and "Max-Age=0" in cookie
            for cookie in response.headers.get_list("set-cookie")
        )
    else:
        assert all(session.revoked_at is not None for session in world.sessions())
    assert "Private provider detail" not in response.text


def test_zero_factor_observation_cannot_revoke_after_actor_loss(world):
    world.factors.clear()

    def during_inventory(request):
        if request.url.path.endswith("/factors"):
            with Session(world.owner) as db:
                db.get(User, world.actor_id).role = "member"
                db.commit()
        return None

    world.hook = during_inventory
    response = post(world, "mfa/reset")
    assert response.status_code == 503
    assert all(session.revoked_at is None for session in world.sessions())


@pytest.mark.parametrize("action", ["mfa/reset", "recovery"])
def test_unconfirmed_revocation_commit_does_not_send_email_or_claim_success(
    world, monkeypatch, action
):
    original = AuditSession.commit

    def fail(db):
        if any(
            isinstance(row, IdentitySession)
            and row.revoked_at is not None
            and row.user_id == world.target_id
            for row in db.dirty
        ):
            raise OperationalError("owned fault", None, Exception("Private persistence detail"))
        return original(db)

    monkeypatch.setattr(AuditSession, "commit", fail)
    response = post(world, action, {"revoke_sessions": True} if action == "recovery" else {})
    assert response.status_code == 503
    assert response.json()["detail"]["local_revocation"] == "unconfirmed"
    assert not any(path.endswith("/recover") for _, path in world.calls)
    assert all(session.revoked_at is None for session in world.sessions())
    assert "Private persistence detail" not in response.text


def test_reciprocal_administrators_use_real_sessions_without_deadlock(world, fake_provider):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from fastapi.testclient import TestClient
    from sqlalchemy import event

    from app.core.config import get_settings
    from app.core.database.session import get_engine
    from app.core.integrations.supabase_auth import get_supabase_auth_client
    from app.main import create_app

    owned = owned_account(fake_provider)
    email, password, provider_id, local_id, owner = next(owned)
    provider = get_supabase_auth_client()
    transport = provider._transport
    client = TestClient(create_app(), base_url=get_settings().public_origin)
    client.headers["Origin"] = get_settings().public_origin
    try:
        with Session(owner) as db:
            actor = db.get(User, local_id)
            actor.supabase_user_id, actor.role = provider_id, "admin"
            db.commit()
        # The second administrator signs in through the fake provider, then requests use
        # the world's own provider boundary again.
        provider._transport = httpx.MockTransport(fake_provider.respond)
        provider._jwks = {}
        provider._jwks_expires_at = provider._next_jwks_fetch_at = 0
        assert (
            client.post("/api/auth/login", json={"email": email, "password": password}).status_code
            == 200
        )
        provider._transport = transport
        provider._jwks = {}
        provider._jwks_expires_at = provider._next_jwks_fetch_at = 0
        client.cookies.clear()
        with Session(owner) as db:
            second_session = db.scalar(
                select(IdentitySession).where(IdentitySession.user_id == local_id)
            )
            sid = second_session.provider_session_id
        barrier = Barrier(2)
        sqlstates = []

        def provider_boundary(request):
            if request.url.path == f"/auth/v1/admin/users/{provider_id}":
                barrier.wait(timeout=10)
                return httpx.Response(
                    200, json={"id": str(provider_id), "email": email, "factors": []}
                )
            if request.url.path == f"/auth/v1/admin/users/{world.provider_id}":
                barrier.wait(timeout=10)
            if request.url.path.endswith("/recover"):
                return httpx.Response(200, json={})
            return None

        world.hook = provider_boundary

        def database_error(context):
            sqlstates.append(getattr(context.original_exception, "sqlstate", None))

        engine = get_engine()
        event.listen(engine, "handle_error", database_error)
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(
                    world.client.post,
                    f"/api/users/{local_id}/recovery",
                    headers=world.headers(),
                    json={},
                )
                second = pool.submit(
                    client.post,
                    f"/api/users/{world.actor_id}/recovery",
                    headers=world.headers(sub=str(provider_id), session_id=str(sid)),
                    json={},
                )
                responses = [first.result(timeout=15), second.result(timeout=15)]
            assert "40P01" not in sqlstates
            assert [response.status_code for response in responses] == [200, 200]
        finally:
            event.remove(engine, "handle_error", database_error)
    finally:
        provider._transport = transport
        world.hook = None
        client.close()
        try:
            next(owned)
        except StopIteration:
            pass


@pytest.mark.parametrize("state", ["disabled", "pending", "expired", "unbound"])
@pytest.mark.parametrize("action", ["mfa/reset", "recovery"])
def test_initial_ineligible_target_cannot_receive_remote_effects(world, state, action):
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        if state == "expired":
            target.expires_at = datetime.now(UTC) - timedelta(days=1)
        elif state == "unbound":
            target.supabase_user_id = None
        else:
            target.status = state
        db.commit()
    response = post(world, action)
    assert response.status_code == 409
    assert not any(method == "DELETE" or path.endswith("/recover") for method, path in world.calls)
    assert all(session.revoked_at is None for session in world.sessions())


@pytest.mark.parametrize("action", ["mfa/reset", "recovery"])
def test_new_cookie_mutations_keep_existing_csrf_boundary(world, action):
    world.client.cookies.set(
        "openslate_access", world.headers("aal2")["Authorization"].partition(" ")[2]
    )
    response = world.client.post(f"/api/users/{world.target_id}/{action}", json={})
    assert response.status_code == 401
    assert not any(method == "DELETE" or path.endswith("/recover") for method, path in world.calls)
    assert all(session.revoked_at is None for session in world.sessions())
