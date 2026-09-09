from threading import Barrier, Lock, Thread
from uuid import UUID

import pytest
from sqlalchemy import text
from uuid6 import uuid7

import app.systems.users.service as users_service
from app.core.database.session import AuditSession
from app.core.integrations.supabase import SupabaseAuthUser
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.audit.schemas import SecurityEventIngestRequest
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import User
from app.systems.users.service import InvitationError
from tests.user_administration_support import (  # noqa: F401,F811
    TEST_DATABASE_URL,
    _AdminFixture,
    admin_fixture,
)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]

def test_concurrent_bootstrap_invitations_leave_only_one_admin_reservation(
    admin_fixture: _AdminFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert admin_fixture.admin_role_id is not None
    assert admin_fixture.member_role_id is not None
    target_ids = [uuid7(), uuid7()]
    emails = [f"bootstrap-{target_id}@example.com" for target_id in target_ids]
    barrier = Barrier(2)
    events: list[SecurityEventIngestRequest] = []
    events_lock = Lock()

    with admin_fixture.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE public.users SET role_id = :member_role_id "
                "WHERE role_id = :admin_role_id"
            ),
            {
                "member_role_id": admin_fixture.member_role_id,
                "admin_role_id": admin_fixture.admin_role_id,
            },
        )

    def create_trigger_profile(user_id: UUID, email: str) -> None:
        with admin_fixture.engine.begin() as connection:
            connection.execute(
                text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
                {"id": user_id, "email": email},
            )
            if connection.scalar(
                text("SELECT id FROM public.users WHERE id = :id"),
                {"id": user_id},
            ) is None:
                connection.execute(
                    text(
                        "INSERT INTO public.users "
                        "(id, email, username, status, role_id, is_deleted) "
                        "VALUES (:id, :email, :username, 'pending', :role_id, false)"
                    ),
                    {
                        "id": user_id,
                        "email": email,
                        "username": f"auth_{user_id.hex}",
                        "role_id": admin_fixture.member_role_id,
                    },
                )
            else:
                connection.execute(
                    text(
                        "UPDATE public.users SET email = :email, username = :username, "
                        "status = 'pending', role_id = :role_id, is_deleted = false, "
                        "deleted_at = NULL, invitation_sent_at = NULL, "
                        "invitation_accepted_at = NULL WHERE id = :id"
                    ),
                    {
                        "id": user_id,
                        "email": email,
                        "username": f"auth_{user_id.hex}",
                        "role_id": admin_fixture.member_role_id,
                    },
                )

    class _Client:
        def __init__(self, user_id: UUID, email: str) -> None:
            self.user_id = user_id
            self.email = email

        def invite_user(self, email: str, _username: str) -> SupabaseAuthUser:
            create_trigger_profile(self.user_id, email)
            barrier.wait(timeout=10)
            return SupabaseAuthUser(self.user_id, self.email)

    def record_event(payload: SecurityEventIngestRequest) -> None:
        with events_lock:
            events.append(payload)

    monkeypatch.setattr(users_service, "append_committed_security_event", record_event)
    results: list[object | None] = [None, None]

    def invite(index: int) -> None:
        connection = admin_fixture.engine.connect()
        database = AuditSession(bind=connection, expire_on_commit=False)
        database.info[AUDIT_CONTEXT_KEY] = AuditContext(
            request_id=uuid7(),
            request_method="POST",
            request_path="/bootstrap",
        )
        try:
            results[index] = users_service.invite_user(
                database,
                InvitationCreate(
                    email=emails[index],
                    username=f"bootstrap-{index}",
                    role_id=admin_fixture.admin_role_id,
                ),
                client=_Client(target_ids[index], emails[index]),
                bootstrap=True,
            )
        except BaseException as error:
            results[index] = error
            database.rollback()
        finally:
            database.close()
            connection.close()

    threads = [Thread(target=invite, args=(index,)) for index in range(2)]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
            assert not thread.is_alive(), "the concurrent bootstrap invitation did not finish"

        assert sum(isinstance(result, User) for result in results) == 1
        assert sum(isinstance(result, InvitationError) for result in results) == 1

        with admin_fixture.engine.connect() as connection:
            assignments = connection.execute(
                text(
                    "SELECT id, role_id, status, is_deleted, invitation_sent_at "
                    "FROM public.users WHERE id IN (:first_id, :second_id)"
                ),
                {"first_id": target_ids[0], "second_id": target_ids[1]},
            ).mappings().all()
        assert sum(
            row["role_id"] == admin_fixture.admin_role_id and not row["is_deleted"]
            for row in assignments
        ) == 1
        assert sum(row["role_id"] == admin_fixture.member_role_id for row in assignments) == 1
        assert sum(row["invitation_sent_at"] is not None for row in assignments) == 1

        with events_lock:
            grouped_events: dict[UUID, list[str]] = {}
            for event_payload in events:
                grouped_events.setdefault(event_payload.operation_id, []).append(
                    event_payload.outcome.value
                )
        assert sorted(grouped_events.values()) == [["attempt", "partial"], ["attempt", "success"]]
    finally:
        with admin_fixture.engine.begin() as connection:
            connection.execute(
                text("DELETE FROM auth.users WHERE id IN (:first_id, :second_id)"),
                {"first_id": target_ids[0], "second_id": target_ids[1]},
            )
