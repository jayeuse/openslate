"""Email-change HTTP decisions with real generated JWTs and independent provider replies."""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jwt.algorithms import ECAlgorithm
from sqlalchemy.exc import SQLAlchemyError

from app.core.integrations.supabase_auth import ProviderTokens, SupabaseAuthClient
from app.systems.access.identity.contracts import InvalidCredentials
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from tests.auth.provider_jwt_support import provider_settings, session_database, signed_access
from tests.conftest import create_member

PARTIAL = {
    "code": "200",
    "msg": "Confirmation link accepted. Please proceed to confirm link sent to the other email",
}
ORIGIN = "http://frontend.test"


@pytest.fixture
def email_boundary(monkeypatch, unit_workspace_policy, unit_platform_policy):
    from app.common.dependencies import auth as dependencies
    from app.core.database import get_db
    from app.core.integrations import supabase_auth
    from app.systems.access.auth import request_security
    from app.systems.access.auth.aggregate_router import router
    from app.systems.access.identity import provider_actions
    from app.systems.manage.audit import service as audit_service
    from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile

    # Pin the browser origin so the strict test environment matches this client.
    monkeypatch.setattr(
        request_security, "get_settings", lambda: SimpleNamespace(public_origin=ORIGIN)
    )
    now = datetime.now(UTC)
    provider_id, provider_session_id = uuid4(), uuid4()
    key = ec.generate_private_key(ec.SECP256R1())
    jwk = ECAlgorithm.to_jwk(key.public_key(), as_dict=True)
    jwk.update({"kid": "test-key", "alg": "ES256", "use": "sig"})
    access = signed_access(
        key,
        user_id=str(provider_id),
        session_id=str(provider_session_id),
        extra={"email": "old@example.test"},
    )
    user, membership = create_member(None, unit_workspace_policy,
        id=uuid4(),
        supabase_user_id=provider_id,
        email="old@example.test",
        username="owned-person",
        status="active",
        role="member",
    )
    old_session = IdentitySession(
        id=uuid4(),
        user_id=user.id,
        provider_user_id=provider_id,
        provider_session_id=provider_session_id,
        csrf_token_digest=sha256(b"csrf").hexdigest(),
        refresh_token_digest="r" * 64,
        created_at=now,
        refreshed_at=now,
        expires_at=now + timedelta(hours=1),
    )
    db = session_database(user, membership, old_session)
    db.scalars.side_effect = lambda query: SimpleNamespace(all=lambda: [
        unit_workspace_policy if query.column_descriptions[0]["entity"] is WorkspaceProfile
        else membership
    ])
    state = {
        "provider_email": "old@example.test",
        "confirmation": PARTIAL.copy(),
        "confirmed_at": "2020-01-01T00:00:00Z",
        "provider_id": provider_id,
        "password_denied": False,
        "seen": [],
        "events": [],
    }
    resolve_row = db.scalar.side_effect
    db.scalar.side_effect = lambda query: (
        None
        if query.column_descriptions[0]["expr"] is User.id
        else unit_workspace_policy
        if query.column_descriptions[0]["expr"] is WorkspaceProfile
        else unit_platform_policy
        if query.column_descriptions[0]["expr"] is PlatformSettings
        else resolve_row(query)
    )

    def respond(request):
        state["seen"].append(request)
        path = request.url.path
        if path.endswith("/.well-known/jwks.json"):
            return httpx.Response(200, json={"keys": [jwk]})
        if path.endswith("/verify"):
            return httpx.Response(200, json=state["confirmation"])
        if path.endswith("/token"):
            if state["password_denied"]:
                return httpx.Response(400, json={"error": "private-password-error"})
            temporary = signed_access(key, user_id=str(provider_id), session_id=str(uuid4()))
            return httpx.Response(
                200,
                json={
                    "access_token": temporary,
                    "refresh_token": "temporary-refresh",
                    "expires_in": 600,
                    "user": {"id": str(provider_id)},
                },
            )
        if path.endswith("/logout"):
            assert request.url.params["scope"] == "local"
            return httpx.Response(204)
        if "/admin/users/" in path or path.endswith("/user"):
            return httpx.Response(
                200,
                json={
                    "id": str(state["provider_id"]),
                    "email": state["provider_email"],
                    "email_confirmed_at": state["confirmed_at"],
                },
            )
        return httpx.Response(404)

    client = SupabaseAuthClient(provider_settings(), transport=httpx.MockTransport(respond))
    monkeypatch.setattr(supabase_auth, "get_supabase_auth_client", lambda: client)
    monkeypatch.setattr(dependencies, "get_supabase_auth_client", lambda: client)
    monkeypatch.setattr(provider_actions, "anonymous_rate_limits_enabled", lambda: False)
    monkeypatch.setattr(
        audit_service,
        "append_committed_security_event",
        lambda payload: state["events"].append(payload),
    )
    monkeypatch.setattr(
        audit_service, "append_security_event", lambda _db, payload: state["events"].append(payload)
    )
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app, base_url=ORIGIN, client=("127.0.0.1", 1234)) as browser:
        browser.headers["Origin"] = ORIGIN
        yield browser, db, user, old_session, client, access, state


def _final(state, access, user):
    state["provider_email"] = "new@example.test"
    state["confirmation"] = {
        "access_token": access,
        "refresh_token": "new-refresh",
        "expires_in": 600,
        "user": {"id": str(user.supabase_user_id)},
    }


def test_email_request_requires_password_and_never_changes_saved_email(email_boundary):
    browser, db, user, _, _, access, state = email_boundary
    response = browser.post(
        "/api/auth/me/email",
        headers={"Authorization": f"Bearer {access}"},
        json={"email": " New@Example.Test ", "current_password": "correct-password"},
    )
    assert response.status_code == 200
    assert response.json() == {"confirmation_required": True}
    assert user.email == "old@example.test"
    assert not response.headers.get_list("set-cookie")
    import json

    writes = [r for r in state["seen"] if r.method == "PUT"]
    assert len(writes) == 1 and json.loads(writes[0].read()) == {"email": "new@example.test"}
    assert db.commit.called
    assert [(e.event_type, e.outcome.value) for e in state["events"]] == [
        ("identity.email_change_request", "attempt"),
        ("identity.email_change_request", "success"),
    ]
    assert all("old@example.test" not in e.model_dump_json() for e in state["events"])


@pytest.mark.parametrize(
    "credentials",
    [
        {"Cookie": "openslate_access=foreign"},
        {"Cookie": "openslate_refresh=foreign"},
        {"Cookie": "openslate_access="},
        {"Authorization": "Bearer foreign"},
        {"Authorization": "Basic ambiguous"},
        {"Cookie": "openslate_access=foreign", "Authorization": "Bearer foreign"},
    ],
)
def test_confirmation_refuses_credentials_before_consuming_hash(email_boundary, credentials):
    browser, _, user, _, _, _, state = email_boundary
    response = browser.post(
        "/api/auth/email/complete", headers=credentials, json={"token_hash": "a" * 56}
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "signed_out_required"
    assert not any(r.url.path.endswith("/verify") for r in state["seen"])
    assert user.email == "old@example.test"
    assert not response.headers.get_list("set-cookie")


def test_first_confirmation_has_no_local_identity_session_or_cookie_effect(email_boundary):
    browser, db, user, _, _, _, state = email_boundary
    response = browser.post("/api/auth/email/complete", json={"token_hash": "a" * 56})
    assert response.status_code == 200
    assert response.json() == {"authenticated": False, "confirmation_required": True}
    assert user.email == "old@example.test"
    assert not db.add.called and not db.commit.called
    assert not response.headers.get_list("set-cookie")
    assert not state["events"]


def test_final_confirmation_synchronizes_current_email_and_commits_before_cookies(email_boundary):
    browser, db, user, _, _, access, state = email_boundary
    _final(state, access, user)
    committed = []
    db.commit.side_effect = lambda: committed.append(user.email)
    response = browser.post("/api/auth/email/complete", json={"token_hash": "b" * 56})
    assert response.status_code == 200
    assert response.json() == {
        "authenticated": True,
        "confirmation_required": False,
        "setup_required": False,
    }
    assert committed == ["new@example.test"]
    assert "openslate_access" in browser.cookies
    assert [(e.event_type, e.outcome.value) for e in state["events"]] == [
        ("identity.email_change_confirmed", "success")
    ]


@pytest.mark.parametrize("fault", ["commit", "provider_subject", "missing_session", "unconfirmed"])
def test_final_provider_confirmation_reports_incomplete_app_completion_without_cookies(
    email_boundary, fault
):
    browser, db, user, _, _, access, state = email_boundary
    _final(state, access, user)
    if fault == "commit":
        db.commit.side_effect = SQLAlchemyError("private-db-error")
    elif fault == "provider_subject":
        state["provider_id"] = uuid4()
    elif fault == "missing_session":
        db.execute.return_value.scalar_one.return_value = False
    else:
        state["confirmed_at"] = None
    response = browser.post("/api/auth/email/complete", json={"token_hash": "b" * 56})
    assert response.status_code in {409, 503}
    assert response.json()["detail"]["code"] == "email_change_incomplete"
    assert not response.headers.get_list("set-cookie")
    assert db.rollback.called
    logout = [r for r in state["seen"] if r.url.path.endswith("/logout")]
    assert len(logout) == 1 and logout[0].url.params["scope"] == "local"
    assert "private-db-error" not in response.text


def test_admission_reconciles_out_of_band_confirmed_email_once(email_boundary):
    from app.systems.access.identity.provider_sessions import admit_provider_session

    _, db, user, _, client, access, state = email_boundary
    state["provider_email"] = "new@example.test"
    tokens = ProviderTokens(access, "provider-refresh", user.supabase_user_id, 600)
    admit_provider_session(db, tokens, client, ip_address="127.0.0.1")
    assert user.email == "new@example.test"
    admit_provider_session(db, tokens, client, ip_address="127.0.0.1")
    assert len(state["events"]) == 1
    assert state["events"][0].event_type == "identity.email_change_confirmed"


@pytest.mark.parametrize(
    "fault", ["cutoff", "expired_during_provider", "ineligible_during_provider", "source_policy"]
)
def test_admission_rechecks_after_provider_latency_before_email_mutation(
    email_boundary, monkeypatch, unit_workspace_policy, fault
):
    from app.systems.access.identity import provider_sessions

    _, db, user, _, client, access, state = email_boundary
    state["provider_email"] = "new@example.test"
    claims = client.verify_access_token(access)
    if fault == "cutoff":
        user.tokens_valid_after = claims.issued_at + timedelta(seconds=1)
    elif fault == "source_policy":
        unit_workspace_policy.ip_allow_list = ["192.0.2.0/24"]
    else:
        original = client.get_admin_user

        def delayed(identifier):
            if fault == "ineligible_during_provider":
                user.status = "disabled"
            else:
                monkeypatch.setattr(provider_sessions, "utc_now", lambda: claims.expires_at)
            return original(identifier)

        monkeypatch.setattr(client, "get_admin_user", delayed)
    with pytest.raises(InvalidCredentials):
        provider_sessions.admit_provider_session(
            db,
            ProviderTokens(access, "provider-refresh", user.supabase_user_id, 600),
            client,
            ip_address="127.0.0.1",
        )
    assert user.email == "old@example.test"
    assert not state["events"] and not db.add.called
