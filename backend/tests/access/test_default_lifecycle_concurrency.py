"""Default references stay valid across concurrent lifecycle operations."""

import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.roles_router as roles_router
import app.systems.sandbox.lifecycle.execution as lifecycle_execution
from app.systems.access.policy.models import AccessDefaultDepartment
from app.systems.access.policy.service import get_defaults
from app.systems.access.users.models import Role, User
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.exceptions import LifecyclePlanDriftError
from app.systems.sandbox.lifecycle.planner import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleOperation, LifecycleTargetType
from tests.conftest import guarded_create_engine

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("TEST_DATABASE_URL") is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


def test_role_delete_waits_for_in_flight_default_change_and_preserves_invites(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=3)
    role_id = uuid7()
    with Session(engine) as db:
        original_role_id = get_defaults(db, lock=True).default_role_id
        db.add(Role(id=role_id, role=f"concurrent-{uuid7().hex}", permissions={}))
        db.commit()

    locked = Event()
    release = Event()
    deleting = Event()
    deleted = Event()
    original_get_defaults = roles_router.get_defaults
    monkeypatch.setattr(roles_router, "require_fresh_exact_admin", lambda *_args: None)

    def observe_delete_defaults(db: Session, *, lock: bool = False):
        deleting.set()
        return original_get_defaults(db, lock=lock)

    monkeypatch.setattr(roles_router, "get_defaults", observe_delete_defaults)

    def change_default() -> None:
        with Session(engine) as db:
            defaults = get_defaults(db, lock=True)
            defaults.default_role_id = role_id
            db.flush()
            locked.set()
            assert release.wait(timeout=5)
            db.commit()

    def delete_role() -> int:
        with Session(engine) as db:
            try:
                roles_router.delete_role(role_id, User(id=uuid7()), db)
            except HTTPException as error:
                db.rollback()
                return error.status_code
            finally:
                deleted.set()
        return 204

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            updating = executor.submit(change_default)
            assert locked.wait(timeout=5)
            deleting_future = executor.submit(delete_role)
            assert deleting.wait(timeout=5)
            assert not deleted.wait(timeout=0.2)
            release.set()
            updating.result(timeout=5)
            assert deleting_future.result(timeout=5) == 409
        with Session(engine) as db:
            assert get_defaults(db).default_role_id == role_id
            assert db.get(Role, role_id).is_deleted is False
    finally:
        release.set()
        with Session(engine) as db:
            defaults = get_defaults(db, lock=True)
            defaults.default_role_id = original_role_id
            role = db.get(Role, role_id)
            if role is not None:
                db.delete(role)
            db.commit()
        engine.dispose()


def test_department_close_waits_for_default_change_and_rejects_stale_plan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=3)
    department_id = uuid7()
    with Session(engine) as db:
        db.add(Department(id=department_id, department_name=f"Concurrent {uuid7().hex}"))
        db.commit()
        plan = plan_lifecycle(
            db,
            LifecycleTargetType.DEPARTMENT,
            department_id,
            LifecycleOperation.CLOSE,
            None,
        )

    locked = Event()
    release = Event()
    closing = Event()
    closed = Event()
    original_get_defaults = lifecycle_execution.get_defaults

    def observe_close_defaults(db: Session, *, lock: bool = False):
        closing.set()
        return original_get_defaults(db, lock=lock)

    monkeypatch.setattr(lifecycle_execution, "get_defaults", observe_close_defaults)

    def change_default() -> None:
        with Session(engine) as db:
            defaults = get_defaults(db, lock=True)
            db.add(
                AccessDefaultDepartment(
                    policy_defaults_id=defaults.id, department_id=department_id
                )
            )
            db.flush()
            locked.set()
            assert release.wait(timeout=5)
            db.commit()

    def close_department() -> type[Exception] | None:
        with Session(engine) as db:
            try:
                lifecycle_execution.close_lifecycle(
                    db, LifecycleTargetType.DEPARTMENT, department_id, None, plan=plan
                )
            except LifecyclePlanDriftError as error:
                return type(error)
            finally:
                closed.set()
        return None

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            updating = executor.submit(change_default)
            assert locked.wait(timeout=5)
            closing_future = executor.submit(close_department)
            assert closing.wait(timeout=5)
            assert not closed.wait(timeout=0.2)
            release.set()
            updating.result(timeout=5)
            assert closing_future.result(timeout=5) is LifecyclePlanDriftError
        with Session(engine) as db:
            assert db.get(Department, department_id).is_deleted is False
            assert db.scalar(
                select(AccessDefaultDepartment).where(
                    AccessDefaultDepartment.department_id == department_id
                )
            ) is not None
    finally:
        release.set()
        with Session(engine) as db:
            link = db.scalar(
                select(AccessDefaultDepartment).where(
                    AccessDefaultDepartment.department_id == department_id
                )
            )
            if link is not None:
                db.delete(link)
            department = db.get(Department, department_id)
            if department is not None:
                db.delete(department)
            db.commit()
        engine.dispose()
