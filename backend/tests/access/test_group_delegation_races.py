"""A manager's member change cannot commit on a stale decision (slice 3d, D14).

Each race pauses one transaction at a known point and proves that the other
waits for it, so the manager's decision and the concurrent change serialize.
"""

import os
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from threading import Event
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.policy.delegation as delegation
import app.systems.access.policy.service as policy_service
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.policy.schemas import GroupAccessEntry
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.sandbox.departments.models import Department
from tests.conftest import guarded_create_engine

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("TEST_DATABASE_URL") is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


@dataclass(frozen=True)
class _Seed:
    inventory: UUID
    finance: UUID
    admin: UUID
    manager: UUID
    member: UUID
    manager_group: UUID
    target: UUID


def _user(db: Session, role: str) -> UUID:
    user = User(
        email=f"race-{uuid7().hex}@example.com",
        username=f"race_{uuid7().hex[:20]}",
        role=role,
        status=UserStatus.ACTIVE.value,
    )
    db.add(user)
    db.flush()
    return user.id


def _group(db: Session, department_id: UUID, level: AccessLevel, member_id: UUID) -> UUID:
    group = Group(name=f"Race {uuid7().hex}")
    db.add(group)
    db.flush()
    db.add(GroupMember(group_id=group.id, user_id=member_id))
    db.add(GroupAccess(group_id=group.id, department_id=department_id, level=level.value))
    db.flush()
    return group.id


@pytest.fixture
def seed() -> Iterator[tuple[_Seed, Engine]]:
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=3)
    with Session(owner) as db:
        inventory = Department(department_name=f"Race inventory {uuid7().hex}")
        finance = Department(department_name=f"Race finance {uuid7().hex}")
        db.add_all([inventory, finance])
        db.flush()
        manager = _user(db, UserRole.MEMBER.value)
        member = _user(db, UserRole.MEMBER.value)
        data = _Seed(
            inventory=inventory.id,
            finance=finance.id,
            admin=_user(db, UserRole.ADMIN.value),
            manager=manager,
            member=member,
            manager_group=_group(db, inventory.id, AccessLevel.MANAGE, manager),
            target=_group(db, inventory.id, AccessLevel.READ, member),
        )
        db.commit()
    try:
        yield data, runtime
    finally:
        with Session(owner) as db:
            groups = (data.manager_group, data.target)
            users = (data.admin, data.manager, data.member)
            db.execute(delete(GroupMember).where(GroupMember.group_id.in_(groups)))
            db.execute(delete(GroupAccess).where(GroupAccess.group_id.in_(groups)))
            db.execute(delete(Group).where(Group.id.in_(groups)))
            db.execute(delete(User).where(User.id.in_(users)))
            db.execute(delete(Department).where(Department.id.in_((data.inventory, data.finance))))
            db.commit()
        runtime.dispose()
        owner.dispose()


def _run(engine: Engine, action: Callable[[Session], object]) -> int:
    with Session(engine) as db:
        try:
            action(db)
        except HTTPException as error:
            db.rollback()
            return error.status_code
        return 200


def _etag(engine: Engine, group_id: UUID) -> str:
    with Session(engine) as db:
        group = db.get(Group, group_id)
        assert group is not None
        return policy_service.group_etag(group)


def _replace_as(user_id: UUID, group_id: UUID, member_ids: list[UUID], etag: str):
    def action(db: Session) -> object:
        actor = db.get(User, user_id)
        assert actor is not None
        return delegation.replace_members(db, group_id, member_ids, etag, actor)

    return action


def _members(engine: Engine, group_id: UUID) -> set[UUID]:
    with Session(engine) as db:
        return set(
            db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == group_id)).all()
        )


def test_manager_waits_for_a_widening_of_the_group_and_is_then_refused(
    seed: tuple[_Seed, Engine], monkeypatch: pytest.MonkeyPatch
) -> None:
    data, engine = seed
    etag = _etag(engine, data.target)
    admin_at_commit, release_admin = Event(), Event()
    original_commit = policy_service.commit

    def pause_access_commit(db: Session, message: str) -> None:
        if message == "Unable to change group access":
            admin_at_commit.set()
            assert release_admin.wait(timeout=5)
        original_commit(db, message)

    monkeypatch.setattr(policy_service, "commit", pause_access_commit)
    widened = [
        GroupAccessEntry(department_id=data.inventory, level=AccessLevel.READ),
        GroupAccessEntry(department_id=data.finance, level=AccessLevel.READ),
    ]

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            admin = executor.submit(
                _run,
                engine,
                lambda db: policy_service.replace_group_access(
                    db, data.target, widened, etag, data.admin
                ),
            )
            assert admin_at_commit.wait(timeout=5)
            manager = executor.submit(
                _run, engine, _replace_as(data.manager, data.target, [], etag)
            )
            try:
                assert not wait([manager], timeout=0.5).done
            finally:
                release_admin.set()
            assert admin.result(timeout=5) == 200
            assert manager.result(timeout=5) == 403
    finally:
        release_admin.set()
    assert _members(engine, data.target) == {data.member}


def _downgrade_manager_group(data: _Seed, etag: str) -> Callable[[Session], object]:
    entries = [GroupAccessEntry(department_id=data.inventory, level=AccessLevel.READ)]
    return lambda db: policy_service.replace_group_access(
        db, data.manager_group, entries, etag, data.admin
    )


def _remove_manager(data: _Seed, etag: str) -> Callable[[Session], object]:
    return _replace_as(data.admin, data.manager_group, [], etag)


@pytest.mark.parametrize("revoke", [_downgrade_manager_group, _remove_manager])
def test_revoking_the_managers_authority_waits_for_the_managers_change(
    seed: tuple[_Seed, Engine],
    monkeypatch: pytest.MonkeyPatch,
    revoke: Callable[[_Seed, str], Callable[[Session], object]],
) -> None:
    data, engine = seed
    target_etag = _etag(engine, data.target)
    manager_group_etag = _etag(engine, data.manager_group)
    manager_decided, release_manager = Event(), Event()
    original_replace = delegation.replace_group_members

    def pause_after_decision(db: Session, row: Group, member_ids: list, actor_id: UUID) -> bool:
        if actor_id == data.manager:
            manager_decided.set()
            assert release_manager.wait(timeout=5)
        return original_replace(db, row, member_ids, actor_id)

    monkeypatch.setattr(delegation, "replace_group_members", pause_after_decision)

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            manager = executor.submit(
                _run,
                engine,
                _replace_as(data.manager, data.target, [data.member, data.manager], target_etag),
            )
            assert manager_decided.wait(timeout=5)
            admin = executor.submit(_run, engine, revoke(data, manager_group_etag))
            try:
                assert not wait([admin], timeout=0.5).done
            finally:
                release_manager.set()
            assert manager.result(timeout=5) == 200
            assert admin.result(timeout=5) == 200
    finally:
        release_manager.set()
    assert _members(engine, data.target) == {data.member, data.manager}
