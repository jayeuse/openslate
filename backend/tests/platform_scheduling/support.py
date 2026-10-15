"""Shared builders for the scheduling, notification and Jobs tests (plan item 20, B7).

Every builder only adds and flushes rows in the caller's session; the caller owns the
transaction. Tests in other areas import these builders from here, not from test modules.
"""

from datetime import UTC, datetime, timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel, GroupAccess
from app.systems.access.users.models import User, UserStatus
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import router as event_router
from app.systems.boards.models import Board
from app.systems.boards.post_models import BoardPost
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.openview.reports.eligibility import capture_run_eligible_users
from app.systems.openview.reports.models import Report, ReportRun, ReportRunEligibleUser
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.platform.scheduling.notification_router import router as notification_router
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.boards.support import board_group, client
from tests.rbac.support import capability_actor, grant_capability_actors, make_group_access

# Reminder occurrences start here; post work is due at POST_DUE.
REMINDER_START = datetime(2027, 3, 1, 9, 0, tzinfo=UTC)
POST_DUE = datetime(2026, 9, 24, 12, tzinfo=UTC)


def report_scope(
    db: Session, *, label: str, role: str, grant_read: bool
) -> tuple[User, Report, GroupAccess | None, Module, Department]:
    """An owner, a department, a module and a Report named after *label*.

    With *grant_read*, the owner reads the Report module through one group, granted
    before the Report exists.
    """

    slug = label.lower().replace(" ", "_")
    owner = User(
        email=f"{slug.replace('_', '-')}-{uuid7().hex}@example.test",
        username=f"{slug}_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    department = Department(department_name=f"{label} {uuid7().hex}")
    db.add_all((owner, department))
    db.flush()
    module = Module(department_id=department.id, module_name=f"{label} {uuid7().hex}")
    db.add(module)
    db.flush()
    access = (
        make_group_access(db, [owner], department, module, level=AccessLevel.READ)
        if grant_read
        else None
    )
    report = Report(module_id=module.id, name="Scheduled", recipe={})
    db.add(report)
    db.flush()
    return owner, report, access, module, department


def report_work_subject(db: Session) -> tuple[User, Report, GroupAccess, Module, Department]:
    """A member who reads one Report module through one group."""

    owner, report, access, module, department = report_scope(
        db, label="Report schedule", role="member", grant_read=True
    )
    assert access is not None
    return owner, report, access, module, department


def report_run(db: Session, report: Report, work: ScheduledWork) -> ReportRun:
    """An empty run of *report* for *work*, with its eligible readers captured."""

    run = ReportRun(
        report_id=report.id,
        module_id=report.module_id,
        idempotency_key=work.id,
        recipe_revision=report.revision,
        recipe={},
        headings=[],
        row_count=0,
        csv_bytes=b"",
    )
    db.add(run)
    db.flush()
    capture_run_eligible_users(db, report, run.id)
    return run


def post_work_subject(db: Session) -> tuple[User, str, Board, BoardPost, ScheduledWork]:
    """A Board writer, a post scheduled for POST_DUE and its publish work."""

    role = "member"
    actor = User(
        email=f"post-work-{uuid7().hex}@example.test",
        username=f"post_work_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    db.add(actor)
    db.flush()
    board = Board(scope="project", name="Scheduled publication")
    db.add(board)
    db.flush()
    board_group(db, board, [actor], "write")
    item = BoardPost(
        board_id=board.id,
        author_id=actor.id,
        title="Scheduled notice",
        body="Publish this content once",
        status="scheduled",
        publish_at=POST_DUE,
        revision=2,
    )
    db.add(item)
    db.flush()
    work = ScheduledWork(
        kind="post-publish",
        post_id=item.id,
        source_revision=item.revision,
        scheduling_actor_id=actor.id,
        scheduled_for=POST_DUE,
        next_attempt_at=POST_DUE,
    )
    db.add(work)
    db.flush()
    return actor, role, board, item, work


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def timed_event(
    db: Session,
    board: Board,
    author: User,
    *,
    reminders: list[str],
    weekly: bool = True,
    repeat_weeks: int = 4,
) -> BoardEvent:
    """A one-hour event at REMINDER_START, created through the Board event route."""

    payload: dict[str, object] = {
        "board_revision": board.revision,
        "title": "Stock count",
        "all_day": False,
        "start_at": _iso(REMINDER_START),
        "end_at": _iso(REMINDER_START + timedelta(hours=1)),
        "timezone_name": "UTC",
        "reminders": reminders,
        "recurrence": "weekly" if weekly else "none",
    }
    if weekly:
        payload["repeat_until"] = (
            (REMINDER_START + timedelta(weeks=repeat_weeks)).date().isoformat()
        )
    response = client(db, author, event_router).post(f"/api/boards/{board.id}/events", json=payload)
    assert response.status_code == 201, response.text
    event = db.get(BoardEvent, response.json()["id"])
    assert event is not None
    return event


def reminder_work(db: Session, event: BoardEvent) -> list[ScheduledWork]:
    """The reminder work of *event*, in occurrence order."""

    return list(
        db.scalars(
            select(ScheduledWork)
            .join(BoardEventReminder, BoardEventReminder.id == ScheduledWork.reminder_id)
            .where(
                ScheduledWork.kind == WorkKind.EVENT_REMINDER,
                BoardEventReminder.event_id == event.id,
            )
            .order_by(ScheduledWork.occurrence_start_at)
        )
    )


def notification_client(db: Session, actor: User | None) -> TestClient:
    """The notification routes alone, on *db*, as *actor* (anonymous when None)."""

    app = FastAPI()
    app.include_router(notification_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    if actor is not None:
        app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def assert_notice_hidden(client: TestClient, notice_id: object) -> None:
    """The notice is absent from every read boundary: list, count, read-all and mark-read."""

    listed = client.get("/api/notifications").json()
    assert listed["items"] == [] and listed["pagination"]["total"] == 0
    assert client.get("/api/notifications/unread-count").json() == {"unread_count": 0}
    assert client.post("/api/notifications/read-all").json() == {"updated_count": 0}
    assert client.post(f"/api/notifications/{notice_id}/read").status_code == 404


def notification_actor(db: Session, *, read: bool = True) -> User:
    """A member who reads every Report module the test makes, or a member in no group."""

    return capability_actor(db, "notification", {"records.write": read})


def notification_report(db: Session, owner: User) -> tuple[Report, Module]:
    """A Secret Report in a new module that every capability actor reads."""

    department = Department(department_name=f"Notification {uuid7().hex}")
    db.add(department)
    db.flush()
    module = Module(department_id=department.id, module_name=f"Notification {uuid7().hex}")
    db.add(module)
    db.flush()
    grant_capability_actors(db, department, module)
    report = Report(module_id=module.id, name="Secret Report", recipe={})
    db.add(report)
    db.flush()
    return report, module


def report_notification(
    db: Session, report: Report, recipient: User, *, minute: int
) -> InAppNotification:
    """A succeeded run of *report* with its notice to *recipient*, *minute* after 2026-01-01."""

    when = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=minute)
    work = ScheduledWork(
        report_id=report.id,
        scheduled_for=when,
        next_attempt_at=when,
        state=WorkState.PENDING,
    )
    db.add(work)
    db.flush()
    run = ReportRun(
        report_id=report.id,
        module_id=report.module_id,
        idempotency_key=work.id,
        recipe_revision=1,
        recipe={},
        headings=[],
        row_count=0,
        csv_bytes=b"SECRET OUTPUT",
    )
    db.add(run)
    db.flush()
    db.add(ReportRunEligibleUser(run_id=run.id, user_id=recipient.id))
    work.run_id = run.id
    work.state = WorkState.SUCCEEDED
    notification = InAppNotification(
        work_id=work.id,
        kind="report-run",
        subject_type="report_run",
        subject_id=run.id,
        recipient_id=recipient.id,
        created_at=when,
    )
    db.add(notification)
    db.flush()
    return notification
