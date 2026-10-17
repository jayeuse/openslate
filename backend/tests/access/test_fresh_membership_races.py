"""Shared accounts reauthorize their bound membership, not an admitted stale grant."""

import os
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import delete
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.checks import require_fresh_module_access
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users import account_operations
from app.systems.access.users.membership import organization_membership, remember_membership
from app.systems.access.users.models import Membership, User
from app.systems.access.users.schemas import UserUpdate
from app.systems.manage.audit.models import AuditLog, SecurityEvent
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.scheduling.models import InAppNotification
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.conftest import create_member, create_organization, guarded_create_engine
from tests.race_support import WAIT, backend_pid, wait_until_blocked_by

pytestmark = pytest.mark.integration


def run_action(engine: Engine, action: Callable[[Session], object]) -> int:
    with AuditSession(engine) as db:
        try:
            action(db)
        except HTTPException as error:
            if error.status_code != 403:
                raise
            db.rollback()
            return 403
        return 200


@pytest.fixture
def world() -> Iterator[tuple[Engine, Engine, dict[str, UUID]]]:
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=4)
    with Session(owner) as db:
        a, b = create_organization(db), create_organization(db)
        admin, _ = create_member(db, a, role="admin")
        shared, membership_a = create_member(db, a, role="admin")
        _, membership_b = create_member(db, b, user=shared, role="admin")
        department = Department(org_id=a.id, department_name=f"Fresh {uuid7()}")
        db.add(department)
        db.flush()
        module = Module(org_id=a.id, department_id=department.id, module_name="Unchanged")
        session = IdentitySession(
            user_id=shared.id, refresh_token_digest=uuid7().hex * 2,
            csrf_token_digest=uuid7().hex * 2,
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        db.add_all([module, session])
        db.flush()
        data = dict(a=a.id, b=b.id, admin=admin.id, shared=shared.id,
                    membership_a=membership_a.id, membership_b=membership_b.id,
                    module=module.id, department=department.id, session=session.id)
        db.commit()
    try:
        yield owner, runtime, data
    finally:
        with Session(owner) as db:
            people = (data["admin"], data["shared"])
            db.execute(delete(InAppNotification).where(InAppNotification.recipient_id.in_(people)))
            db.execute(delete(SecurityEvent).where(
                SecurityEvent.actor_id.in_(people) | SecurityEvent.subject_id.in_(people)))
            db.execute(delete(AuditLog).where(AuditLog.org_id.in_((data["a"], data["b"]))))
            db.execute(delete(IdentitySession).where(IdentitySession.id == data["session"]))
            db.execute(delete(Module).where(Module.id == data["module"]))
            db.execute(delete(Department).where(Department.id == data["department"]))
            db.execute(delete(Membership).where(Membership.user_id.in_(people)))
            db.execute(delete(User).where(User.id.in_(people)))
            db.execute(delete(WorkspaceProfile).where(WorkspaceProfile.id.in_(
                (data["a"], data["b"]))))
            db.commit()
        runtime.dispose()
        owner.dispose()


def _admit(db: Session, data: dict[str, UUID]) -> None:
    scope_session(db, data["a"])
    membership = organization_membership(db, data["shared"])
    assert membership is not None and membership.status == "active" and membership.role == "admin"
    remember_membership(db, membership)


def _check_and_write(db: Session, data: dict[str, UUID]) -> None:
    require_fresh_module_access(
        db, actor_id=data["shared"], session_id=data["session"], module_id=data["module"],
        level=AccessLevel.WRITE,
    )
    module = db.get(Module, data["module"])
    assert module is not None
    module.module_name = "Protected output"


def _revoke(db: Session, data: dict[str, UUID], change: str) -> None:
    scope_session(db, data["a"])
    admin = db.get(User, data["admin"])
    assert admin is not None
    if change == "remove":
        account_operations.delete_user(data["shared"], admin, db)
    else:
        payload = UserUpdate(
            **({"status": "disabled"} if change == "disable" else {"role": "member"}))
        account_operations.update_user(data["shared"], payload, admin, db)


@pytest.mark.parametrize("change", ["disable", "demote", "remove"])
def test_cached_a_admin_is_refused_after_membership_revocation_commits(
    world: tuple[Engine, Engine, dict[str, UUID]], change: str,
) -> None:
    owner, runtime, data = world
    admitted, revoked = Event(), Event()

    def request(db: Session) -> None:
        _admit(db, data)
        admitted.set()
        assert revoked.wait(WAIT)
        _check_and_write(db, data)
        db.commit()

    with ThreadPoolExecutor(max_workers=1) as executor:
        output = executor.submit(run_action, runtime, request)
        try:
            assert admitted.wait(WAIT)
            assert run_action(runtime, lambda db: _revoke(db, data, change)) == 200
        finally:
            revoked.set()
        assert output.result(timeout=WAIT) == 403
    with Session(owner) as db:
        assert db.get(Module, data["module"]).module_name == "Unchanged"
        assert db.get(User, data["shared"]).status == "active"
        assert db.get(Membership, data["membership_b"]).status == "active"
        assert db.get(IdentitySession, data["session"]).revoked_at is None


def test_membership_revocation_waits_for_fresh_checked_output_commit(
    world: tuple[Engine, Engine, dict[str, UUID]],
) -> None:
    owner, runtime, data = world
    checked, release = Event(), Event()
    holder: list[int] = []

    def request(db: Session) -> None:
        _admit(db, data)
        _check_and_write(db, data)
        holder.append(backend_pid(db))
        checked.set()
        assert release.wait(WAIT)
        db.commit()

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            output = executor.submit(run_action, runtime, request)
            assert checked.wait(WAIT)
            revoker = executor.submit(run_action, runtime, lambda db: _revoke(db, data, "disable"))
            try:
                wait_until_blocked_by(owner, holder[0])
                assert not revoker.done()
            finally:
                release.set()
            assert output.result(timeout=WAIT) == revoker.result(timeout=WAIT) == 200
    finally:
        release.set()
    with Session(owner) as db:
        assert db.get(Module, data["module"]).module_name == "Protected output"
        assert db.get(Membership, data["membership_a"]).status == "disabled"
        assert db.get(Membership, data["membership_b"]).status == "active"


def test_fresh_check_refreshes_cached_membership_after_waiting_for_revoker(
    world: tuple[Engine, Engine, dict[str, UUID]], monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner, runtime, data = world
    admitted, revoker_held, release = Event(), Event(), Event()
    holder: list[int] = []
    original_commit = account_operations.commit

    def pause_commit(db: Session, message: str) -> None:
        holder.append(backend_pid(db))
        revoker_held.set()
        assert release.wait(WAIT)
        original_commit(db, message)

    monkeypatch.setattr(account_operations, "commit", pause_commit)

    def request(db: Session) -> None:
        _admit(db, data)
        admitted.set()
        assert revoker_held.wait(WAIT)
        _check_and_write(db, data)
        db.commit()

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            output = executor.submit(run_action, runtime, request)
            assert admitted.wait(WAIT)
            revoker = executor.submit(run_action, runtime, lambda db: _revoke(db, data, "disable"))
            try:
                assert revoker_held.wait(WAIT)
                wait_until_blocked_by(owner, holder[0])
                assert not output.done()
            finally:
                release.set()
            assert revoker.result(timeout=WAIT) == 200
            assert output.result(timeout=WAIT) == 403
    finally:
        release.set()
    with Session(owner) as db:
        assert db.get(Module, data["module"]).module_name == "Unchanged"
        assert db.get(Membership, data["membership_a"]).status == "disabled"
        assert db.get(Membership, data["membership_b"]).status == "active"
