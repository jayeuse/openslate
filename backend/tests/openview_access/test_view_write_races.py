"""A view change decides on the row and the access it reads after the module lock.

The route reads the view once without a lock, then takes the module lock in
``_active_module`` and reads the view again. Each race commits a competing change
on its own connection at that point, after the first read and before the lock, and
proves that the locked read sees it.
"""

import os
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.openview.views.router as views_router
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.users.models import User, UserRole
from app.systems.openview.views.models import SavedView
from app.systems.openview.views.schemas import ViewUpdate
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.access.access_race_support import add_race_user
from tests.conftest import guarded_create_engine

pytestmark = pytest.mark.integration


@dataclass(frozen=True)
class _Seed:
    department: UUID
    module: UUID
    manager: UUID
    group: UUID
    grant: UUID
    view: UUID


@pytest.fixture
def seed() -> Iterator[tuple[_Seed, Engine, Engine]]:
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=2)
    with Session(owner) as db:
        department = Department(department_name=f"View race {uuid7().hex}")
        db.add(department)
        db.flush()
        module = Module(department_id=department.id, module_name=f"View race {uuid7().hex}")
        db.add(module)
        db.flush()
        manager = add_race_user(db, "view-race", UserRole.MEMBER.value)
        group = Group(name=f"View race {uuid7().hex}")
        db.add(group)
        db.flush()
        db.add(GroupMember(group_id=group.id, user_id=manager))
        grant = GroupAccess(
            group_id=group.id, department_id=department.id, level=AccessLevel.MANAGE.value
        )
        view = SavedView(module_id=module.id, name="Original", definition={})
        db.add_all([grant, view])
        db.flush()
        data = _Seed(department.id, module.id, manager, group.id, grant.id, view.id)
        db.commit()
    try:
        yield data, runtime, owner
    finally:
        with Session(owner) as db:
            db.execute(delete(SavedView).where(SavedView.module_id == data.module))
            db.execute(delete(GroupMember).where(GroupMember.group_id == data.group))
            db.execute(delete(GroupAccess).where(GroupAccess.group_id == data.group))
            db.execute(delete(Group).where(Group.id == data.group))
            db.execute(delete(User).where(User.id == data.manager))
            db.execute(delete(Module).where(Module.id == data.module))
            db.execute(delete(Department).where(Department.id == data.department))
            db.commit()
        runtime.dispose()
        owner.dispose()


def _commit_before_the_module_lock(
    monkeypatch: pytest.MonkeyPatch, competing_change: Callable[[], None]
) -> None:
    """Run ``competing_change`` once, after the route's first read and before its lock."""

    original = views_router._active_module
    fired: list[bool] = []

    def change_then_lock(db: Session, module_id: UUID) -> Module:
        if not fired:
            fired.append(True)
            competing_change()
        return original(db, module_id)

    monkeypatch.setattr(views_router, "_active_module", change_then_lock)


def _rename(engine: Engine, data: _Seed, name: str) -> HTTPException | None:
    """PATCH the view as the manager in its own session; return the refusal, if any."""

    with Session(engine) as db:
        manager = db.get(User, data.manager)
        assert manager is not None
        try:
            views_router.update_view(data.view, ViewUpdate(revision=1, name=name), manager, db)
        except HTTPException as error:
            db.rollback()
            return error
        return None


def _stored(engine: Engine, data: _Seed) -> tuple[str, int]:
    with Session(engine) as db:
        row = db.execute(
            select(SavedView.name, SavedView.revision).where(SavedView.id == data.view)
        ).one()
        return row.name, row.revision


def test_a_rename_committed_before_the_lock_makes_the_slower_rename_stale(
    seed: tuple[_Seed, Engine, Engine], monkeypatch: pytest.MonkeyPatch
) -> None:
    data, runtime, _ = seed
    _commit_before_the_module_lock(
        monkeypatch, lambda: _assert_accepted(_rename(runtime, data, "Renamed first"))
    )

    refusal = _rename(runtime, data, "Renamed second")

    assert refusal is not None
    assert refusal.status_code == 409
    assert refusal.detail == {
        "code": "stale_revision",
        "message": "View changed; reload before saving",
        "current_revision": 2,
    }
    assert _stored(runtime, data) == ("Renamed first", 2)


def _assert_accepted(refusal: HTTPException | None) -> None:
    assert refusal is None, refusal


def test_a_downgrade_to_read_committed_before_the_lock_refuses_the_change(
    seed: tuple[_Seed, Engine, Engine], monkeypatch: pytest.MonkeyPatch
) -> None:
    data, runtime, owner = seed

    def downgrade() -> None:
        with Session(owner) as db:
            grant = db.get(GroupAccess, data.grant)
            assert grant is not None
            grant.level = AccessLevel.READ.value
            db.commit()

    _commit_before_the_module_lock(monkeypatch, downgrade)

    refusal = _rename(runtime, data, "Renamed after downgrade")

    # The manager still reads the module, so the view stays visible; the change is refused.
    assert refusal is not None
    assert refusal.status_code == 403
    assert _stored(runtime, data) == ("Original", 1)
