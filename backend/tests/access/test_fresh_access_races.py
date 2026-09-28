"""A fresh module check holds the actor's authority until the protected output commits.

Report runs and aggregate snapshots recheck access after long work, then commit
the output. Each race pauses one transaction at a known point and proves that
the other waits for it: a revocation either waits for the output to commit, or
commits first and the check fails.
"""

import os
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Event
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import delete
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.policy.delegation as delegation
import app.systems.access.policy.service as policy_service
from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.checks import require_fresh_module_access
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.policy.schemas import GroupAccessEntry
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
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
    module: UUID
    admin: UUID
    reader: UUID
    session: UUID
    group: UUID


def _user(db: Session, role: str) -> UUID:
    user = User(
        email=f"fresh-{uuid7().hex}@example.com",
        username=f"fresh_{uuid7().hex[:20]}",
        role=role,
        status=UserStatus.ACTIVE.value,
    )
    db.add(user)
    db.flush()
    return user.id


@pytest.fixture
def seed() -> Iterator[tuple[_Seed, Engine]]:
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=3)
    with Session(owner) as db:
        inventory = Department(department_name=f"Fresh inventory {uuid7().hex}")
        finance = Department(department_name=f"Fresh finance {uuid7().hex}")
        db.add_all([inventory, finance])
        db.flush()
        module = Module(department_id=inventory.id, module_name=f"Fresh {uuid7().hex[:8]}")
        group = Group(name=f"Fresh {uuid7().hex}")
        db.add_all([module, group])
        db.flush()
        reader = _user(db, UserRole.MEMBER.value)
        session = IdentitySession(
            user_id=reader,
            refresh_token_digest=uuid7().hex * 2,
            csrf_token_digest=uuid7().hex * 2,
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        db.add(session)
        db.add(GroupMember(group_id=group.id, user_id=reader))
        db.add(
            GroupAccess(group_id=group.id, department_id=inventory.id, level=AccessLevel.READ.value)
        )
        db.flush()
        data = _Seed(
            inventory=inventory.id,
            finance=finance.id,
            module=module.id,
            admin=_user(db, UserRole.ADMIN.value),
            reader=reader,
            session=session.id,
            group=group.id,
        )
        db.commit()
    try:
        yield data, runtime
    finally:
        with Session(owner) as db:
            db.execute(delete(GroupMember).where(GroupMember.group_id == data.group))
            db.execute(delete(GroupAccess).where(GroupAccess.group_id == data.group))
            db.execute(delete(Group).where(Group.id == data.group))
            db.execute(delete(IdentitySession).where(IdentitySession.id == data.session))
            db.execute(delete(Module).where(Module.id == data.module))
            db.execute(delete(User).where(User.id.in_((data.admin, data.reader))))
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


def _move_access_to_finance(data: _Seed, etag: str) -> Callable[[Session], object]:
    entries = [GroupAccessEntry(department_id=data.finance, level=AccessLevel.READ)]
    return lambda db: policy_service.replace_group_access(db, data.group, entries, etag, data.admin)


def _remove_reader(data: _Seed, etag: str) -> Callable[[Session], object]:
    def action(db: Session) -> object:
        admin = db.get(User, data.admin)
        assert admin is not None
        return delegation.replace_members(db, data.group, [], etag, admin)

    return action


def _fresh_check(data: _Seed) -> Callable[[Session], object]:
    def action(db: Session) -> object:
        return require_fresh_module_access(
            db,
            actor_id=data.reader,
            session_id=data.session,
            module_id=data.module,
            level=AccessLevel.READ,
        )

    return action


_Revoke = Callable[[_Seed, str], Callable[[Session], object]]


@pytest.mark.parametrize("revoke", [_move_access_to_finance, _remove_reader])
def test_revocation_waits_until_the_fresh_checked_output_commits(
    seed: tuple[_Seed, Engine], revoke: _Revoke
) -> None:
    data, engine = seed
    etag = _etag(engine, data.group)
    checked, release_output = Event(), Event()
    check = _fresh_check(data)

    def check_then_commit_output(db: Session) -> object:
        check(db)
        checked.set()
        assert release_output.wait(timeout=5)
        db.commit()
        return None

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            output = executor.submit(_run, engine, check_then_commit_output)
            assert checked.wait(timeout=5)
            admin = executor.submit(_run, engine, revoke(data, etag))
            try:
                assert not wait([admin], timeout=0.5).done
            finally:
                release_output.set()
            assert output.result(timeout=5) == 200
            assert admin.result(timeout=5) == 200
    finally:
        release_output.set()
    assert _run(engine, _fresh_check(data)) == 403


@pytest.mark.parametrize(
    ("revoke", "module", "message"),
    [
        (_move_access_to_finance, policy_service, "Unable to change group access"),
        (_remove_reader, delegation, "Unable to change group members"),
    ],
)
def test_fresh_check_waits_for_a_pending_revocation_and_is_then_refused(
    seed: tuple[_Seed, Engine],
    monkeypatch: pytest.MonkeyPatch,
    revoke: _Revoke,
    module: object,
    message: str,
) -> None:
    data, engine = seed
    etag = _etag(engine, data.group)
    admin_at_commit, release_admin = Event(), Event()
    original_commit = policy_service.commit

    def pause_commit(db: Session, text: str) -> None:
        if text == message:
            admin_at_commit.set()
            assert release_admin.wait(timeout=5)
        original_commit(db, text)

    monkeypatch.setattr(module, "commit", pause_commit)

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            admin = executor.submit(_run, engine, revoke(data, etag))
            assert admin_at_commit.wait(timeout=5)
            output = executor.submit(_run, engine, _fresh_check(data))
            try:
                assert not wait([output], timeout=0.5).done
            finally:
                release_admin.set()
            assert admin.result(timeout=5) == 200
            assert output.result(timeout=5) == 403
    finally:
        release_admin.set()
