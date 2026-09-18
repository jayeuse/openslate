import os
from collections.abc import Generator
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.core.config import get_settings
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.core.integrations.supabase import SupabaseAdminClient, SupabaseAdminError
from app.core.middleware.request_context import get_request_context
from app.main import create_app
from app.systems.access.users.models import Role, User, UserRole, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from tests.conftest import guarded_create_engine as create_engine

pytestmark = pytest.mark.integration


def _guarded_urls() -> tuple[str, str]:
    settings = get_settings()
    runtime_url = settings.database_url
    owner_url = os.getenv("MIGRATION_DATABASE_URL")
    if owner_url is None:
        pytest.skip("A migration owner database URL is required")
    from tests.conftest import _assert_alembic_head, _guard_integration_database

    _guard_integration_database(runtime_url)
    _guard_integration_database(owner_url)
    engine = create_engine(runtime_url)
    try:
        with engine.connect() as connection:
            _assert_alembic_head(connection)
            current_user = connection.scalar(text("SELECT current_user"))
            if current_user != "openslate_runtime":
                pytest.skip(
                    "TEST_DATABASE_URL must connect as the openslate_runtime application role"
                )
    finally:
        engine.dispose()
    return runtime_url, owner_url


class InvitationApiFixture:
    """Own trigger-created identities and one real request session per API call."""

    def __init__(self, runtime_url: str, owner_url: str) -> None:
        self.runtime_engine = create_engine(runtime_url, pool_size=3)
        self.owner_engine = create_engine(owner_url, pool_size=3)
        self.app: Any = None
        self.request_sessions: list[AuditSession] = []
        self.created_ids: set[UUID] = set()
        self.provider_paths: list[str] = []
        self.provider_mode = "success"
        self.fail_next_commit = False
        self.actor_id = uuid7()
        try:
            self.app = create_app()
            self.member_role_id, self.admin_role_id = self._seed_actor()
            self.actor = self._actor_model()
            self.app.dependency_overrides[get_current_user] = lambda: self.actor
            self.app.dependency_overrides[get_db] = self._get_db
        except BaseException:
            self.cleanup()
            raise

    def _seed_actor(self) -> tuple[UUID, UUID]:
        with self.owner_engine.begin() as connection:
            roles = connection.execute(
                text(
                    "SELECT id, role FROM public.roles "
                    "WHERE role IN ('admin', 'member') AND is_deleted = false"
                )
            ).mappings()
            role_ids = {row["role"]: row["id"] for row in roles}
            if set(role_ids) != {"admin", "member"}:
                raise RuntimeError("The local database must contain active admin and member roles")
            email = f"invite-tx-{self.actor_id}@example.com"
            self.created_ids.add(self.actor_id)
            connection.execute(
                text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
                {"id": self.actor_id, "email": email},
            )
            connection.execute(
                text(
                    "UPDATE public.users SET status = 'active', role_id = :role_id, "
                    "invitation_sent_at = NULL, invitation_accepted_at = NULL, "
                    "is_deleted = false, deleted_at = NULL WHERE id = :id"
                ),
                {"id": self.actor_id, "role_id": role_ids["admin"]},
            )
            return role_ids["member"], role_ids["admin"]

    def _actor_model(self) -> User:
        now = datetime.now(UTC)
        admin_role = Role(
            id=self.admin_role_id,
            role=UserRole.ADMIN.value,
            permissions={},
            created_at=now,
            updated_at=now,
            is_deleted=False,
        )
        return User(
            id=self.actor_id,
            email=f"invite-tx-{self.actor_id}@example.com",
            username=f"auth_{self.actor_id.hex}",
            status=UserStatus.ACTIVE.value,
            role_id=self.admin_role_id,
            role=admin_role,
            created_at=now,
            updated_at=now,
            is_deleted=False,
        )

    def _get_db(self, request: Request) -> Generator[Session, None, None]:
        request_context = get_request_context(request)
        database = AuditSession(bind=self.runtime_engine)
        database.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=self.actor_id,
            request_id=request_context.request_id,
            request_method=request.method,
            request_path=request.url.path,
        )
        if self.fail_next_commit:
            self.fail_next_commit = False

            def fail_commit() -> None:
                raise SQLAlchemyError("local invitation finalization failed")

            database.commit = fail_commit  # type: ignore[method-assign]
        self.request_sessions.append(database)
        try:
            yield database
        finally:
            database.close()

    def _insert_auth_identity(self, email: str) -> UUID:
        user_id = uuid7()
        with self.owner_engine.begin() as connection:
            connection.execute(
                text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
                {"id": user_id, "email": email},
            )
        self.created_ids.add(user_id)
        return user_id

    def pending_target(self) -> UUID:
        user_id = self._insert_auth_identity(f"pending-{uuid7()}@example.com")
        with self.owner_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE public.users SET status = 'pending', role_id = :role_id, "
                    "invitation_sent_at = CURRENT_TIMESTAMP, invitation_accepted_at = NULL, "
                    "is_deleted = false, deleted_at = NULL WHERE id = :id"
                ),
                {"id": user_id, "role_id": self.member_role_id},
            )
        return user_id

    def existing_profile(self, *, email: str) -> UUID:
        user_id = self._insert_auth_identity(email)
        with self.owner_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE public.users SET status = 'active', role_id = :role_id, "
                    "invitation_sent_at = NULL, invitation_accepted_at = NULL, "
                    "is_deleted = false, deleted_at = NULL WHERE id = :id"
                ),
                {"id": user_id, "role_id": self.member_role_id},
            )
        return user_id

    def provider_request(
        self,
        method: str,
        url: str,
        payload: dict[str, object] | None = None,
        *,
        params: dict[str, str] | None = None,
    ) -> object:
        path = str(url)
        self.provider_paths.append(path)
        session = self.request_sessions[-1]
        assert session.expire_on_commit is True
        assert session.in_transaction() is False
        request_payload = payload or {}

        if path.endswith("/invite"):
            if self.provider_mode == "provider_failure":
                raise SupabaseAdminError(
                    "provider unavailable",
                    status_code=503,
                )
            email = str(request_payload["email"])
            user_id = self._insert_auth_identity(email)
            if self.provider_mode == "profile_drift":
                self._update_profile(user_id, username=f"drift_{user_id.hex[:12]}")
            elif self.provider_mode == "admin_revoked":
                self._set_actor_status(UserStatus.DISABLED.value)
            return {"id": str(user_id), "email": email}

        if path.endswith("/resend"):
            if self.provider_mode == "provider_failure":
                raise SupabaseAdminError(
                    "provider unavailable",
                    status_code=503,
                )
            email = str(request_payload["email"])
            target_id = self._user_id_for_email(email)
            if self.provider_mode == "profile_drift":
                self._update_profile(target_id, username=f"drift_{target_id.hex[:12]}")
            elif self.provider_mode == "admin_revoked":
                self._set_actor_status(UserStatus.DISABLED.value)
            return {}

        raise AssertionError(f"unexpected provider path: {path}")

    def _user_id_for_email(self, email: str) -> UUID:
        with self.owner_engine.connect() as connection:
            value = connection.scalar(
                text("SELECT id FROM public.users WHERE email = :email"), {"email": email}
            )
        if not isinstance(value, UUID):
            raise AssertionError("provider resend target was not seeded")
        return value

    def _update_profile(self, user_id: UUID, *, username: str) -> None:
        with self.owner_engine.begin() as connection:
            connection.execute(
                text("UPDATE public.users SET username = :username WHERE id = :id"),
                {"id": user_id, "username": username},
            )

    def _set_actor_status(self, status: str) -> None:
        with self.owner_engine.begin() as connection:
            connection.execute(
                text("UPDATE public.users SET status = :status WHERE id = :id"),
                {"status": status, "id": self.actor_id},
            )

    def row(self, user_id: UUID) -> dict[str, Any]:
        with self.owner_engine.connect() as connection:
            return dict(
                connection.execute(
                    text(
                        "SELECT email, username, status, is_deleted, invitation_sent_at, "
                        "invitation_accepted_at FROM public.users WHERE id = :id"
                    ),
                    {"id": user_id},
                )
                .mappings()
                .one()
            )

    def event_outcomes(self, event_type: str) -> list[str]:
        with self.owner_engine.connect() as connection:
            return list(
                connection.execute(
                    text(
                        "SELECT outcome FROM public.security_events "
                        "WHERE actor_id = :actor_id AND event_type = :event_type "
                        "ORDER BY occurred_at, id"
                    ),
                    {"actor_id": self.actor_id, "event_type": event_type},
                ).scalars()
            )

    def cleanup(self) -> None:
        try:
            with self.owner_engine.begin() as connection:
                for user_id in self.created_ids:
                    connection.execute(
                        text(
                            "DELETE FROM public.security_events "
                            "WHERE actor_id = :id OR subject_id = :id"
                        ),
                        {"id": user_id},
                    )
                    connection.execute(
                        text(
                            "DELETE FROM public.audit_logs "
                            "WHERE entity_id = :id OR performed_by = :id"
                        ),
                        {"id": user_id},
                    )
                    connection.execute(
                        text("DELETE FROM auth.users WHERE id = :id"), {"id": user_id}
                    )
        finally:
            for session in self.request_sessions:
                session.close()
            if self.app is not None:
                self.app.dependency_overrides.clear()
            self.runtime_engine.dispose()
            self.owner_engine.dispose()

    def client(self, monkeypatch: pytest.MonkeyPatch) -> TestClient:
        monkeypatch.setattr(SupabaseAdminClient, "_request", self.provider_request)
        return TestClient(self.app)


@pytest.fixture
def invitation_api() -> Generator[InvitationApiFixture, None, None]:
    runtime_url, owner_url = _guarded_urls()
    fixture = InvitationApiFixture(runtime_url, owner_url)
    try:
        yield fixture
    finally:
        fixture.cleanup()


def _invite_payload(label: str = "new_invited_user") -> dict[str, str]:
    username = f"{label}_{uuid7().hex[:12]}"
    return {"email": f"{username}@example.com", "username": username}


def test_invitation_success_has_no_request_transaction_and_persists_events(
    invitation_api: InvitationApiFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = _invite_payload()
    with invitation_api.client(monkeypatch) as client:
        response = client.post("/api/auth/invitations", json=payload)

    assert response.status_code == 201
    invited_id = UUID(response.json()["id"])
    row = invitation_api.row(invited_id)
    assert row["status"] == UserStatus.PENDING.value
    assert row["email"] == payload["email"]
    assert row["invitation_sent_at"] is not None
    assert invitation_api.provider_paths == ["/auth/v1/invite"]
    assert invitation_api.event_outcomes("user.invitation")[-2:] == ["attempt", "success"]


def test_existing_email_conflict_is_rejected_without_provider_call(
    invitation_api: InvitationApiFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    existing_id = invitation_api.existing_profile(email="reserved@example.com")
    before = invitation_api.row(existing_id)
    payload = {"email": "reserved@example.com", "username": f"different_{uuid7().hex[:12]}"}

    with invitation_api.client(monkeypatch) as client:
        response = client.post("/api/auth/invitations", json=payload)

    assert response.status_code == 409
    assert invitation_api.provider_paths == []
    assert invitation_api.row(existing_id) == before
    assert invitation_api.event_outcomes("user.invitation")[-2:] == ["attempt", "failure"]


def test_provider_failure_records_failure_without_local_identity(
    invitation_api: InvitationApiFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    invitation_api.provider_mode = "provider_failure"
    payload = _invite_payload("provider_down")

    with invitation_api.client(monkeypatch) as client:
        response = client.post("/api/auth/invitations", json=payload)

    assert response.status_code == 502
    assert invitation_api.provider_paths == ["/auth/v1/invite"]
    assert invitation_api.event_outcomes("user.invitation")[-2:] == ["attempt", "failure"]
    with invitation_api.owner_engine.connect() as connection:
        assert (
            connection.scalar(
                text("SELECT count(*) FROM public.users WHERE email = :email"),
                {"email": payload["email"]},
            )
            == 0
        )


@pytest.mark.parametrize("mode", ["profile_drift", "admin_revoked"])
def test_provider_success_followed_by_state_change_is_partial_without_compensation(
    invitation_api: InvitationApiFixture,
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
) -> None:
    invitation_api.provider_mode = mode
    payload = _invite_payload(mode)

    with invitation_api.client(monkeypatch) as client:
        response = client.post("/api/auth/invitations", json=payload)

    assert response.status_code == (403 if mode == "admin_revoked" else 502)
    assert invitation_api.provider_paths == ["/auth/v1/invite"]
    assert invitation_api.event_outcomes("user.invitation")[-2:] == ["attempt", "partial"]
    with invitation_api.owner_engine.connect() as connection:
        count = connection.scalar(
            text("SELECT count(*) FROM auth.users WHERE email = :email"),
            {"email": payload["email"]},
        )
    assert count == 1


def test_invitation_local_commit_failure_keeps_provider_identity_and_records_partial(
    invitation_api: InvitationApiFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    invitation_api.fail_next_commit = True
    payload = _invite_payload("commit_failure")

    with invitation_api.client(monkeypatch) as client:
        response = client.post("/api/auth/invitations", json=payload)

    assert response.status_code == 502
    assert invitation_api.provider_paths == ["/auth/v1/invite"]
    assert invitation_api.event_outcomes("user.invitation")[-2:] == ["attempt", "partial"]
    with invitation_api.owner_engine.connect() as connection:
        assert (
            connection.scalar(
                text("SELECT count(*) FROM auth.users WHERE email = :email"),
                {"email": payload["email"]},
            )
            == 1
        )


def test_resend_success_has_no_request_transaction_and_commits_new_sent_timestamp(
    invitation_api: InvitationApiFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    target_id = invitation_api.pending_target()
    before = invitation_api.row(target_id)["invitation_sent_at"]

    with invitation_api.client(monkeypatch) as client:
        response = client.post(f"/api/auth/invitations/{target_id}/resend")

    assert response.status_code == 200
    after = invitation_api.row(target_id)["invitation_sent_at"]
    assert after is not None and after >= before
    assert invitation_api.provider_paths == ["/auth/v1/resend"]
    assert invitation_api.event_outcomes("user.invitation_resend")[-2:] == ["attempt", "success"]


def test_resend_provider_failure_preserves_local_state_and_records_failure(
    invitation_api: InvitationApiFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    target_id = invitation_api.pending_target()
    before = invitation_api.row(target_id)
    invitation_api.provider_mode = "provider_failure"

    with invitation_api.client(monkeypatch) as client:
        response = client.post(f"/api/auth/invitations/{target_id}/resend")

    assert response.status_code == 502
    assert invitation_api.row(target_id) == before
    assert invitation_api.event_outcomes("user.invitation_resend")[-2:] == ["attempt", "failure"]


@pytest.mark.parametrize("mode", ["profile_drift", "admin_revoked"])
def test_resend_provider_success_followed_by_state_change_is_partial(
    invitation_api: InvitationApiFixture,
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
) -> None:
    target_id = invitation_api.pending_target()
    invitation_api.provider_mode = mode

    with invitation_api.client(monkeypatch) as client:
        response = client.post(f"/api/auth/invitations/{target_id}/resend")

    assert response.status_code == (403 if mode == "admin_revoked" else 502)
    assert invitation_api.provider_paths == ["/auth/v1/resend"]
    assert invitation_api.event_outcomes("user.invitation_resend")[-2:] == ["attempt", "partial"]


def test_resend_local_commit_failure_records_partial_without_provider_compensation(
    invitation_api: InvitationApiFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    target_id = invitation_api.pending_target()
    before = invitation_api.row(target_id)
    invitation_api.fail_next_commit = True

    with invitation_api.client(monkeypatch) as client:
        response = client.post(f"/api/auth/invitations/{target_id}/resend")

    assert response.status_code == 502
    assert invitation_api.provider_paths == ["/auth/v1/resend"]
    assert invitation_api.row(target_id)["username"] == before["username"]
    assert invitation_api.event_outcomes("user.invitation_resend")[-2:] == ["attempt", "partial"]
