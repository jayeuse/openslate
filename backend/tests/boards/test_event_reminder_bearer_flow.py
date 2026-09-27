"""Real provider bearer admission for Event reminders and audience rechecks."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGrant
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork
from app.systems.platform.scheduling.reminder_execution import execute_due_reminders

pytest_plugins = ("tests.reports.test_report_run_routes",)
pytestmark = pytest.mark.integration


def test_main_app_bearer_reminder_and_inbox_recheck_audience(report_run_fixture) -> None:
    subject = report_run_fixture
    outsider_id = subject.outsider_id
    start = datetime(2026, 10, 1, 9, tzinfo=UTC)
    with AuditSession(subject.owner_engine) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
        board = Board(owner_id=subject.owner_id, name=f"Bearer reminder {uuid7().hex[:12]}")
        db.add(board)
        db.flush()
        grant = BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=outsider_id,
            permission="view",
            effect="allow",
        )
        event = BoardEvent(
            board_id=board.id,
            author_id=subject.owner_id,
            title="Bearer Event",
            all_day=False,
            start_at=start,
            end_at=start + timedelta(hours=1),
            timezone_name="UTC",
            audience_kind="everyone",
        )
        db.add_all((grant, event))
        db.commit()
        board_id, event_id, grant_id = board.id, event.id, grant.id
    try:
        path = f"/api/boards/{board_id}/events/{event_id}/reminders"
        payload = {"occurrence_id": f"{event_id}:2026-10-01T09:00:00Z", "timing": "now"}
        with TestClient(create_app()) as client:
            assert client.post(path, json=payload).status_code == 401
            created = client.post(
                path,
                headers={"Authorization": f"Bearer {subject.outsider_token}"},
                json=payload,
            )
            assert created.status_code == 201, created.text
            assert (
                client.get(
                    f"/api/boards/{board_id}/reminders",
                    headers={"Authorization": f"Bearer {subject.outsider_token}"},
                ).json()["pagination"]["total"]
                == 1
            )
            due = datetime.fromisoformat(created.json()["due_at"].replace("Z", "+00:00"))
            delivered = execute_due_reminders(
                subject.runtime_engine, now=due + timedelta(seconds=1)
            )
            assert len(delivered) == 1
            inbox = client.get(
                "/api/notifications",
                headers={"Authorization": f"Bearer {subject.outsider_token}"},
            )
            assert inbox.status_code == 200, inbox.text
            assert inbox.json()["pagination"]["total"] == 1
            assert inbox.json()["items"][0]["kind"] == "event-reminder"
            read_path = f"/api/notifications/{delivered[0]}/read"
            assert (
                client.post(
                    read_path,
                    headers={"Authorization": f"Bearer {subject.outsider_token}"},
                ).status_code
                == 200
            )

            with AuditSession(subject.owner_engine) as db:
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
                saved_event = db.get(BoardEvent, event_id)
                assert saved_event is not None
                saved_event.audience_kind = "author"
                db.commit()
            denied = client.post(
                path,
                headers={"Authorization": f"Bearer {subject.outsider_token}"},
                json=payload,
            )
            assert denied.status_code == 404
            assert (
                client.get(
                    f"/api/boards/{board_id}/reminders",
                    headers={"Authorization": f"Bearer {subject.outsider_token}"},
                ).json()["pagination"]["total"]
                == 0
            )
            assert (
                client.get(
                    "/api/notifications",
                    headers={"Authorization": f"Bearer {subject.outsider_token}"},
                ).json()["pagination"]["total"]
                == 0
            )
            assert (
                client.post(
                    read_path,
                    headers={"Authorization": f"Bearer {subject.outsider_token}"},
                ).status_code
                == 404
            )
    finally:
        with AuditSession(subject.owner_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            reminder = db.scalar(
                select(BoardEventReminder).where(BoardEventReminder.event_id == event_id)
            )
            if reminder is not None:
                work = db.scalar(
                    select(ScheduledWork).where(ScheduledWork.reminder_id == reminder.id)
                )
                if work is not None:
                    for notice in db.scalars(
                        select(InAppNotification).where(InAppNotification.work_id == work.id)
                    ):
                        db.delete(notice)
                    db.flush()
                    db.delete(work)
                    db.flush()
                db.delete(reminder)
                db.flush()
            for model, row_id in (
                (BoardGrant, grant_id),
                (BoardEvent, event_id),
                (Board, board_id),
            ):
                row = db.get(model, row_id)
                if row is not None:
                    db.delete(row)
                    db.flush()
            db.commit()
