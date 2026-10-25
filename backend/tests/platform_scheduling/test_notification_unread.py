"""Visible unread counts and audited read-all through the actual notification routes."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event, Lock
from uuid import UUID

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import event, select, text
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.users.models import Membership, User
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext, set_audit_actor
from app.systems.manage.audit.models import AuditLog
from app.systems.openview.reports.models import Report, ReportRun, ReportRunEligibleUser
from app.systems.platform.scheduling import notification_router
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.conftest import guarded_create_engine
from tests.organization_scope_support import scoped_override
from tests.platform_scheduling.support import (
    notification_actor,
    notification_client,
    notification_report,
    report_notification,
)

pytestmark = pytest.mark.integration
READ_TIME = datetime(2026, 10, 6, 12, tzinfo=UTC)


def _audit_updates(db, ids):
    return list(
        db.scalars(
            select(AuditLog).where(
                AuditLog.entity_type == "in_app_notifications",
                AuditLog.entity_id.in_(ids),
                AuditLog.action == "update",
            )
        )
    )


def _request(engine, actor_id, method, path):
    app = FastAPI()
    app.include_router(notification_router.router, prefix="/api")

    def database(request: Request):
        with AuditSession(engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                request_method=request.method, request_path=request.url.path
            )
            set_audit_actor(db, actor_id)
            yield db

    def actor():
        with Session(engine) as db:
            return db.get(User, actor_id)

    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_current_user] = scoped_override(actor)
    with TestClient(app) as client:
        return client.request(method, path)


def test_unread_list_count_and_read_all_agree_and_cover_more_than_one_page(
    integration_owner_db, monkeypatch
):
    db = integration_owner_db
    owner, other = notification_actor(db), notification_actor(db)
    report, _ = notification_report(db, owner)
    notices = [report_notification(db, report, owner, minute=i) for i in range(110)]
    other_notice = report_notification(db, report, other, minute=200)
    hidden_report, hidden_module = notification_report(db, owner)
    hidden = report_notification(db, hidden_report, owner, minute=201)
    notices[0].read_at = datetime(2026, 1, 2, tzinfo=UTC)
    notices[1].is_deleted = True
    notices[2].subject_id = UUID("00000000-0000-4000-8000-000000000999")
    for grant in db.scalars(select(GroupAccess).where(GroupAccess.module_id == hidden_module.id)):
        grant.is_deleted = True
    set_audit_actor(db, owner.id)
    db.commit()
    before = len(_audit_updates(db, [n.id for n in notices]))
    monkeypatch.setattr(notification_router, "utc_now", lambda: READ_TIME)
    client = notification_client(db, owner)

    count = client.get("/api/notifications/unread-count")
    assert count.status_code == 200, count.text
    assert count.json() == {"unread_count": 107}
    assert count.headers["cache-control"] == "private, no-store"
    page = client.get("/api/notifications?status=unread&limit=1&offset=1")
    assert page.status_code == 200, page.text
    assert page.json()["pagination"] == {
        "limit": 1,
        "offset": 1,
        "count": 1,
        "total": 107,
        "has_more": True,
    }
    assert all(item["status"] == "unread" for item in page.json()["items"])
    assert client.get("/api/notifications").json()["pagination"]["total"] == 108
    for invalid in ("read", "unknown"):
        assert client.get(f"/api/notifications?status={invalid}").status_code == 422
    assert notification_client(db, None).get("/api/notifications/unread-count").status_code == 401
    assert notification_client(db, None).post("/api/notifications/read-all").status_code == 401

    changed = client.post("/api/notifications/read-all")
    assert changed.status_code == 200, changed.text
    assert changed.headers["cache-control"] == "private, no-store"
    assert changed.json() == {"updated_count": 107}
    db.expire_all()
    assert all(n.read_at == READ_TIME for n in notices[3:])
    assert notices[0].read_at == datetime(2026, 1, 2, tzinfo=UTC)
    assert all(n.read_at is None for n in (notices[1], notices[2], hidden, other_notice))
    assert len(_audit_updates(db, [n.id for n in notices])) - before == 107
    assert client.get("/api/notifications/unread-count").json() == {"unread_count": 0}
    assert client.get("/api/notifications?status=unread").json()["pagination"]["total"] == 0
    assert client.get("/api/notifications").json()["pagination"]["total"] == 108
    assert client.post("/api/notifications/read-all").json() == {"updated_count": 0}
    assert (
        client.post(f"/api/notifications/{notices[0].id}/read").json()["read_at"]
        == "2026-01-02T00:00:00Z"
    )
    assert len(_audit_updates(db, [n.id for n in notices])) - before == 107
    assert client.post(f"/api/notifications/{notices[2].id}/read").status_code == 404


@pytest.fixture
def committed_subject():
    # The standard integration fixture deliberately keeps an outer transaction;
    # concurrency needs separate connections with committed, owned source rows.
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    ids = {}
    try:
        with AuditSession(engine) as db:
            owner = notification_actor(db)
            report, module = notification_report(db, owner)
            notice = report_notification(db, report, owner, minute=1)
            ids = {
                "organization": report.org_id,
                "owner": owner.id,
                "report": report.id,
                "module": module.id,
                "department": module.department_id,
                "notice": notice.id,
            }
            ids["groups"] = list(
                db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == owner.id))
            )
            db.commit()
        yield engine, ids
    finally:
        if ids:
            with AuditSession(engine) as db:
                works = list(
                    db.scalars(
                        select(ScheduledWork).where(ScheduledWork.report_id == ids["report"])
                    )
                )
                runs = list(
                    db.scalars(select(ReportRun).where(ReportRun.report_id == ids["report"]))
                )
                for notice in db.scalars(
                    select(InAppNotification).where(
                        InAppNotification.work_id.in_([w.id for w in works])
                    )
                ):
                    db.delete(notice)
                db.flush()
                for work in works:
                    db.delete(work)
                db.flush()
                for eligible in db.scalars(
                    select(ReportRunEligibleUser).where(
                        ReportRunEligibleUser.run_id.in_([r.id for r in runs])
                    )
                ):
                    db.delete(eligible)
                db.flush()
                for run in runs:
                    db.delete(run)
                db.flush()
                db.delete(db.get(Report, ids["report"]))
                db.flush()
                for access in db.scalars(
                    select(GroupAccess).where(GroupAccess.module_id == ids["module"])
                ):
                    db.delete(access)
                db.flush()
                db.delete(db.get(Module, ids["module"]))
                db.flush()
                db.delete(db.get(Department, ids["department"]))
                db.flush()
                for member in db.scalars(
                    select(GroupMember).where(GroupMember.user_id == ids["owner"])
                ):
                    db.delete(member)
                db.flush()
                for group_id in ids["groups"]:
                    db.delete(db.get(Group, group_id))
                db.flush()
                for membership in db.scalars(
                    select(Membership).where(Membership.user_id == ids["owner"])
                ):
                    db.delete(membership)
                db.flush()
                db.delete(db.get(User, ids["owner"]))
                db.commit()
            with engine.begin() as cleanup:
                cleanup.execute(text("DELETE FROM public.audit_logs WHERE org_id = :id"),
                                {"id": ids["organization"]})
                cleanup.execute(text("DELETE FROM public.organizations WHERE id = :id"),
                                {"id": ids["organization"]})
        engine.dispose()


def test_unread_count_does_not_wait_for_the_recipient_row_lock(committed_subject):
    engine, ids = committed_subject
    with ThreadPoolExecutor(max_workers=1) as pool, Session(engine) as blocker:
        blocker.scalar(select(User).where(User.id == ids["owner"]).with_for_update())
        pending = pool.submit(
            _request, engine, ids["owner"], "GET", "/api/notifications/unread-count"
        )
        try:
            response = pending.result(timeout=3)
            assert response.status_code == 200, response.text
            assert response.json() == {"unread_count": 1}
        finally:
            blocker.rollback()
    with Session(engine) as observed:
        assert observed.get(InAppNotification, ids["notice"]).read_at is None
        assert _audit_updates(observed, [ids["notice"]]) == []


def test_concurrent_read_all_and_mark_one_keep_one_timestamp_and_one_audit_update(
    committed_subject, monkeypatch
):
    engine, ids = committed_subject
    instants = iter((READ_TIME, READ_TIME + timedelta(seconds=30)))
    monkeypatch.setattr(notification_router, "utc_now", lambda: next(instants))
    # Liveness deadlines only: a CI shard that seeds large tables at the same
    # time once needed more than 3 s to start the second request. The order
    # and outcome assertions are unchanged.
    reached, release, second_attempt = Event(), Event(), Event()
    attempt_lock, attempts = Lock(), 0

    def recipient_attempt(_connection, _cursor, statement, _parameters, _context, _many):
        nonlocal attempts
        if "FROM users" in statement and "FOR UPDATE" in statement:
            with attempt_lock:
                attempts += 1
                if attempts == 2:
                    second_attempt.set()

    def hold(_connection, _cursor, statement, _parameters, _context, _many):
        if "FROM in_app_notifications" in statement and "FOR UPDATE" in statement:
            if not reached.is_set():
                reached.set()
                assert release.wait(timeout=20)

    event.listen(engine, "after_cursor_execute", hold)
    event.listen(engine, "before_cursor_execute", recipient_attempt)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(
                _request, engine, ids["owner"], "POST", "/api/notifications/read-all"
            )
            try:
                assert reached.wait(timeout=10)
                second = pool.submit(
                    _request,
                    engine,
                    ids["owner"],
                    "POST",
                    f"/api/notifications/{ids['notice']}/read",
                )
                assert second_attempt.wait(timeout=10)
            finally:
                release.set()
            first_response, second_response = first.result(timeout=10), second.result(timeout=10)
            assert first_response.status_code == second_response.status_code == 200
            assert first_response.json() == {"updated_count": 1}
            assert second_response.json()["read_at"] == "2026-10-06T12:00:00Z"
    finally:
        release.set()
        event.remove(engine, "after_cursor_execute", hold)
        event.remove(engine, "before_cursor_execute", recipient_attempt)
    with Session(engine) as observed:
        assert observed.get(InAppNotification, ids["notice"]).read_at == READ_TIME
        assert len(_audit_updates(observed, [ids["notice"]])) == 1
    assert _request(engine, ids["owner"], "POST", "/api/notifications/read-all").json() == {
        "updated_count": 0
    }
    with Session(engine) as observed:
        assert len(_audit_updates(observed, [ids["notice"]])) == 1


def test_notice_inserted_after_read_all_selection_remains_unread(committed_subject):
    engine, ids = committed_subject
    selected, release, insertion = Event(), Event(), Event()

    def observe(_connection, _cursor, statement, _parameters, _context, _many):
        if "FROM in_app_notifications" in statement and "FOR UPDATE" in statement:
            selected.set()
            assert release.wait(timeout=5)

    def started(_connection, _cursor, statement, _parameters, _context, _many):
        if "INSERT INTO report_run_eligible_users" in statement:
            insertion.set()

    def arrive():
        with AuditSession(engine) as writer:
            actor, source = writer.get(User, ids["owner"]), writer.get(Report, ids["report"])
            assert actor is not None and source is not None
            arrived = report_notification(writer, source, actor, minute=2)
            writer.commit()
            return arrived.id

    event.listen(engine, "after_cursor_execute", observe)
    event.listen(engine, "before_cursor_execute", started)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(
                _request, engine, ids["owner"], "POST", "/api/notifications/read-all"
            )
            try:
                assert selected.wait(timeout=3)
                arriving = pool.submit(arrive)
                # The insertion is in flight after selection; its recipient FK
                # waits for the current read transaction's User lock to release.
                assert insertion.wait(timeout=3)
            finally:
                release.set()
            response, arrived_id = pending.result(timeout=5), arriving.result(timeout=5)
            assert response.status_code == 200 and response.json() == {"updated_count": 1}
    finally:
        release.set()
        event.remove(engine, "after_cursor_execute", observe)
        event.remove(engine, "before_cursor_execute", started)
    with Session(engine) as observed:
        assert observed.get(InAppNotification, ids["notice"]).read_at is not None
        assert observed.get(InAppNotification, arrived_id).read_at is None
    assert _request(engine, ids["owner"], "GET", "/api/notifications/unread-count").json() == {
        "unread_count": 1
    }


def test_failed_read_all_flush_rolls_back_read_state_and_audit(committed_subject):
    engine, ids = committed_subject

    def reject_flush(db, _context):
        context = db.info.get(AUDIT_CONTEXT_KEY)
        if context and context.request_path == "/api/notifications/read-all":
            raise RuntimeError("Controlled notification persistence failure")

    event.listen(AuditSession, "after_flush", reject_flush)
    try:
        with pytest.raises(RuntimeError, match="Controlled notification persistence failure"):
            _request(engine, ids["owner"], "POST", "/api/notifications/read-all")
    finally:
        event.remove(AuditSession, "after_flush", reject_flush)
    with Session(engine) as observed:
        assert observed.get(InAppNotification, ids["notice"]).read_at is None
        assert _audit_updates(observed, [ids["notice"]]) == []
