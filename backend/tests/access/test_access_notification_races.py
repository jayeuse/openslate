"""Recipient NOWAIT admission prevents stale cross-group access snapshots."""

import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, BrokenBarrierError, Event

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.systems.access.policy import delegation, service
from app.systems.access.policy.configuration_router import router as access_router
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.policy.schemas import GroupAccessEntry
from app.systems.access.users.models import Membership, User, UserRole
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.scheduling.models import InAppNotification
from app.systems.sandbox.departments.models import Department
from tests.conftest import guarded_create_engine
from tests.organization_scope_support import in_context, scoped_override
from tests.rbac.support import add_department, add_user, make_group_access

pytestmark = pytest.mark.integration


@pytest.fixture
def audience():
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    engine = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=4)
    with Session(owner) as db:
        admin, member = add_user(db, role=UserRole.ADMIN), add_user(db)
        department = add_department(db)
        org_id = department.org_id
        grants = [make_group_access(db, [member], department) for _ in range(2)]
        group_ids = [g.group_id for g in grants]
        ids = admin.id, member.id, department.id, group_ids
        db.commit()
    try:
        yield engine, ids
    finally:
        with Session(owner) as db:
            db.execute(delete(InAppNotification).where(InAppNotification.recipient_id.in_(ids[:2])))
            db.execute(delete(GroupMember).where(GroupMember.group_id.in_(group_ids)))
            db.execute(delete(GroupAccess).where(GroupAccess.group_id.in_(group_ids)))
            db.execute(delete(Group).where(Group.id.in_(group_ids)))
            db.execute(delete(AuditLog).where(AuditLog.org_id == org_id))
            db.execute(delete(Membership).where(Membership.user_id.in_(ids[:2])))
            db.execute(delete(User).where(User.id.in_(ids[:2])))
            db.execute(delete(Department).where(Department.id == ids[2]))
            db.execute(delete(WorkspaceProfile).where(WorkspaceProfile.id == org_id))
            db.commit()
        engine.dispose()
        owner.dispose()


def _write(engine, ids, group_id, *, members=None, level="manage"):
    admin_id, _member_id, department_id, _groups = ids
    with AuditSession(bind=engine) as db:
        set_audit_actor(db, admin_id)
        row = db.get(Group, group_id)
        actor = db.get(User, admin_id)
        try:
            if members is not None:
                delegation.replace_members(db, group_id, members, service.group_etag(row), actor)
            else:
                service.replace_group_access(
                    db,
                    group_id,
                    [GroupAccessEntry(department_id=department_id, level=AccessLevel(level))]
                    if level is not None
                    else [],
                    service.group_etag(row),
                    admin_id,
                )
        except HTTPException as error:
            db.rollback()
            return error.status_code
        return 200


def _count(engine, member_id):
    with Session(engine) as db:
        return len(
            list(
                db.scalars(
                    select(InAppNotification).where(
                        InAppNotification.recipient_id == member_id,
                        InAppNotification.kind == "access-changed",
                    )
                )
            )
        )


@pytest.mark.parametrize("operation", ["grant", "remove-member"])
def test_locked_recipient_refuses_atomically_then_retry_succeeds(audience, operation):
    engine, ids = audience
    group_id = ids[3][0]
    with Session(engine) as holder, ThreadPoolExecutor(max_workers=1) as pool:
        holder.scalar(select(User).where(User.id == ids[1]).with_for_update())
        refused = pool.submit(in_context(_write),
            engine,
            ids,
            group_id,
            **({"members": []} if operation == "remove-member" else {}),
        )
        try:
            assert refused.result(timeout=5) == 503
            assert _count(engine, ids[1]) == 0
            with Session(engine) as check:
                assert check.get(Group, group_id).revision == 1
                assert list(
                    check.scalars(
                        select(GroupMember.user_id).where(GroupMember.group_id == group_id)
                    )
                ) == [ids[1]]
        finally:
            holder.rollback()
    assert (
        _write(engine, ids, group_id, **({"members": []} if operation == "remove-member" else {}))
        == 200
    )
    # Removing a redundant read group changes no effective level.
    assert _count(engine, ids[1]) == (0 if operation == "remove-member" else 1)


def test_cross_group_writer_refuses_stale_snapshot_and_retries_under_current_authority(
    audience, monkeypatch
):
    engine, ids = audience
    at_commit, release = Event(), Event()
    original = service.commit

    def pause(db, message):
        if message == "Unable to change group access" and not at_commit.is_set():
            at_commit.set()
            assert release.wait(5)
        original(db, message)

    monkeypatch.setattr(service, "commit", pause)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(in_context(_write), engine, ids, ids[3][0])
            assert at_commit.wait(5)
            second = pool.submit(in_context(_write), engine, ids, ids[3][1], level=None)
            try:
                assert second.result(timeout=5) == 503
            finally:
                release.set()
            assert first.result(timeout=5) == 200
    finally:
        release.set()
    assert _count(engine, ids[1]) == 1
    assert _write(engine, ids, ids[3][1], level=None) == 200
    assert _count(engine, ids[1]) == 1
    assert _write(engine, ids, ids[3][0], level="read") == 200
    assert _count(engine, ids[1]) == 2


def test_opposite_membership_additions_do_not_deadlock_after_recipient_admission(monkeypatch):
    """Two real requests add each other's retained member after distinct admissions."""

    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    engine = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=4)
    with Session(owner) as db:
        actors = [add_user(db, role=UserRole.ADMIN) for _ in range(2)]
        # UUIDv7 creation order makes U1 the first row in sorted validation.
        u1, u3 = add_user(db), add_user(db)
        assert u1.id < u3.id
        departments = [add_department(db) for _ in range(2)]
        grants = [
            make_group_access(db, [u3], departments[0]),
            make_group_access(db, [u1], departments[1]),
        ]
        actor_ids = [actor.id for actor in actors]
        member_ids = [u1.id, u3.id]
        department_ids = [department.id for department in departments]
        org_id = departments[0].org_id
        group_ids = [grant.group_id for grant in grants]
        db.commit()

    validation_reached = []
    sqlstates = []
    barrier = Barrier(2)
    early_refusal = Event()
    original_validation = service._active_users

    def pause_before_real_validation(db, user_ids):
        validation_reached.append(tuple(sorted(str(user_id) for user_id in user_ids)))
        # The frozen candidate has already admitted each distinct changed User.
        # A correction may move validation earlier and serialize its sorted query.
        # A prompt refusal before this boundary also releases the other request.
        try:
            barrier.wait(timeout=10)
        except BrokenBarrierError:
            if not early_refusal.is_set():
                raise
        return original_validation(db, user_ids)

    def observe_database_error(context):
        code = getattr(context.original_exception, "sqlstate", None)
        if code is not None:
            sqlstates.append(code)

    def request_members(actor_id, group_id):
        with AuditSession(bind=engine) as db:
            set_audit_actor(db, actor_id)
            actor = db.get(User, actor_id)
            app = FastAPI()
            app.include_router(access_router, prefix="/api")
            app.dependency_overrides[get_db] = lambda: db
            app.dependency_overrides[get_current_user] = scoped_override(lambda: actor)
            with TestClient(app) as client:
                response = client.put(
                    f"/api/access/groups/{group_id}/members",
                    json={"member_ids": [str(user_id) for user_id in member_ids]},
                    headers={"If-Match": f'"{group_id}:1"'},
                )
                if response.status_code == 503:
                    early_refusal.set()
                    barrier.abort()
                return response.status_code

    monkeypatch.setattr(service, "_active_users", pause_before_real_validation)
    event.listen(engine, "handle_error", observe_database_error)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(in_context(request_members), actor_ids[0], group_ids[0])
            second = pool.submit(in_context(request_members), actor_ids[1], group_ids[1])
            outcomes = [first.result(timeout=15), second.result(timeout=15)]
        # The result contract admits a prompt NOWAIT refusal as well as two
        # serial successes. A database deadlock is never that refusal.
        assert "40P01" not in sqlstates, (
            f"PostgreSQL deadlock SQLSTATE={sqlstates}; request outcomes={outcomes}; "
            f"requests reaching real sorted validation={validation_reached}"
        )
        assert all(status in (200, 503) for status in outcomes), outcomes
        assert 200 in outcomes, outcomes
    finally:
        barrier.abort()
        event.remove(engine, "handle_error", observe_database_error)
        with Session(owner) as db:
            owned_users = actor_ids + member_ids
            db.execute(
                delete(InAppNotification).where(
                    InAppNotification.kind == "access-changed",
                    InAppNotification.subject_type == "user",
                    InAppNotification.recipient_id.in_(owned_users),
                    InAppNotification.subject_id == InAppNotification.recipient_id,
                )
            )
            db.execute(delete(GroupMember).where(GroupMember.group_id.in_(group_ids)))
            db.execute(delete(GroupAccess).where(GroupAccess.group_id.in_(group_ids)))
            db.execute(delete(Group).where(Group.id.in_(group_ids)))
            db.execute(delete(AuditLog).where(AuditLog.org_id == org_id))
            db.execute(delete(Membership).where(Membership.user_id.in_(owned_users)))
            db.execute(delete(User).where(User.id.in_(owned_users)))
            db.execute(delete(Department).where(Department.id.in_(department_ids)))
            db.execute(delete(WorkspaceProfile).where(WorkspaceProfile.id == org_id))
            db.commit()
        engine.dispose()
        owner.dispose()
