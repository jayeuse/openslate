"""Real provider bearer admission for author-set reminders and the reader inbox recheck."""

import threading
from datetime import UTC, datetime, timedelta
from time import monotonic

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.access.policy.models import Group, GroupMember
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGroup
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.scheduling import reminder_execution
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.platform.scheduling.reminder_execution import (
    claim_due_reminder_work,
    execute_due_reminders,
    finalize_reminder_claim,
)

pytest_plugins = ("tests.reports.test_report_run_routes",)
pytestmark = pytest.mark.integration


def test_main_app_bearer_reminder_reaches_readers_and_inbox_rechecks_the_board(
    report_run_fixture,
) -> None:
    subject = report_run_fixture
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(days=2)
    with AuditSession(subject.owner_engine) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
        board = Board(scope="project", name=f"Bearer reminder {uuid7().hex[:12]}")
        writers = Group(name=f"Bearer writers {uuid7().hex}")
        readers = Group(name=f"Bearer readers {uuid7().hex}")
        db.add_all((board, writers, readers))
        db.flush()
        db.add_all(
            (
                GroupMember(group_id=writers.id, user_id=subject.owner_id),
                GroupMember(group_id=readers.id, user_id=subject.outsider_id),
                BoardGroup(board_id=board.id, group_id=writers.id, level="write"),
                BoardGroup(board_id=board.id, group_id=readers.id, level="read"),
            )
        )
        db.commit()
        board_id, board_revision = board.id, board.revision
        group_ids = (writers.id, readers.id)
    event_id = None
    try:
        path = f"/api/boards/{board_id}/events"
        payload = {
            "board_revision": board_revision,
            "title": "Bearer Event",
            "all_day": False,
            "start_at": start.isoformat().replace("+00:00", "Z"),
            "end_at": (start + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
            "timezone_name": "UTC",
            "reminders": ["1d"],
        }
        outsider = {"Authorization": f"Bearer {subject.outsider_token}"}
        with TestClient(create_app()) as client:
            assert client.post(path, json=payload).status_code == 401
            assert client.post(path, headers=outsider, json=payload).status_code == 403
            created = client.post(path, headers=subject.headers(), json=payload)
            assert created.status_code == 201, created.text
            event_id = created.json()["id"]
            shown = client.get(f"{path}/{event_id}", headers=outsider)
            assert shown.json()["reminders"] == ["1d"]

            execute_due_reminders(subject.runtime_engine, now=start - timedelta(days=3))
            delivered = execute_due_reminders(subject.runtime_engine, now=start - timedelta(days=1))
            assert len(delivered) >= 2
            inbox = client.get("/api/notifications", headers=outsider)
            assert inbox.status_code == 200, inbox.text
            [notice] = inbox.json()["items"]
            assert notice["kind"] == "event-reminder"
            assert notice["subject_type"] == "board_event" and notice["subject_id"] == event_id
            assert client.get("/api/notifications/unread-count", headers=outsider).json() == {
                "unread_count": 1
            }
            assert notice["event_id"] == event_id
            assert notice["occurrence_id"].startswith(f"{event_id}:")
            read_path = f"/api/notifications/{notice['id']}/read"
            assert client.post(read_path, headers=outsider).status_code == 200

            with AuditSession(subject.owner_engine) as db:
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
                reader_row = db.scalar(
                    select(BoardGroup).where(BoardGroup.group_id == group_ids[1])
                )
                assert reader_row is not None
                db.delete(reader_row)
                db.commit()
            assert (
                client.get("/api/notifications", headers=outsider).json()["pagination"]["total"]
                == 0
            )
            assert client.post(read_path, headers=outsider).status_code == 404
            assert client.get("/api/notifications/unread-count", headers=outsider).json() == {
                "unread_count": 0
            }
            assert client.post("/api/notifications/read-all", headers=outsider).json() == {
                "updated_count": 0
            }
    finally:
        with AuditSession(subject.owner_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            reminders = db.scalars(
                select(BoardEventReminder).where(BoardEventReminder.event_id == event_id)
            ).all()
            for reminder in reminders:
                for work in db.scalars(
                    select(ScheduledWork).where(ScheduledWork.reminder_id == reminder.id)
                ):
                    for notice_row in db.scalars(
                        select(InAppNotification).where(InAppNotification.work_id == work.id)
                    ):
                        db.delete(notice_row)
                    db.flush()
                    db.delete(work)
                    db.flush()
                db.delete(reminder)
                db.flush()
            if event_id is not None and (event := db.get(BoardEvent, event_id)) is not None:
                db.delete(event)
                db.flush()
            for row in db.scalars(select(BoardGroup).where(BoardGroup.board_id == board_id)):
                db.delete(row)
            db.flush()
            for group_id in group_ids:
                for membership in db.scalars(
                    select(GroupMember).where(GroupMember.group_id == group_id)
                ):
                    db.delete(membership)
                db.flush()
                group = db.get(Group, group_id)
                if group is not None:
                    db.delete(group)
            db.flush()
            board_row = db.get(Board, board_id)
            if board_row is not None:
                db.delete(board_row)
            db.commit()


def test_reminder_crossing_grace_cutoff_while_waiting_for_work_lock_is_not_delivered(
    report_run_fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    subject = report_run_fixture
    start = datetime(2027, 3, 1, 9, tzinfo=UTC)
    board_id, event_id, reminder_id, work_id = uuid7(), uuid7(), uuid7(), uuid7()
    with AuditSession(subject.owner_engine) as setup:
        setup.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=subject.owner_id, request_id=uuid7()
        )
        group_id = setup.scalar(
            select(GroupMember.group_id).where(GroupMember.user_id == subject.owner_id)
        )
        assert group_id is not None
        setup.add(Board(id=board_id, scope="project", name=f"Lock cutoff {board_id.hex}"))
        setup.flush()
        setup.add(BoardGroup(board_id=board_id, group_id=group_id, level="read"))
        setup.add(
            BoardEvent(
                id=event_id,
                board_id=board_id,
                author_id=subject.owner_id,
                title="Lock cutoff",
                all_day=False,
                start_at=start,
                end_at=start + timedelta(hours=1),
                timezone_name="UTC",
            )
        )
        setup.flush()
        setup.add(
            BoardEventReminder(id=reminder_id, board_id=board_id, event_id=event_id, timing="start")
        )
        setup.flush()
        setup.add(
            ScheduledWork(
                id=work_id,
                kind=WorkKind.EVENT_REMINDER,
                reminder_id=reminder_id,
                occurrence_start_at=start,
                scheduled_for=start,
                next_attempt_at=start,
            )
        )
        setup.commit()

    try:
        claim_time = start + timedelta(minutes=14)
        with AuditSession(subject.owner_engine) as claiming:
            [claim] = claim_due_reminder_work(claiming, now=claim_time, limit=1)
            assert claim.id == work_id
            claiming.commit()

        clock = [claim_time]
        monkeypatch.setattr(reminder_execution, "utc_now", lambda: clock[0])
        attempting = threading.Event()
        finished = threading.Event()
        worker_pid: list[int] = []
        delivered: list = []
        errors: list[Exception] = []

        def on_sql(connection, _cursor, statement, _parameters, _context, _many) -> None:
            if "FROM scheduled_work" in statement and "FOR UPDATE" in statement:
                attempting.set()

        def run_finalizer() -> None:
            try:
                with AuditSession(subject.owner_engine) as worker_db:
                    worker_db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
                    worker_pid.append(
                        worker_db.connection()
                        .exec_driver_sql("SELECT pg_backend_pid()")
                        .scalar_one()
                    )
                    delivered.extend(finalize_reminder_claim(worker_db, claim))
                    worker_db.commit()
            except Exception as exc:
                errors.append(exc)
            finally:
                finished.set()

        holder = Session(subject.owner_engine)
        thread = threading.Thread(target=run_finalizer, daemon=True)
        started = False
        listening = False
        try:
            assert (
                holder.scalar(
                    select(ScheduledWork).where(ScheduledWork.id == work_id).with_for_update()
                )
                is not None
            )
            sqlalchemy_event.listen(subject.owner_engine, "before_cursor_execute", on_sql)
            listening = True
            thread.start()
            started = True
            if not attempting.wait(timeout=10):
                if errors:
                    raise errors[0]
                with Session(subject.owner_engine) as inspector:
                    waiting_at = (
                        inspector.execute(
                            text(
                                "SELECT wait_event_type, wait_event FROM pg_stat_activity "
                                "WHERE pid = :pid"
                            ),
                            {"pid": worker_pid[0]},
                        ).one_or_none()
                        if worker_pid
                        else None
                    )
                pytest.fail(f"Work lock query not reached; worker wait state: {waiting_at}")
            deadline = monotonic() + 10
            with Session(subject.owner_engine) as inspector:
                while not inspector.scalar(
                    text("SELECT cardinality(pg_blocking_pids(:pid))"), {"pid": worker_pid[0]}
                ):
                    assert monotonic() < deadline and not finished.is_set()
                    finished.wait(0.01)
            clock[0] = start + timedelta(minutes=15, seconds=1)
        finally:
            holder.rollback()
            holder.close()
            if started:
                finished.wait(timeout=10)
                thread.join(timeout=10)
            if listening:
                sqlalchemy_event.remove(subject.owner_engine, "before_cursor_execute", on_sql)

        assert finished.is_set()
        assert errors == []
        assert delivered == []
        with Session(subject.owner_engine) as observed:
            assert observed.get(ScheduledWork, work_id).state == WorkState.CANCELED
            assert (
                observed.scalars(
                    select(InAppNotification).where(InAppNotification.work_id == work_id)
                ).all()
                == []
            )
    finally:
        with AuditSession(subject.owner_engine) as cleanup:
            cleanup.info[AUDIT_CONTEXT_KEY] = AuditContext(
                performed_by=subject.owner_id, request_id=uuid7()
            )
            for notice in cleanup.scalars(
                select(InAppNotification).where(InAppNotification.work_id == work_id)
            ):
                cleanup.delete(notice)
            cleanup.flush()
            for model, row_id in (
                (ScheduledWork, work_id),
                (BoardEventReminder, reminder_id),
                (BoardEvent, event_id),
            ):
                row = cleanup.get(model, row_id)
                if row is not None:
                    cleanup.delete(row)
                    cleanup.flush()
            for row in cleanup.scalars(select(BoardGroup).where(BoardGroup.board_id == board_id)):
                cleanup.delete(row)
            cleanup.flush()
            board = cleanup.get(Board, board_id)
            if board is not None:
                cleanup.delete(board)
            cleanup.commit()
