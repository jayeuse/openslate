"""Person security actions through signed Auth, PostgreSQL and provider HTTP boundaries."""

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from jwt.algorithms import ECAlgorithm
from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.integrations.supabase_auth import get_supabase_auth_client
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEvent
from tests.auth.test_provider_auth_integration import provider_account  # noqa: F401
from tests.auth.test_supabase_auth_core import _signed_access

pytestmark = pytest.mark.integration


@dataclass
class SecurityWorld:
    owner: Engine
    actor_id: UUID
    target_id: UUID
    provider_id: UUID
    target_provider_id: UUID
    session_id: UUID
    provider_session_id: UUID
    key: ec.EllipticCurvePrivateKey
    client: TestClient
    factors: list[dict[str, str]]
    calls: list[tuple[str, str]] = field(default_factory=list)
    hook: Callable[[httpx.Request], httpx.Response | None] | None = None

    def headers(self, aal: str = "aal1", **claims: object) -> dict[str, str]:
        token = _signed_access(
            self.key,
            user_id=str(self.provider_id),
            session_id=str(self.provider_session_id),
            issuer=get_settings().supabase_auth_issuer,
            audience=get_settings().supabase_auth_audience,
            extra={"aal": aal, **claims},
        )
        return {"Authorization": f"Bearer {token}"}

    def sessions(self) -> list[IdentitySession]:
        with Session(self.owner) as db:
            return list(
                db.scalars(select(IdentitySession).where(IdentitySession.user_id == self.target_id))
            )

    def events(self) -> list[SecurityEvent]:
        with Session(self.owner) as db:
            return list(
                db.scalars(
                    select(SecurityEvent)
                    .where(SecurityEvent.subject_id == self.target_id)
                    .order_by(SecurityEvent.occurred_at, SecurityEvent.id)
                )
            )


@pytest.fixture
def world(provider_account, monkeypatch):  # noqa: F811
    email, password, provider_id, actor_id, owner = provider_account
    settings = get_settings()
    with Session(owner) as db:
        actor = db.get(User, actor_id)
        actor.supabase_user_id = provider_id
        actor.role = "admin"
        target = User(
            username=f"security-target-{uuid4().hex[:16]}",
            email=f"security-target-{uuid4().hex}@example.test",
            status="active",
            role="member",
            supabase_user_id=uuid4(),
        )
        db.add(target)
        db.commit()
        target_id, target_provider_id, target_email = (
            target.id,
            target.supabase_user_id,
            target.email,
        )
        db.add(
            IdentitySession(
                user_id=target_id,
                provider_user_id=target_provider_id,
                provider_session_id=uuid4(),
                refresh_token_digest=uuid4().hex * 2,
                csrf_token_digest=uuid4().hex * 2,
                expires_at=datetime.now(UTC) + timedelta(days=1),
            )
        )
        db.commit()
    # A real disposable Auth login creates its real provider session row. No
    # get_current_identity/user override or fabricated auth.sessions admission.
    client = TestClient(create_app(), base_url=settings.public_origin)
    client.headers["Origin"] = settings.public_origin
    try:
        login = client.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200
        with Session(owner) as db:
            session = db.scalar(select(IdentitySession).where(IdentitySession.user_id == actor_id))
            session_id, provider_session_id = session.id, session.provider_session_id
        client.cookies.clear()
        key = ec.generate_private_key(ec.SECP256R1())
        jwk = ECAlgorithm.to_jwk(key.public_key(), as_dict=True)
        jwk.update({"kid": "test-key", "alg": "ES256", "use": "sig"})
        state = SecurityWorld(
            owner,
            actor_id,
            target_id,
            provider_id,
            target_provider_id,
            session_id,
            provider_session_id,
            key,
            client,
            [{"id": str(uuid4()), "factor_type": "totp", "status": "verified"}],
        )

        def provider(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            state.calls.append((request.method, path))
            if state.hook:
                response = state.hook(request)
                if response is not None:
                    return response
            if path.endswith("/.well-known/jwks.json"):
                return httpx.Response(200, json={"keys": [jwk]})
            if path == f"/auth/v1/admin/users/{provider_id}":
                return httpx.Response(
                    200, json={"id": str(provider_id), "email": email, "factors": []}
                )
            if path == f"/auth/v1/admin/users/{target_provider_id}":
                return httpx.Response(
                    200,
                    json={
                        "id": str(target_provider_id),
                        "email": target_email,
                        "factors": state.factors,
                    },
                )
            if path == f"/auth/v1/admin/users/{target_provider_id}/factors":
                return httpx.Response(200, json=state.factors)
            if path.startswith(f"/auth/v1/admin/users/{target_provider_id}/factors/"):
                factor_id = path.rsplit("/", 1)[-1]
                state.factors[:] = [f for f in state.factors if f["id"] != factor_id]
                return httpx.Response(200, json={"id": factor_id})
            if path == "/auth/v1/recover":
                assert json.loads(request.content) == {"email": target_email}
                return httpx.Response(200, json={})
            raise AssertionError(f"Unadmitted provider request {request.method} {path}")

        provider_client = get_supabase_auth_client()
        monkeypatch.setattr(provider_client, "_transport", httpx.MockTransport(provider))
        monkeypatch.setattr(provider_client, "_jwks", {})
        monkeypatch.setattr(provider_client, "_jwks_expires_at", 0)
        monkeypatch.setattr(provider_client, "_next_jwks_fetch_at", 0)
        monkeypatch.setattr(settings, "smtp_host", "smtp.example.test")
        monkeypatch.setattr(settings, "smtp_port", 2525)
        monkeypatch.setattr(settings, "smtp_admin_email", "operator@example.test")
        yield state
    finally:
        client.close()
        with Session(owner) as db:
            for session in db.scalars(
                select(IdentitySession).where(IdentitySession.user_id == target_id)
            ):
                db.delete(session)
            target = db.get(User, target_id)
            if target is not None:
                db.delete(target)
            db.commit()


def test_live_status_requires_real_auth_and_reports_current_enrollment(world):
    path = f"/api/users/{world.target_id}/security"
    assert world.client.get("/api/auth/me", headers=world.headers()).status_code == 200
    status = world.client.get(path, headers=world.headers())
    assert status.status_code == 200, status.text
    assert status.json() == {
        "user_id": str(world.target_id),
        "verified_factor_count": 1,
        "target_eligible": True,
        "smtp_configured": True,
    }
    assert status.headers["Cache-Control"] == "no-store"
    assert world.client.get(path).status_code == 401
    assert not world.events()


@pytest.mark.parametrize(
    "field,value,expected",
    [
        ("role", "member", 403),
        ("status", "disabled", 401),
        ("tokens_valid_after", datetime.now(UTC) + timedelta(minutes=1), 401),
    ],
)
def test_status_requires_current_actor_authority(world, field, value, expected):
    with Session(world.owner) as db:
        actor = db.get(User, world.actor_id)
        setattr(actor, field, value)
        db.commit()
    response = world.client.get(f"/api/users/{world.target_id}/security", headers=world.headers())
    assert response.status_code == expected
    assert not any(path.endswith(str(world.target_provider_id)) for _, path in world.calls)


@pytest.mark.parametrize("state", ["disabled", "expired", "pending"])
def test_bound_inactive_status_is_readable_but_not_action_eligible(world, state):
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        if state == "expired":
            target.expires_at = datetime.now(UTC) - timedelta(days=1)
        else:
            target.status = state
        db.commit()
    response = world.client.get(f"/api/users/{world.target_id}/security", headers=world.headers())
    assert response.status_code == 200, response.text
    assert response.json()["verified_factor_count"] == 1
    assert response.json()["target_eligible"] is False


@pytest.mark.parametrize("state,expected", [("deleted", 404), ("unbound", 409), ("missing", 404)])
def test_status_refuses_missing_deleted_and_unbound_profiles(world, state, expected):
    target_id = world.target_id
    if state == "missing":
        target_id = uuid4()
    else:
        with Session(world.owner) as db:
            target = db.get(User, target_id)
            if state == "deleted":
                target.is_deleted = True
                target.deleted_at = datetime.now(UTC)
            else:
                target.supabase_user_id = None
            db.commit()
    response = world.client.get(f"/api/users/{target_id}/security", headers=world.headers())
    assert response.status_code == expected
    assert "verified_factor_count" not in response.json()


@pytest.mark.parametrize("failure", ["unavailable", "malformed", "wrong_binding"])
def test_provider_status_failure_never_reports_false_mfa_off(world, failure):
    def provider(request):
        if request.url.path != f"/auth/v1/admin/users/{world.target_provider_id}":
            return None
        if failure == "unavailable":
            return httpx.Response(503, json={"private": "Private provider routing detail"})
        if failure == "malformed":
            return httpx.Response(200, json={"id": str(world.target_provider_id), "factors": None})
        return httpx.Response(200, json={"id": str(uuid4()), "email": "foreign@example.test"})

    world.hook = provider
    response = world.client.get(f"/api/users/{world.target_id}/security", headers=world.headers())
    assert response.status_code == (409 if failure == "wrong_binding" else 503)
    assert "verified_factor_count" not in response.json()
    assert "Private provider routing detail" not in response.text
    assert "foreign@example.test" not in response.text


def test_status_reports_empty_factors_and_absent_smtp_truthfully(world, monkeypatch):
    world.factors.clear()
    monkeypatch.setattr(get_settings(), "smtp_host", None)
    response = world.client.get(f"/api/users/{world.target_id}/security", headers=world.headers())
    assert response.status_code == 200, response.text
    assert response.json()["verified_factor_count"] == 0
    assert response.json()["smtp_configured"] is False


@pytest.mark.parametrize("change,expected", [("role", 403), ("session", 401), ("binding", 409)])
def test_status_discards_provider_facts_after_authority_or_binding_changes(world, change, expected):
    changed = []

    def during_provider(request):
        if request.url.path == f"/auth/v1/admin/users/{world.target_provider_id}" and not changed:
            changed.append(True)
            with Session(world.owner) as db:
                if change == "role":
                    db.get(User, world.actor_id).role = "member"
                elif change == "session":
                    db.get(IdentitySession, world.session_id).revoked_at = datetime.now(UTC)
                else:
                    db.get(User, world.target_id).supabase_user_id = uuid4()
                db.commit()
        return None

    world.hook = during_provider
    response = world.client.get(f"/api/users/{world.target_id}/security", headers=world.headers())
    assert changed
    assert response.status_code == expected
    assert "verified_factor_count" not in response.json()


@pytest.mark.parametrize(
    "body",
    [
        {"revoke_sessions": None},
        {"revoke_sessions": "false"},
        {"revoke_sessions": 0},
        {"email": "private@example.test"},
    ],
)
def test_recovery_rejects_unknown_null_and_coerced_input(world, body):
    response = world.client.post(
        f"/api/users/{world.target_id}/recovery", headers=world.headers(), json=body
    )
    assert response.status_code == 422
    assert not any(path.endswith("/recover") for _, path in world.calls)
    assert all(session.revoked_at is None for session in world.sessions())


def test_email_only_recovery_is_correlated_acceptance_without_revocation(world):
    observed = []

    def during_mail(request):
        if request.url.path.endswith("/recover"):
            observed.extend(world.events())
            assert all(session.revoked_at is None for session in world.sessions())
        return None

    world.hook = during_mail
    response = world.client.post(
        f"/api/users/{world.target_id}/recovery", headers=world.headers(), json={}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {
        "operation_id": body["operation_id"],
        "user_id": str(world.target_id),
        "email_request": "accepted",
        "local_revocation": "not_requested",
        "revoked_sessions": None,
    }
    assert len(observed) == 1 and observed[0].outcome == "attempt"
    events = world.events()
    assert [event.outcome for event in events] == ["attempt", "success"]
    assert all(
        str(event.operation_id) == body["operation_id"] and event.actor_id == world.actor_id
        for event in events
    )
    assert all(session.revoked_at is None for session in world.sessions())
    assert sum(path.endswith("/recover") for _, path in world.calls) == 1
    assert "delivered" not in response.text
    assert "example.test" not in str([event.event_metadata for event in events])


@pytest.mark.parametrize("revoke", [False, True])
def test_smtp_absence_refuses_before_any_recovery_effect(world, monkeypatch, revoke):
    monkeypatch.setattr(get_settings(), "smtp_host", None)
    response = world.client.post(
        f"/api/users/{world.target_id}/recovery",
        headers=world.headers(),
        json={"revoke_sessions": revoke},
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "security_smtp_unconfigured"
    assert not any(path.endswith("/recover") for _, path in world.calls)
    assert all(session.revoked_at is None for session in world.sessions())


def test_recovery_timeout_is_unconfirmed_and_never_replayed(world):
    def timeout(request):
        if request.url.path.endswith("/recover"):
            raise httpx.ReadTimeout("Private provider routing detail")
        return None

    world.hook = timeout
    response = world.client.post(
        f"/api/users/{world.target_id}/recovery", headers=world.headers(), json={}
    )
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["email_request"] == "unconfirmed"
    assert detail["local_revocation"] == "not_requested"
    assert sum(path.endswith("/recover") for _, path in world.calls) == 1
    assert "Private provider routing detail" not in response.text
    assert [event.outcome for event in world.events()] == ["attempt", "partial"]
    assert all(session.revoked_at is None for session in world.sessions())


@pytest.mark.parametrize("body", [{"factor_id": str(uuid4())}, {"confirm": True}])
def test_reset_rejects_client_selected_effects(world, body):
    response = world.client.post(
        f"/api/users/{world.target_id}/mfa/reset", headers=world.headers("aal2"), json=body
    )
    assert response.status_code == 422
    assert not any(method == "DELETE" for method, _ in world.calls)


def test_reset_requires_presented_aal2_even_if_local_session_is_newer(world):
    from app.systems.access.identity.mfa import _cipher

    with Session(world.owner) as db:
        session = db.get(IdentitySession, world.session_id)
        access = world.headers("aal2")["Authorization"].partition(" ")[2]
        session.provider_access_token_encrypted = _cipher().encrypt(access.encode()).decode()
        db.commit()
    response = world.client.post(
        f"/api/users/{world.target_id}/mfa/reset", headers=world.headers(), json={}
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "security_aal2_required"
    assert [event.outcome for event in world.events()] == ["denied"]
    assert not any(method == "DELETE" for method, _ in world.calls)
    assert all(session.revoked_at is None for session in world.sessions())


@pytest.mark.parametrize("empty", [False, True])
def test_reset_clears_factors_before_local_revocation_and_handles_zero_factors(world, empty):
    if empty:
        world.factors.clear()
    deleted = []

    def during_delete(request):
        if request.method == "DELETE":
            assert all(session.revoked_at is None for session in world.sessions())
            assert world.events()[0].outcome == "attempt"
            deleted.append(True)
        return None

    world.hook = during_delete
    response = world.client.post(
        f"/api/users/{world.target_id}/mfa/reset", headers=world.headers("aal2"), json={}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["factors_cleared"] is True and body["local_revocation"] == "committed"
    assert body["revoked_sessions"] == 1
    assert bool(deleted) is not empty
    assert not world.factors
    assert all(session.revoked_at is not None for session in world.sessions())
    assert [event.outcome for event in world.events()] == ["attempt", "success"]


def test_reset_refuses_oversize_inventory_without_truncation_or_effect(world):
    world.factors[:] = [
        {"id": str(uuid4()), "factor_type": "totp", "status": "verified"} for _ in range(33)
    ]
    response = world.client.post(
        f"/api/users/{world.target_id}/mfa/reset", headers=world.headers("aal2"), json={}
    )
    assert response.status_code == 503
    assert not any(method == "DELETE" for method, _ in world.calls)
    assert all(session.revoked_at is None for session in world.sessions())
