"""Real provider bearer admission for author-set reminders and the reader inbox recheck."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.access.policy.models import Group, GroupMember
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGroup
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork
from app.systems.platform.scheduling.reminder_execution import execute_due_reminders

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
            delivered = execute_due_reminders(
                subject.runtime_engine, now=start - timedelta(days=1)
            )
            assert len(delivered) >= 2
            inbox = client.get("/api/notifications", headers=outsider)
            assert inbox.status_code == 200, inbox.text
            [notice] = inbox.json()["items"]
            assert notice["kind"] == "event-reminder"
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
            assert client.get("/api/notifications", headers=outsider).json()["pagination"][
                "total"
            ] == 0
            assert client.post(read_path, headers=outsider).status_code == 404
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
