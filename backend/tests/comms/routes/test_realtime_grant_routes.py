"""S20A: real membership/policy, durable rolling admission and finite grant projection."""

from datetime import datetime, timedelta
from threading import Event
from typing import Annotated

import jwt
import pytest
from fastapi import Depends
from sqlalchemy import event, select, text
from sqlalchemy.exc import OperationalError

from app.common.dependencies.auth import get_account_user, get_current_membership, get_current_user
from app.core.config import get_settings
from app.core.database.base import Base
from app.core.database.session import AuditSession
from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.users.models import Membership, User
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.realtime.models import CommsRealtimeAdmission, CommsRealtimeGrant
from app.systems.manage.audit.models import AuditLog
from tests.comms.conftest import NOW
from tests.race_support import WAIT, backend_pid, join, start, wait_until_blocked_by
from tests.realtime.test_realtime_tokens import _public_key

pytestmark = pytest.mark.integration
TOKEN = "/api/realtime/token"


def bound_user(
    actor: Annotated[User, Depends(get_account_user)],
    _membership: Annotated[Membership, Depends(get_current_membership)],
) -> User:
    return actor


@pytest.fixture
def realtime_case(structure_routes, budget_clock, monkeypatch):
    from app.systems.platform.realtime import router

    case = structure_routes
    monkeypatch.setattr(router, "get_engine", lambda: case.world.runtime)
    yield case, budget_clock
    # Individual cleanup of owned support rows, also valid before the schema exists.
    for name in (
        "comms_realtime_grants",
        "comms_realtime_admissions",
        "in_app_notifications",
        "sandbox_documents",
    ):
        if name not in Base.metadata.tables:
            continue
        model = next(
            mapper.class_ for mapper in Base.registry.mappers if mapper.local_table.name == name
        )
        for org in (case.world.first, case.world.second):
            with case.world.session(org) as db:
                for row in db.scalars(select(model).where(model.org_id == org.id)):
                    db.delete(row)
                db.commit()


def projection(world, org, actor):
    with world.session(org) as db:
        return (
            db.connection()
            .execute(
                text(
                    "SELECT conversation_id, expires_at, xmin::text FROM comms_realtime_grants "
                    "WHERE org_id=:org AND user_id=:actor ORDER BY conversation_id"
                ),
                {"org": org.id, "actor": actor},
            )
            .all()
        )


def issue(api, org, actor, ids, expiry):
    response = api.post(TOKEN)
    assert response.status_code == 200  # Never dump a token-bearing body.
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"access_token", "expires_at", "topic_prefix", "conversation_topics"}
    assert body["topic_prefix"] == f"org:{org.id}:"
    assert body["conversation_topics"] == sorted(f"org:{org.id}:conversation:{i}" for i in ids)
    claims = jwt.decode(
        body["access_token"],
        _public_key(get_settings()).key,
        algorithms=["ES256"],
        options={"verify_exp": False, "verify_iat": False},
    )
    assert (claims["sub"], claims["org_id"]) == (str(actor), str(org.id))
    assert claims["purpose"] == "realtime" and "aud" not in claims
    assert claims["exp"] == int(expiry.timestamp())
    assert claims["exp"] - claims["iat"] == 300
    assert datetime.fromisoformat(body["expires_at"].replace("Z", "+00:00")) == expiry


def test_token_reconciles_exact_leases_and_admits_six_in_a_rolling_minute(realtime_case):
    case, clock = realtime_case
    world, org = case.world, case.world.first
    api = case.client(org.peer, org.id)
    ids = sorted((org.conversation, org.other_conversation))
    clock[0] = NOW + timedelta(seconds=0.25)
    expiry = NOW + timedelta(seconds=300)
    issue(api, org, org.peer, ids, expiry)
    before = projection(world, org, org.peer)
    assert [(row[0], row[1]) for row in before] == [(i, expiry) for i in ids]
    for _ in range(2):
        issue(api, org, org.peer, ids, expiry)
        assert projection(world, org, org.peer) == before
    clock[0] = NOW + timedelta(seconds=59.75)
    for _ in range(3):
        issue(api, org, org.peer, ids, NOW + timedelta(seconds=359))
    renewed = projection(world, org, org.peer)
    assert [(r[0], r[1]) for r in renewed] == [(i, NOW + timedelta(seconds=359)) for i in ids]
    # A new process/client must not reset the budget; the old fixed window would admit here.
    api = case.client(org.peer, org.id)
    clock[0] = NOW + timedelta(seconds=60)
    denied = api.post(TOKEN)
    assert denied.status_code == 429 and denied.headers["retry-after"] == "1"
    assert "access_token" not in denied.text
    assert projection(world, org, org.peer) == renewed
    clock[0] = NOW + timedelta(seconds=60.25)
    for _ in range(3):
        issue(api, org, org.peer, ids, NOW + timedelta(seconds=360))
    denied = api.post(TOKEN)
    assert denied.status_code == 429 and denied.headers["retry-after"] == "60"
    # Actor and bound organization are independent keys, not an installation-wide budget.
    case.add_home_members(world.second.author)
    other = case.client(world.second.author, org.id)
    issue(other, org, world.second.author, ids, NOW + timedelta(seconds=360))
    other.headers["X-Org"] = str(world.second.id)
    issue(
        other,
        world.second,
        world.second.author,
        [world.second.conversation, world.second.other_conversation],
        NOW + timedelta(seconds=360),
    )
    assert projection(world, org, org.author) == []
    with world.session(org) as db:
        assert (
            list(
                db.scalars(
                    select(AuditLog.id).where(
                        AuditLog.org_id == org.id,
                        AuditLog.entity_type.in_(
                            ("comms_realtime_grants", "comms_realtime_admissions")
                        ),
                    )
                )
            )
            == []
        )


def department_only(room, org):
    """D44: a department channel; only department roles (or an admin) read it."""
    room.scope, room.department_id = "department", org.department


def test_archive_members_and_shared_group_writers_remove_grants_immediately(realtime_case):
    case, clock = realtime_case
    world, org = case.world, case.world.first
    with world.session(org) as db:
        department_only(db.get(CommsConversation, org.conversation), org)
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="read"
            )
        )
        db.commit()
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    admin.app.dependency_overrides[get_current_user] = bound_user
    issue(
        peer,
        org,
        org.peer,
        [org.conversation, org.other_conversation],
        NOW + timedelta(seconds=300),
    )
    path = f"/api/access/groups/{org.group}"
    group = admin.get(path)
    assert group.status_code == 200, group.text
    tag = group.headers["etag"]
    assert (
        admin.put(path + "/members", headers={"If-Match": tag}, json={"member_ids": []}).status_code
        == 200
    )
    assert [row[0] for row in projection(world, org, org.peer)] == [org.other_conversation]
    path = f"/api/comms/conversations/{org.other_conversation}"
    tag = admin.get(path).headers["etag"]
    assert admin.post(path + "/archive", headers={"If-Match": tag}).status_code == 200
    assert projection(world, org, org.peer) == []
    issue(peer, org, org.peer, [], NOW + timedelta(seconds=300))
    assert peer.get(path).status_code == 200  # Archived history remains readable.


def test_role_demotion_cannot_leave_an_administrator_projection_joinable(realtime_case):
    case, _clock = realtime_case
    org = case.world.first
    with case.world.session(org) as db:
        department_only(db.get(CommsConversation, org.conversation), org)
        membership = db.scalar(
            select(Membership).where(Membership.org_id == org.id, Membership.user_id == org.peer)
        )
        membership.role = "admin"
        db.commit()
    peer, admin = case.client(org.peer, org.id), case.client(org.author, org.id)
    admin.app.dependency_overrides[get_current_user] = bound_user
    issue(
        peer,
        org,
        org.peer,
        [org.conversation, org.other_conversation],
        NOW + timedelta(seconds=300),
    )
    changed = admin.patch(f"/api/users/{org.peer}", json={"role": "member"})
    assert changed.status_code == 200, changed.text
    assert [row[0] for row in projection(case.world, org, org.peer)] == [org.other_conversation]


@pytest.mark.parametrize("revoke_first", [False, True], ids=["refresh-first", "revoke-first"])
def test_grant_refresh_and_shared_group_revocation_serialize(realtime_case, revoke_first):
    case, clock = realtime_case
    world, org = case.world, case.world.first
    case.hide_other_conversation()
    with world.session(org) as db:
        department_only(db.get(CommsConversation, org.conversation), org)
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="read"
            )
        )
        db.commit()
    peer, admin = case.client(org.peer, org.id), case.client(org.author, org.id)
    admin.app.dependency_overrides[get_current_user] = bound_user
    issue(peer, org, org.peer, [org.conversation], NOW + timedelta(seconds=300))
    path = f"/api/access/groups/{org.group}"
    tag = admin.get(path).headers["etag"]
    clock[0] += timedelta(seconds=2)
    held, release = Event(), Event()
    holder, touched = [], set()

    def observe(session, *_args):
        if session.get_bind() is not world.runtime or held.is_set():
            return
        changes = session.deleted if revoke_first else session.new.union(session.dirty)
        model = GroupMember if revoke_first else CommsRealtimeGrant
        if any(isinstance(row, model) for row in changes):
            touched.add(session)

    def hold(session):
        observe(session)
        if held.is_set() or session not in touched:
            return
        session.flush()
        holder.append(backend_pid(session))
        held.set()
        assert release.wait(WAIT)
        if not revoke_first:
            assert (
                session.scalar(
                    select(Group).where(Group.id == org.group).with_for_update(nowait=True)
                )
                is not None
            )

    def refresh():
        return peer.post(TOKEN)

    def revoke():
        return admin.put(path + "/members", headers={"If-Match": tag}, json={"member_ids": []})

    workers = []
    event.listen(AuditSession, "before_flush", observe)
    event.listen(AuditSession, "before_commit", hold)
    try:
        workers.append(start(revoke if revoke_first else refresh))
        assert held.wait(WAIT)
        workers.append(start(refresh if revoke_first else revoke))
        waiter = wait_until_blocked_by(world.owner, holder[0])
        with world.owner.connect() as connection:
            assert connection.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_locks "
                    "WHERE pid=:pid AND locktype='advisory' AND NOT granted)"
                ),
                {"pid": waiter},
            )
        other = case.client(world.second.author, world.second.id)
        assert other.post(TOKEN).status_code == 200
    finally:
        release.set()
        try:
            outcomes = [join(*worker) for worker in workers]
        finally:
            event.remove(AuditSession, "before_commit", hold)
            event.remove(AuditSession, "before_flush", observe)
    assert [response.status_code for response in outcomes] == [200, 200]
    assert projection(world, org, org.peer) == []
    issue(peer, org, org.peer, [], NOW + timedelta(seconds=302))


def test_admission_is_independent_durable_and_only_one_concurrent_sixth_succeeds(realtime_case):
    case, clock = realtime_case
    world, org = case.world, case.world.first
    api = case.client(org.peer, org.id)
    for _ in range(5):
        assert api.post(TOKEN).status_code == 200
    held, release = Event(), Event()
    holder = []

    def hold(session):
        if (
            session.get_bind() is world.runtime
            and not held.is_set()
            and any(
                isinstance(row, CommsRealtimeAdmission) for row in session.new.union(session.dirty)
            )
        ):
            session.flush()
            holder.append(backend_pid(session))
            held.set()
            assert release.wait(WAIT)

    left, right = case.client(org.peer, org.id), case.client(org.peer, org.id)
    workers = []
    event.listen(AuditSession, "before_commit", hold)
    try:
        workers.append(start(lambda: left.post(TOKEN)))
        assert held.wait(WAIT)
        workers.append(start(lambda: right.post(TOKEN)))
        wait_until_blocked_by(world.owner, holder[0])
    finally:
        release.set()
        try:
            results = [join(*worker) for worker in workers]
        finally:
            event.remove(AuditSession, "before_commit", hold)
    assert sorted(response.status_code for response in results) == [200, 429]
    clock[0] += timedelta(seconds=61)
    before = projection(world, org, org.peer)
    for model, expected_charge in ((CommsRealtimeAdmission, False), (CommsRealtimeGrant, True)):
        failures = []

        def refuse_commit(session, model=model, failures=failures):
            if session.get_bind() is world.runtime and any(
                isinstance(row, model) for row in session.new.union(session.dirty)
            ):
                failures.append(True)
                raise OperationalError("controlled commit refusal", {}, RuntimeError("controlled"))

        event.listen(AuditSession, "before_commit", refuse_commit)
        try:
            response = api.post(TOKEN)
        finally:
            event.remove(AuditSession, "before_commit", refuse_commit)
        assert failures == [True] and response.status_code == 503
        assert "access_token" not in response.text and projection(world, org, org.peer) == before
        with world.session(org) as db:
            row = db.scalar(
                select(CommsRealtimeAdmission).where(CommsRealtimeAdmission.user_id == org.peer)
            )
            assert (clock[0] in row.issued_at) is expected_charge


def test_expiry_sweep_removes_only_the_bound_organizations_expired_rows(realtime_case):
    from app.systems.comms.realtime.grants import sweep_expired

    case, _clock = realtime_case
    first, second = case.world.first, case.world.second
    for org in (first, second):
        issue(
            case.client(org.peer, org.id),
            org,
            org.peer,
            [org.conversation, org.other_conversation],
            NOW + timedelta(seconds=300),
        )
    with case.world.session(first) as db:
        assert sweep_expired(db, NOW + timedelta(seconds=299)) == 0
        db.commit()
    with case.world.session(first) as db:
        assert sweep_expired(db, NOW + timedelta(seconds=300)) == 2
        db.commit()
    assert projection(case.world, first, first.peer) == []
    assert len(projection(case.world, second, second.peer)) == 2


def test_token_admission_does_not_require_two_simultaneous_pool_slots(realtime_case, monkeypatch):
    import os

    from tests.conftest import guarded_create_engine

    case, _clock = realtime_case
    bounded = guarded_create_engine(
        os.environ["TEST_DATABASE_URL"], pool_size=1, max_overflow=0, pool_timeout=0.25
    )
    original = case.world.runtime
    try:
        monkeypatch.setattr(case.world, "runtime", bounded)
        org = case.world.first
        issue(
            case.client(org.peer, org.id),
            org,
            org.peer,
            [org.conversation, org.other_conversation],
            NOW + timedelta(seconds=300),
        )
    finally:
        case.world.runtime = original
        bounded.dispose()


def test_manager_row_removal_keeps_the_grant_of_a_reader_whose_read_survives(realtime_case):
    case, _clock = realtime_case
    org = case.world.first
    peer, admin = case.client(org.peer, org.id), case.client(org.author, org.id)
    issue(
        peer,
        org,
        org.peer,
        [org.conversation, org.other_conversation],
        NOW + timedelta(seconds=300),
    )
    path = f"/api/comms/conversations/{org.conversation}"
    member = path + f"/members/{org.peer}"
    current = admin.get(path)
    assert current.status_code == 200
    promoted = admin.put(member, headers={"If-Match": current.headers["etag"]}, json={
        "role": "manager",
    })
    assert promoted.status_code == 200
    assert (
        admin.delete(member, headers={"If-Match": admin.get(path).headers["etag"]}).status_code
        == 204
    )
    # D44: a manager row is not read access; the organization reader keeps the topic grant.
    assert sorted(row[0] for row in projection(case.world, org, org.peer)) == sorted(
        [org.conversation, org.other_conversation]
    )
    assert peer.get(path).status_code == 200
    # The grant remains a projection, not a new membership-only rule for public channels.
    issue(
        peer,
        org,
        org.peer,
        [org.conversation, org.other_conversation],
        NOW + timedelta(seconds=300),
    )


def test_department_lifecycle_close_revokes_its_derived_conversation_grants(realtime_case):
    from app.systems.access.policy.models import GroupAccess
    from app.systems.manage.workspace.models import WorkspaceProfile
    from app.systems.sandbox.lifecycle.execution import close_lifecycle
    from tests.sandbox_designs.fixtures import create_document

    case, _clock = realtime_case
    org = case.world.first
    with case.world.session(org) as db:
        create_document(db, db.get(WorkspaceProfile, org.id))
        row = db.get(CommsConversation, org.conversation)
        row.scope, row.department_id = "department", org.department
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="read"
            )
        )
        db.commit()
    peer = case.client(org.peer, org.id)
    issue(
        peer,
        org,
        org.peer,
        [org.conversation, org.other_conversation],
        NOW + timedelta(seconds=300),
    )
    with case.world.session(org) as db:
        close_lifecycle(db, "department", org.department, org.author)
    assert peer.get(f"/api/comms/conversations/{org.conversation}").status_code == 404
    assert [row[0] for row in projection(case.world, org, org.peer)] == [org.other_conversation]
