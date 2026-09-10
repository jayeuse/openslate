import os
from collections.abc import Generator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import Mock
from uuid import UUID

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.users.account_operations as account_operations
import app.systems.users.reconciliation as reconciliation
from app.common.dependencies import get_current_user
from app.core.config import get_settings
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.users.models import Role, User, UserRole, UserStatus


def _guarded_urls() -> tuple[str, str]:
    settings = get_settings()
    runtime_url = settings.database_url
    owner_url = os.getenv("MIGRATION_DATABASE_URL")
    if owner_url is None:
        pytest.skip("A migration owner database URL is required")
    from tests.conftest import _guard_integration_database

    try:
        _guard_integration_database(runtime_url)
        _guard_integration_database(owner_url)
    except RuntimeError as error:
        pytest.skip(str(error))
    return runtime_url, owner_url


@dataclass(frozen=True)
class SeededUsers:
    actor_id: UUID
    target_id: UUID
    corrupted_admin_id: UUID
    admin_role_id: UUID
    member_role_id: UUID


class UserTransactionFixture:
    def __init__(self, runtime_url: str, owner_url: str) -> None:
        self.runtime_engine = create_engine(runtime_url, pool_size=4)
        self.owner_engine = create_engine(owner_url, pool_size=4)
        self.app: Any = None
        self.sessions: list[AuditSession] = []
        self.created_ids: set[UUID] = set()
        self.baseline_admin_count = 0
        try:
            self._assert_runtime_ready()
            self.app = create_app()
            self.seeded = self._seed()
            self.actor = self._actor_model()
            self.app.dependency_overrides[get_current_user] = lambda: self.actor
            self.app.dependency_overrides[get_db] = self._get_db
        except BaseException:
            self.cleanup()
            raise

    def _assert_runtime_ready(self) -> None:
        from tests.conftest import _assert_alembic_head

        with self.runtime_engine.connect() as connection:
            if connection.scalar(text("SELECT current_user")) != "openslate_runtime":
                raise RuntimeError("DATABASE_URL must connect as openslate_runtime")
            _assert_alembic_head(connection)

    def _seed(self) -> SeededUsers:
        actor_id, target_id, corrupted_id = uuid7(), uuid7(), uuid7()
        with self.owner_engine.begin() as connection:
            self.baseline_admin_count = int(
                connection.scalar(
                    text(
                        "SELECT count(*) FROM public.users u JOIN public.roles r ON r.id=u.role_id "
                        "WHERE u.status='active' AND NOT u.is_deleted AND r.role='admin' "
                        "AND NOT r.is_deleted AND (u.invitation_accepted_at IS NOT NULL OR "
                        "(u.invitation_sent_at IS NULL AND u.invitation_accepted_at IS NULL))"
                    )
                )
                or 0
            )
            roles = connection.execute(
                text(
                    "SELECT id, role FROM public.roles "
                    "WHERE role IN ('admin', 'member') AND is_deleted = false"
                )
            ).mappings()
            role_ids = {row["role"]: row["id"] for row in roles}
            if set(role_ids) != {"admin", "member"}:
                raise RuntimeError("The local database must contain active admin and member roles")
            admin_role_id = role_ids["admin"]
            member_role_id = role_ids["member"]
            corrupted_sent = datetime.now(UTC) - timedelta(minutes=5)
            rows = [
                (actor_id, admin_role_id, "active", None, None, False),
                (target_id, member_role_id, "active", None, None, False),
                (corrupted_id, admin_role_id, "active", corrupted_sent, None, False),
            ]
            for user_id, role_id, status, sent, accepted, deleted in rows:
                email = f"tx-{user_id}@example.com"
                connection.execute(
                    text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
                    {"id": user_id, "email": email},
                )
                connection.execute(
                    text(
                        "INSERT INTO public.users "
                        "(id, email, username, status, invitation_sent_at, "
                        "invitation_accepted_at, role_id, is_deleted, deleted_at) "
                        "VALUES (:id, :email, :username, :status, :sent, :accepted, "
                        ":role_id, :deleted, :deleted_at) ON CONFLICT (id) DO UPDATE SET "
                        "status = EXCLUDED.status, invitation_sent_at = "
                        "EXCLUDED.invitation_sent_at, "
                        "invitation_accepted_at = EXCLUDED.invitation_accepted_at, "
                        "role_id = EXCLUDED.role_id, is_deleted = EXCLUDED.is_deleted, "
                        "deleted_at = EXCLUDED.deleted_at"
                    ),
                    {
                        "id": user_id,
                        "email": email,
                        "username": f"tx_{user_id.hex[:12]}",
                        "status": status,
                        "sent": sent,
                        "accepted": accepted,
                        "role_id": role_id,
                        "deleted": deleted,
                        "deleted_at": datetime.now(UTC) if deleted else None,
                    },
                )
                self.created_ids.add(user_id)
        return SeededUsers(actor_id, target_id, corrupted_id, admin_role_id, member_role_id)

    def _actor_model(self) -> User:
        now = datetime.now(UTC)
        admin_role = Role(
            id=self.seeded.admin_role_id,
            role=UserRole.ADMIN.value,
            permissions={},
            created_at=now,
            updated_at=now,
            is_deleted=False,
        )
        return User(
            id=self.seeded.actor_id,
            email=f"tx-{self.seeded.actor_id}@example.com",
            username=f"tx_{self.seeded.actor_id.hex[:12]}",
            status=UserStatus.ACTIVE.value,
            role_id=self.seeded.admin_role_id,
            role=admin_role,
            created_at=now,
            updated_at=now,
            is_deleted=False,
        )

    def _get_db(self, request: Request) -> Generator[Session, None, None]:
        request_context = getattr(request.state, "request_context", None)
        context = AuditContext(
            performed_by=self.seeded.actor_id,
            request_id=getattr(request_context, "request_id", uuid7()),
            request_method=request.method,
            request_path=request.url.path,
        )
        database = AuditSession(bind=self.runtime_engine)
        database.info[AUDIT_CONTEXT_KEY] = context
        self.sessions.append(database)
        try:
            yield database
        finally:
            database.close()

    def client(self) -> TestClient:
        return TestClient(self.app)

    def set_target(
        self,
        *,
        status: UserStatus,
        deleted: bool = False,
        sent: datetime | None = None,
        accepted: datetime | None = None,
    ) -> None:
        with self.owner_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE public.users SET status = :status, is_deleted = :deleted, "
                    "deleted_at = :deleted_at, invitation_sent_at = :sent, "
                    "invitation_accepted_at = :accepted WHERE id = :id"
                ),
                {
                    "id": self.seeded.target_id,
                    "status": status.value,
                    "deleted": deleted,
                    "deleted_at": datetime.now(UTC) if deleted else None,
                    "sent": sent,
                    "accepted": accepted,
                },
            )

    def row(self, user_id: UUID) -> dict[str, Any]:
        statement = text(
            "SELECT status, is_deleted, username, invitation_sent_at, "
            "invitation_accepted_at, tokens_valid_after FROM public.users WHERE id = :id"
        )
        with self.owner_engine.connect() as connection:
            return dict(connection.execute(statement, {"id": user_id}).mappings().one())

    def event_outcomes(self, subject_id: UUID) -> list[str]:
        statement = text(
            "SELECT outcome FROM public.security_events "
            "WHERE actor_id = :actor_id AND subject_id = :subject_id "
            "ORDER BY occurred_at, id"
        )
        with self.owner_engine.connect() as connection:
            return list(
                connection.execute(
                    statement,
                    {"actor_id": self.seeded.actor_id, "subject_id": subject_id},
                ).scalars()
            )

    def drift_target(self, user_id: UUID | None = None) -> None:
        with self.owner_engine.begin() as connection:
            connection.execute(
                text("UPDATE public.users SET username = :username WHERE id = :id"),
                {
                    "id": user_id or self.seeded.target_id,
                    "username": f"drift_{uuid7().hex[:12]}",
                },
            )

    def provider_callback(
        self,
        monkeypatch: pytest.MonkeyPatch,
        name: str,
        *,
        error: BaseException | None = None,
        drift: bool = False,
    ) -> Mock:
        def invoke(user_id: UUID) -> None:
            session = self.sessions[-1]
            assert session.expire_on_commit is True
            assert session.in_transaction() is False
            if drift:
                self.drift_target(user_id)
            if error is not None:
                raise error

        callback = Mock(side_effect=invoke)
        monkeypatch.setattr(account_operations, name, callback)
        provider = Mock(disable_user=callback, enable_user=callback)
        monkeypatch.setattr(reconciliation, "SupabaseAdminClient", lambda: provider)
        return callback

    def cleanup(self) -> None:
        try:
            with self.owner_engine.begin() as connection:
                for user_id in self.created_ids:
                    connection.execute(
                        text(
                            "DELETE FROM public.audit_logs "
                            "WHERE entity_id = :id OR performed_by = :id"
                        ),
                        {"id": user_id},
                    )
                    connection.execute(
                        text(
                            "DELETE FROM public.security_events "
                            "WHERE actor_id = :id OR subject_id = :id"
                        ),
                        {"id": user_id},
                    )
                    connection.execute(
                        text("DELETE FROM auth.users WHERE id = :id"),
                        {"id": user_id},
                    )
        finally:
            for session in self.sessions:
                session.close()
            if self.app is not None:
                self.app.dependency_overrides.clear()
            self.runtime_engine.dispose()
            self.owner_engine.dispose()


@pytest.fixture
def user_api_fixture() -> Generator[UserTransactionFixture, None, None]:
    runtime_url, owner_url = _guarded_urls()
    fixture = UserTransactionFixture(runtime_url, owner_url)
    try:
        yield fixture
    finally:
        fixture.cleanup()
