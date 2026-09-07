import os
from collections.abc import Generator
from threading import Barrier, Event, Lock, Thread
from typing import Any
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.users.router as users_router
import app.systems.users.service as users_service
from app.core.database.session import AuditSession
from app.core.integrations.supabase import SupabaseAuthUser
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.audit.schemas import SecurityEventIngestRequest
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import User, UserStatus
from app.systems.users.schemas import UserUpdate
from app.systems.users.service import InvitationError

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


def _guard_database(database_url: str) -> None:
    from tests.conftest import _guard_integration_database

    _guard_integration_database(database_url)


def _owner_database_url() -> str:
    for variable in ("MIGRATION_DATABASE_URL", "TEST_DATABASE_URL"):
        database_url = os.getenv(variable)
        if database_url is not None:
            _guard_database(database_url)
            return database_url
    raise RuntimeError("A guarded PostgreSQL URL is required")


class _AdminFixture:
    def __init__(self) -> None:
        self.engine = create_engine(_owner_database_url(), pool_size=5)
        self.admin_role_id: UUID | None = None
        self.member_role_id: UUID | None = None
        self.assignment_role_id: UUID = uuid7()
        self.created_role_ids: list[UUID] = []
        self.user_ids: list[UUID] = [uuid7(), uuid7(), uuid7(), uuid7()]
        self.admin_snapshots: list[dict[str, Any]] = []

    def seed(self) -> None:
        admin_id, target_one, target_two, assignment_user = self.user_ids
        with self.engine.begin() as connection:
            roles = connection.execute(
                text(
                    "SELECT id, role FROM public.roles "
                    "WHERE role IN ('admin', 'member') AND is_deleted = false"
                )
            ).mappings()
            role_ids = {row["role"]: row["id"] for row in roles}
            for role_name in ("admin", "member"):
                role_id = role_ids.get(role_name)
                if role_id is None:
                    role_id = uuid7()
                    connection.execute(
                        text(
                            "INSERT INTO public.roles (id, role, permissions) "
                            "VALUES (:id, :role, '{}'::jsonb)"
                        ),
                        {"id": role_id, "role": role_name},
                    )
                    self.created_role_ids.append(role_id)
                if role_name == "admin":
                    self.admin_role_id = role_id
                else:
                    self.member_role_id = role_id

            connection.execute(
                text(
                    "INSERT INTO public.roles (id, role, permissions) "
                    "VALUES (:id, :role, '{}'::jsonb)"
                ),
                {"id": self.assignment_role_id, "role": f"red-lock-role-{uuid7().hex[:12]}"},
            )
            self.created_role_ids.append(self.assignment_role_id)

            self.admin_snapshots = [
                dict(row)
                for row in connection.execute(
                    text(
                        "SELECT id, status, is_deleted, deleted_at, role_id "
                        "FROM public.users WHERE role_id = :role_id"
                    ),
                    {"role_id": self.admin_role_id},
                ).mappings()
            ]
            connection.execute(
                text(
                    "UPDATE public.users SET status = 'disabled' "
                    "WHERE role_id = :role_id AND is_deleted = false"
                ),
                {"role_id": self.admin_role_id},
            )

            for user_id, email in (
                (admin_id, f"admin-{admin_id}@example.com"),
                (target_one, f"target-one-{target_one}@example.com"),
                (target_two, f"target-two-{target_two}@example.com"),
                (assignment_user, f"assignment-{assignment_user}@example.com"),
            ):
                connection.execute(
                    text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
                    {"id": user_id, "email": email},
                )
            connection.execute(
                text(
                    "UPDATE public.users SET status = 'active', is_deleted = false, "
                    "deleted_at = NULL, role_id = :role_id "
                    "WHERE id IN (:admin_id, :target_one, :target_two)"
                ),
                {
                    "role_id": self.admin_role_id,
                    "admin_id": admin_id,
                    "target_one": target_one,
                    "target_two": target_two,
                },
            )
            connection.execute(
                text("UPDATE public.users SET role_id = :role_id WHERE id = :user_id"),
                {"role_id": self.member_role_id, "user_id": self.user_ids[3]},
            )

    def cleanup(self) -> None:
        try:
            with self.engine.begin() as connection:
                for row in self.admin_snapshots:
                    connection.execute(
                        text(
                            "UPDATE public.users SET status = :status, is_deleted = :is_deleted, "
                            "deleted_at = :deleted_at, role_id = :role_id WHERE id = :id"
                        ),
                        row,
                    )
                connection.execute(
                    text(
                        "DELETE FROM auth.users "
                        "WHERE id IN (:admin_id, :target_one, :target_two, :assignment_user)"
                    ),
                    {
                        "admin_id": self.user_ids[0],
                        "target_one": self.user_ids[1],
                        "target_two": self.user_ids[2],
                        "assignment_user": self.user_ids[3],
                    },
                )
                for role_id in self.created_role_ids:
                    connection.execute(
                        text("DELETE FROM public.roles WHERE id = :id"),
                        {"id": role_id},
                    )
        finally:
            self.engine.dispose()


@pytest.fixture
def admin_fixture() -> Generator[_AdminFixture, None, None]:
    fixture = _AdminFixture()
    try:
        fixture.seed()
        yield fixture
    finally:
        fixture.cleanup()


def test_concurrent_admin_demotions_serialize_on_the_exact_admin_role(
    admin_fixture: _AdminFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert admin_fixture.admin_role_id is not None
    monkeypatch.setattr(users_router, "_disable_auth_user", lambda _user_id: None)

    start = Barrier(2)
    first_role_lock = Event()
    release_first_role_lock = Event()
    listener_lock = Lock()
    observed_role_locks = 0

    def after_cursor_execute(
        _connection: Any,
        _cursor: Any,
        statement: str,
        _parameters: Any,
        _context: Any,
        _executemany: bool,
    ) -> None:
        nonlocal observed_role_locks
        normalized = statement.casefold()
        if "for update" not in normalized or "from roles" not in normalized:
            return
        with listener_lock:
            observed_role_locks += 1
            is_first = observed_role_locks == 1
        if is_first:
            first_role_lock.set()
            release_first_role_lock.wait(timeout=10)

    event.listen(admin_fixture.engine, "after_cursor_execute", after_cursor_execute)
    results: list[object | None] = [None, None]

    def demote(index: int, target_id: UUID) -> None:
        try:
            with admin_fixture.engine.connect() as connection:
                database = Session(bind=connection, expire_on_commit=False)
                try:
                    actor = database.get(users_router.User, admin_fixture.user_ids[0])
                    start.wait(timeout=10)
                    results[index] = users_router.update_user(
                        target_id,
                        UserUpdate(status=UserStatus.DISABLED),
                        actor,
                        database,
                    )
                except BaseException as error:
                    results[index] = error
                    database.rollback()
                finally:
                    database.close()
        except BaseException as error:
            results[index] = error

    threads = [
        Thread(target=demote, args=(0, admin_fixture.user_ids[1])),
        Thread(target=demote, args=(1, admin_fixture.user_ids[2])),
    ]
    for thread in threads:
        thread.start()

    assert first_role_lock.wait(timeout=10), "the API did not lock the exact admin role row"
    release_first_role_lock.set()
    for thread in threads:
        thread.join(timeout=10)
        assert not thread.is_alive(), "the concurrent API operation did not finish"

    assert observed_role_locks >= 2
    assert (
        sum(result is not None and not isinstance(result, BaseException) for result in results) == 2
    )
    failures = [result for result in results if isinstance(result, HTTPException)]
    assert not failures

    with admin_fixture.engine.connect() as connection:
        active_admins = connection.scalar(
            text(
                "SELECT count(*) FROM public.users AS u "
                "JOIN public.roles AS r ON r.id = u.role_id "
                "WHERE u.status = 'active' AND u.is_deleted = false "
                "AND r.role = 'admin' AND r.is_deleted = false"
            )
        )
    assert active_admins >= 1


def test_role_assignment_and_archive_serialize_on_the_same_role_row(
    admin_fixture: _AdminFixture,
) -> None:
    start = Barrier(2)
    first_role_lock = Event()
    release_first_role_lock = Event()
    listener_lock = Lock()
    observed_role_locks = 0

    def after_cursor_execute(
        _connection: Any,
        _cursor: Any,
        statement: str,
        _parameters: Any,
        _context: Any,
        _executemany: bool,
    ) -> None:
        nonlocal observed_role_locks
        normalized = statement.casefold()
        if "for update" not in normalized or "from roles" not in normalized:
            return
        with listener_lock:
            observed_role_locks += 1
            is_first = observed_role_locks == 1
        if is_first:
            first_role_lock.set()
            release_first_role_lock.wait(timeout=10)

    event.listen(admin_fixture.engine, "after_cursor_execute", after_cursor_execute)
    results: list[object | None] = [None, None]

    def assign() -> None:
        try:
            with admin_fixture.engine.connect() as connection:
                database = Session(bind=connection, expire_on_commit=False)
                try:
                    actor = database.get(users_router.User, admin_fixture.user_ids[0])
                    start.wait(timeout=10)
                    results[0] = users_router.update_user(
                        admin_fixture.user_ids[3],
                        UserUpdate(role_id=admin_fixture.assignment_role_id),
                        actor,
                        database,
                    )
                except BaseException as error:
                    results[0] = error
                    database.rollback()
                finally:
                    database.close()
        except BaseException as error:
            results[0] = error

    def archive() -> None:
        try:
            with admin_fixture.engine.connect() as connection:
                database = Session(bind=connection, expire_on_commit=False)
                try:
                    actor = database.get(users_router.User, admin_fixture.user_ids[0])
                    start.wait(timeout=10)
                    results[1] = users_router.delete_role(
                        admin_fixture.assignment_role_id,
                        actor,
                        database,
                    )
                except BaseException as error:
                    results[1] = error
                    database.rollback()
                finally:
                    database.close()
        except BaseException as error:
            results[1] = error

    threads = [Thread(target=assign), Thread(target=archive)]
    for thread in threads:
        thread.start()

    assert first_role_lock.wait(timeout=10), "assignment/archive did not lock their shared role row"
    release_first_role_lock.set()
    for thread in threads:
        thread.join(timeout=10)
        assert not thread.is_alive(), "the concurrent role operation did not finish"

    assert observed_role_locks >= 2
    assert (
        sum(result is not None and not isinstance(result, BaseException) for result in results) == 1
    )
    failures = [result for result in results if isinstance(result, HTTPException)]
    assert len(failures) == 1
    assert failures[0].status_code == 409

    with admin_fixture.engine.connect() as connection:
        role_deleted, assigned_role_id = connection.execute(
            text(
                "SELECT r.is_deleted, u.role_id "
                "FROM public.roles AS r "
                "JOIN public.users AS u ON u.id = :user_id "
                "WHERE r.id = :role_id"
            ),
            {"role_id": admin_fixture.assignment_role_id, "user_id": admin_fixture.user_ids[3]},
        ).one()
    assert not (role_deleted and assigned_role_id == admin_fixture.assignment_role_id)


def test_concurrent_bootstrap_invitations_leave_only_one_admin_reservation(
    admin_fixture: _AdminFixture,
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
