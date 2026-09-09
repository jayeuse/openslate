from threading import Barrier, Event, Lock, Thread
from typing import Any
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import event, text
from sqlalchemy.orm import Session

import app.systems.users.account_operations as users_router
import app.systems.users.roles_router as roles_router
from app.systems.users.models import UserStatus
from app.systems.users.schemas import UserUpdate
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

def test_concurrent_admin_demotions_serialize_on_the_exact_admin_role(
    admin_fixture: _AdminFixture,  # noqa: F811
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
    ), [type(result).__name__ for result in results]
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
    admin_fixture: _AdminFixture,  # noqa: F811
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
                    results[1] = roles_router.delete_role(
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
