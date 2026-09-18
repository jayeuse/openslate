from threading import Barrier, Event, Lock, Thread, current_thread
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import event, text
from uuid6 import uuid7

import app.systems.access.users.service as users_service
from app.core.database.session import AuditSession
from app.core.integrations.supabase import SupabaseAuthUser
from app.systems.access.users.acceptance import accept_verified_invitation
from app.systems.access.users.models import User
from app.systems.access.users.schemas import InvitationCreate
from app.systems.access.users.service import InvitationError
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from tests.users.user_administration_support import (  # noqa: F401,F811
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


def test_bootstrap_finalization_locks_admin_before_member_when_acceptance_interleaves(
    admin_fixture: _AdminFixture,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bootstrap and acceptance share the admin-to-member lock order.

    The listener pauses only the old member-first finalization after its third
    role lock.  Acceptance then holds the admin role before trying the member
    role, which exposes the former PostgreSQL deadlock without a timing race.
    """

    assert admin_fixture.admin_role_id is not None
    assert admin_fixture.member_role_id is not None
    target_id = uuid7()
    email = f"bootstrap-accept-{target_id}@example.com"
    finalization_start = Barrier(2)
    trigger_created = Event()
    final_role_lock_observed = Event()
    acceptance_admin_locked = Event()
    listener_lock = Lock()
    bootstrap_role_locks = 0
    finalization_first_role: str | None = None
    events: list[SecurityEventIngestRequest] = []
    events_lock = Lock()
    results: list[object | None] = [None, None]

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

    def create_trigger_profile(user_id: UUID, profile_email: str) -> None:
        with admin_fixture.engine.begin() as connection:
            connection.execute(
                text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
                {"id": user_id, "email": profile_email},
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
                        "email": profile_email,
                        "username": f"auth_{user_id.hex}",
                        "role_id": admin_fixture.member_role_id,
                    },
                )

    class _Client:
        def invite_user(self, profile_email: str, _username: str) -> SupabaseAuthUser:
            create_trigger_profile(target_id, profile_email)
            trigger_created.set()
            finalization_start.wait(timeout=10)
            return SupabaseAuthUser(target_id, profile_email)

    def role_name(parameters: Any) -> str | None:
        values = parameters.values() if isinstance(parameters, dict) else parameters
        for value in values:
            normalized = getattr(value, "value", value)
            if normalized in {"admin", "member"}:
                return str(normalized)
        return None

    def after_cursor_execute(
        _connection: Any,
        _cursor: Any,
        statement: str,
        parameters: Any,
        _context: Any,
        _executemany: Any,
    ) -> None:
        nonlocal bootstrap_role_locks, finalization_first_role
        normalized = statement.casefold()
        if "for update" not in normalized or "from roles" not in normalized:
            return
        thread_name = current_thread().name
        if thread_name == "bootstrap":
            with listener_lock:
                bootstrap_role_locks += 1
                is_finalization_first_lock = bootstrap_role_locks == 3
            if not is_finalization_first_lock:
                return
            finalization_first_role = role_name(parameters)
            final_role_lock_observed.set()
            if finalization_first_role == "member":
                assert acceptance_admin_locked.wait(timeout=10), (
                    "acceptance did not acquire the administrator role after "
                    "bootstrap locked the member role"
                )
        elif thread_name == "acceptance":
            acceptance_admin_locked.set()

    def record_event(payload: SecurityEventIngestRequest) -> None:
        with events_lock:
            events.append(payload)

    monkeypatch.setattr(users_service, "append_committed_security_event", record_event)
    event.listen(admin_fixture.engine, "after_cursor_execute", after_cursor_execute)

    def bootstrap() -> None:
        connection = admin_fixture.engine.connect()
        database = AuditSession(bind=connection, expire_on_commit=False)
        database.info[AUDIT_CONTEXT_KEY] = AuditContext(
            request_id=uuid7(),
            request_method="POST",
            request_path="/bootstrap",
        )
        try:
            results[0] = users_service.invite_user(
                database,
                InvitationCreate(
                    email=email,
                    username="bootstrap-accept",
                    role_id=admin_fixture.admin_role_id,
                ),
                client=_Client(),
                bootstrap=True,
            )
        except BaseException as error:
            results[0] = error
            database.rollback()
        finally:
            database.close()
            connection.close()

    def accept() -> None:
        connection = admin_fixture.engine.connect()
        database = AuditSession(bind=connection, expire_on_commit=False)
        database.info[AUDIT_CONTEXT_KEY] = AuditContext(
            request_id=uuid7(),
            request_method="POST",
            request_path="/api/invitations/accept",
        )
        try:
            assert trigger_created.wait(timeout=10), "bootstrap did not create the pending profile"
            finalization_start.wait(timeout=10)
            assert final_role_lock_observed.wait(timeout=10), (
                "bootstrap did not start local invitation finalization"
            )
            results[1] = accept_verified_invitation(
                database,
                target_id,
                verified_email=email,
                verified_identity=target_id,
            )
        except BaseException as error:
            results[1] = error
            database.rollback()
        finally:
            database.close()
            connection.close()

    threads = [
        Thread(target=bootstrap, name="bootstrap"),
        Thread(target=accept, name="acceptance"),
    ]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
            assert not thread.is_alive(), "the coordinated invitation flow did not finish"

        assert all(isinstance(result, User) for result in results), [
            type(result).__name__ for result in results
        ]
        assert isinstance(results[0], User)
        assert isinstance(results[1], User)
        assert finalization_first_role == "admin"
        assert results[0].status == "pending"
        assert results[1].status == "active"
        with events_lock:
            outcomes = [payload.outcome.value for payload in events]
        assert outcomes.count("partial") == 0
        assert outcomes.count("failure") == 0
        with admin_fixture.engine.connect() as connection:
            admin_assignments = connection.scalar(
                text(
                    "SELECT count(*) FROM public.users "
                    "WHERE role_id = :admin_role_id AND is_deleted = false"
                ),
                {"admin_role_id": admin_fixture.admin_role_id},
            )
            target = connection.execute(
                text(
                    "SELECT role_id, status, is_deleted, invitation_sent_at "
                    "FROM public.users WHERE id = :id"
                ),
                {"id": target_id},
            ).mappings().one()
        assert admin_assignments == 1
        assert target["role_id"] == admin_fixture.admin_role_id
        assert target["status"] == "active"
        assert not target["is_deleted"]
        assert target["invitation_sent_at"] is not None
    finally:
        event.remove(admin_fixture.engine, "after_cursor_execute", after_cursor_execute)
        with admin_fixture.engine.begin() as connection:
            connection.execute(text("DELETE FROM auth.users WHERE id = :id"), {"id": target_id})
