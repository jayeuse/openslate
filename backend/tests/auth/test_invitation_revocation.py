"""Invitation revocation contracts and PostgreSQL persistence behavior."""

from secrets import token_urlsafe
from unittest.mock import Mock
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.core.config import get_settings
from app.core.database import get_db
from app.core.integrations.supabase_auth import SupabaseAuthClient
from app.main import create_app
from app.systems.access.auth.aggregate_router import router as access_router
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users import invitations_router
from app.systems.access.users.coordination import InvitationConflict, InvitationNotFound
from app.systems.access.users.models import User, UserStatus
from app.systems.manage.audit.models import SecurityEvent
from app.systems.platform.scheduling.models import InAppNotification
from tests.auth.test_provider_email_integration import _email_action

pytest_plugins = ("tests.auth.test_provider_email_integration",)


def _admin() -> User:
    return User(
        id=uuid7(),
        email="admin@example.test",
        username="admin",
        status=UserStatus.ACTIVE.value,
        role="admin",
    )


def _client(db: Session, identity: CurrentIdentity | None = None) -> TestClient:
    """The real access router; ``identity`` replaces authentication when given."""

    app = FastAPI()
    app.include_router(access_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    if identity is not None:
        app.dependency_overrides[get_current_identity] = lambda: identity
    return TestClient(app)


def test_invitation_revocation_route_exists_and_requires_authentication() -> None:
    response = _client(Mock(spec=Session)).delete(f"/api/auth/invitations/{uuid7()}")

    assert response.status_code == 401


def test_invitation_revocation_rejects_setup_only_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity = CurrentIdentity(_admin(), uuid7(), True, True)
    revoke = Mock()
    monkeypatch.setattr(invitations_router, "revoke_invitation", revoke)

    response = _client(Mock(spec=Session), identity).delete(f"/api/auth/invitations/{uuid7()}")

    assert response.status_code == 401
    revoke.assert_not_called()


def test_authorized_invitation_revocation_returns_empty_204(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin = _admin()
    db = Mock(spec=Session)
    user_id = uuid7()
    revoke = Mock()
    monkeypatch.setattr(invitations_router, "revoke_invitation", revoke)

    response = _client(db, CurrentIdentity(admin, uuid7(), True, False)).delete(
        f"/api/auth/invitations/{user_id}"
    )

    assert response.status_code == 204
    assert response.content == b""
    revoke.assert_called_once_with(db, user_id, actor_id=admin.id)


@pytest.mark.parametrize(
    ("error", "expected_status", "expected_detail"),
    (
        (InvitationNotFound("missing"), 404, "Invitation not found"),
        (InvitationConflict("closed"), 409, "Invitation is no longer pending"),
    ),
)
def test_invitation_revocation_maps_missing_and_closed_states(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    expected_status: int,
    expected_detail: str,
) -> None:
    identity = CurrentIdentity(_admin(), uuid7(), True, False)
    monkeypatch.setattr(invitations_router, "revoke_invitation", Mock(side_effect=error))

    response = _client(Mock(spec=Session), identity).delete(f"/api/auth/invitations/{uuid7()}")

    assert response.status_code == expected_status
    assert response.json() == {"detail": expected_detail}


@pytest.mark.integration
def test_revoked_provider_invitation_is_denied_and_resend_can_be_accepted(
    provider_account,
    provider_mail,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    email, password, provider_id, local_id, owner = provider_account
    provider_invite_failures = []
    original_request = SupabaseAuthClient._request

    def observe_request(self, method, path, **kwargs):
        response = original_request(self, method, path, **kwargs)
        if path == "invite" and response.status_code >= 400:
            provider_invite_failures.append(
                (response.status_code, response.json().get("error_code"))
            )
        return response

    monkeypatch.setattr(SupabaseAuthClient, "_request", observe_request)
    settings = get_settings()
    invite_email = f"revoked-{uuid4().hex}@example.test"
    with Session(owner) as db:
        user = db.get(User, local_id)
        user.supabase_user_id = provider_id
        user.role = "admin"
        db.commit()
    source = uuid4().bytes
    client_address = (f"198.18.{source[0]}.{source[1]}", 50000)
    admin = TestClient(create_app(), base_url=settings.public_origin, client=client_address)
    recipient = TestClient(create_app(), base_url=settings.public_origin, client=client_address)
    admin.headers["Origin"] = recipient.headers["Origin"] = settings.public_origin
    try:
        assert (
            admin.post("/api/auth/login", json={"email": email, "password": password}).status_code
            == 200
        )
        admin.headers["X-CSRF-Token"] = admin.cookies.get("openslate_csrf")
        created = admin.post(
            "/api/auth/invitations",
            json={"email": invite_email, "username": f"revoked_{uuid4().hex[:16]}"},
        )
        assert created.status_code == 201
        invited_id = created.json()["user"]["id"]
        path = f"/api/auth/invitations/{invited_id}"
        old_action = _email_action(provider_mail, invite_email, "invite")
        chosen = token_urlsafe(32)
        assert admin.delete(path).status_code == 204
        assert admin.delete(path).status_code == 409
        assert admin.delete(f"/api/auth/invitations/{uuid7()}").status_code == 404
        denied = recipient.post(
            "/api/auth/invitations/complete",
            json={"token_hash": old_action, "password": chosen},
        )
        assert denied.status_code == 400
        assert recipient.get("/api/auth/me").status_code == 401
        assert (
            recipient.post(
                "/api/auth/login", json={"email": invite_email, "password": chosen}
            ).status_code
            == 401
        )
        with Session(owner) as db:
            pending = db.scalar(select(User).where(User.email == invite_email))
            assert pending is not None and pending.status == "pending"
            assert pending.invitation_sent_at is None
            events = db.scalars(
                select(SecurityEvent).where(
                    SecurityEvent.event_type == "user.invitation_revocation",
                    SecurityEvent.subject_id == pending.id,
                )
            ).all()
            assert len(events) == 1 and events[0].outcome == "success"

        resent = admin.post(f"{path}/resend", json={})
        assert resent.status_code == 200, provider_invite_failures
        new_action = _email_action(provider_mail, invite_email, "invite", exclude={old_action})
        assert (
            recipient.post(
                "/api/auth/invitations/complete",
                json={"token_hash": old_action, "password": chosen},
            ).status_code
            == 400
        )
        assert (
            recipient.post(
                "/api/auth/invitations/complete",
                json={"token_hash": new_action, "password": chosen},
            ).status_code
            == 204
        )
        assert (
            recipient.post(
                "/api/auth/invitations/complete",
                json={"token_hash": new_action, "password": chosen},
            ).status_code
            == 400
        )
        assert admin.delete(path).status_code == 409
        with Session(owner) as db:
            notices = list(
                db.scalars(
                    select(InAppNotification).where(
                        InAppNotification.kind == "invitation-accepted",
                        InAppNotification.subject_id == UUID(invited_id),
                    )
                )
            )
            assert len(notices) == 1 and notices[0].recipient_id == local_id
        assert recipient.get("/api/auth/me").status_code == 401
        assert (
            recipient.post(
                "/api/auth/login", json={"email": invite_email, "password": chosen}
            ).status_code
            == 200
        )
    finally:
        admin.close()
        recipient.close()
        with Session(owner) as db:
            user = db.scalar(select(User).where(User.email == invite_email))
            if user is not None:
                for notice in db.scalars(
                    select(InAppNotification).where(
                        InAppNotification.kind == "invitation-accepted",
                        InAppNotification.subject_id == user.id,
                    )
                ):
                    db.delete(notice)
                db.flush()
                if user.supabase_user_id is not None:
                    removed = httpx.delete(
                        settings.supabase_url + f"/auth/v1/admin/users/{user.supabase_user_id}",
                        headers={"apikey": settings.supabase_secret_key.get_secret_value()},
                        timeout=10,
                    )
                    assert removed.status_code in {200, 204, 404}
                for session in db.scalars(
                    select(IdentitySession).where(IdentitySession.user_id == user.id)
                ):
                    db.delete(session)
                db.delete(user)
                db.commit()
