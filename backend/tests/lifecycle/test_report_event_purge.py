"""Report/event purge uses the same administrator challenge boundary as Boards."""

from datetime import UTC, date, datetime
from types import SimpleNamespace
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.base_model import BaseModel
from app.systems.access.users.models import User
from app.systems.boards.attachment_models import BoardAttachment
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import router as event_router
from app.systems.boards.record_link_models import BoardRecordLink
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.manage.audit.models import AuditLog
from app.systems.openview.reports.models import Report
from app.systems.openview.reports.router import router as report_router
from app.systems.platform.files.models import File
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleInvalidCredentials,
    LifecyclePasswordServiceUnavailable,
)
from app.systems.sandbox.records.models import Record
from tests.boards.support import client, project_board
from tests.boards.test_permanent_delete import _actor
from tests.conftest import membership_of
from tests.reports.test_report_routes import _module, _recipe

pytestmark = pytest.mark.integration


@pytest.fixture(params=["report", "board_event"])
def purge_target(request: pytest.FixtureRequest, integration_owner_db: Session, monkeypatch):
    db = integration_owner_db
    actor = _actor(db, admin=True)
    for module in (
        "app.systems.openview.reports.purge_router",
        "app.systems.boards.event_purge_router",
    ):
        monkeypatch.setattr(
            f"{module}.get_settings", lambda: SimpleNamespace(lifecycle_purge_enabled=True)
        )
    if request.param == "report":
        module, field = _module(db)
        target: Report | BoardEvent = Report(
            org_id=module.org_id,
            module_id=module.id, name="Archived report", recipe=_recipe(field)
        )
        root = "/api/reports"
    else:
        board = project_board(db)
        target = BoardEvent(
            org_id=board.org_id,
            board_id=board.id,
            author_id=actor.id,
            title="Archived event",
            all_day=True,
            start_date=date(2026, 10, 8),
            end_date=date(2026, 10, 8),
            timezone_name="UTC",
        )
        root = f"/api/boards/{board.id}/events"
    db.add(target)
    db.commit()
    path = f"{root}/{target.id}"
    api = client(db, actor, report_router, event_router)
    yield db, actor, target, path, api
    api.close()


def _archive(db: Session, target: Report | BoardEvent) -> None:
    if isinstance(target, Report):
        target.is_deleted, target.deleted_at = True, datetime.now(UTC)
    else:
        target.archived = True
    db.commit()


def _payload(preview: dict[str, object]) -> dict[str, object]:
    return {
        "token": preview["token"],
        "confirmation_name": preview["confirmation_name"],
        "password": "synthetic-step-up",
    }


def _password(monkeypatch: pytest.MonkeyPatch, actor: User, action=None) -> None:
    def verify(self, email: str, password: str) -> UUID:
        assert email == actor.email
        if action is not None:
            action()
        return actor.id

    monkeypatch.setattr(
        "app.systems.sandbox.lifecycle.password.ProviderPasswordGrantClient.verify_password", verify
    )


def test_report_event_purge_requires_admin_flag_archive_and_exact_confirmation(
    purge_target,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db, actor, target, path, api = purge_target
    ordinary = _actor(db, admin=False)
    db.commit()
    with client(db, ordinary, report_router, event_router) as denied:
        assert denied.post(f"{path}/purge/preview").status_code == 403
        assert (
            denied.post(
                f"{path}/purge",
                json={"token": "absent", "confirmation_name": "name", "password": "private"},
            ).status_code
            == 403
        )
    assert api.post(f"{path}/purge/preview").status_code == 409
    _archive(db, target)
    settings_path = (
        "app.systems.openview.reports.purge_router.get_settings"
        if isinstance(target, Report)
        else "app.systems.boards.event_purge_router.get_settings"
    )
    with monkeypatch.context() as patch:
        patch.setattr(settings_path, lambda: SimpleNamespace(lifecycle_purge_enabled=False))
        disabled = api.post(f"{path}/purge/preview")
        assert disabled.status_code == 403
        assert (
            disabled.json()["detail"]["message"]
            == "Permanent delete is turned off for this installation."
        )
    preview = api.post(f"{path}/purge/preview")
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["last_successful_backup_at"] is None
    assert body["confirmation_name"] == (
        target.name if isinstance(target, Report) else target.title
    )
    assert body["impact"]["target_type"] == (
        "report" if isinstance(target, Report) else "board_event"
    )
    assert preview.headers["Cache-Control"] == "no-store"
    wrong = api.post(f"{path}/purge", json={**_payload(body), "confirmation_name": "wrong"})
    assert wrong.status_code == 422
    _password(monkeypatch, actor)
    deleted = api.post(f"{path}/purge", json=_payload(body))
    assert deleted.status_code == 200, deleted.text
    assert db.get(type(target), target.id) is None
    assert api.post(f"{path}/purge", json=_payload(body)).status_code != 200
    assert (
        db.scalar(
            select(AuditLog.id).where(AuditLog.entity_id == target.id, AuditLog.action == "delete")
        )
        is not None
    )


@pytest.mark.parametrize(
    "failure", [LifecycleInvalidCredentials, LifecyclePasswordServiceUnavailable]
)
def test_report_event_password_failure_keeps_target(purge_target, monkeypatch, failure) -> None:
    db, actor, target, path, api = purge_target
    _archive(db, target)
    preview = api.post(f"{path}/purge/preview")
    assert preview.status_code == 200, preview.text

    def fail() -> None:
        raise failure("Controlled failure")

    _password(monkeypatch, actor, fail)
    result = api.post(f"{path}/purge", json=_payload(preview.json()))
    assert result.status_code == failure.status_code
    assert db.get(type(target), target.id) is not None


@pytest.mark.parametrize("change", ["rename", "restore", "downgrade", "disable"])
def test_report_event_rechecks_after_password_without_deleting(
    purge_target, monkeypatch, change
) -> None:
    db, actor, target, path, api = purge_target
    _archive(db, target)
    preview = api.post(f"{path}/purge/preview")
    assert preview.status_code == 200, preview.text
    settings_path = (
        "app.systems.openview.reports.purge_router.get_settings"
        if isinstance(target, Report)
        else "app.systems.boards.event_purge_router.get_settings"
    )

    def changed() -> None:
        if change == "rename":
            if isinstance(target, Report):
                target.name = "Changed name"
            else:
                target.title = "Changed name"
        elif change == "restore":
            if isinstance(target, Report):
                target.is_deleted, target.deleted_at = False, None
            else:
                target.archived = False
        elif change == "downgrade":
            membership_of(db, actor.id).role = "member"
        else:
            monkeypatch.setattr(
                settings_path, lambda: SimpleNamespace(lifecycle_purge_enabled=False)
            )
        db.commit()

    _password(monkeypatch, actor, changed)
    result = api.post(f"{path}/purge", json=_payload(preview.json()))
    expected_status = {"rename": 409, "restore": 409, "downgrade": 403, "disable": 403}
    assert result.status_code == expected_status[change], result.text
    assert db.get(type(target), target.id) is not None


def test_report_event_commit_failure_rolls_back(purge_target, monkeypatch) -> None:
    db, actor, target, path, api = purge_target
    _archive(db, target)
    preview = api.post(f"{path}/purge/preview")
    assert preview.status_code == 200, preview.text
    original = db.commit

    def fail_delete_commit() -> None:
        if any(isinstance(row, BaseModel) for row in db.deleted):
            raise IntegrityError("controlled conflict", {}, RuntimeError("conflict"))
        original()

    monkeypatch.setattr(db, "commit", fail_delete_commit)
    _password(monkeypatch, actor)
    result = api.post(f"{path}/purge", json=_payload(preview.json()))
    assert result.status_code == 409, result.text
    assert db.get(type(target), target.id) is not None


def test_report_event_challenge_is_bound_to_actor_and_target(purge_target) -> None:
    db, actor, target, path, api = purge_target
    _archive(db, target)
    if isinstance(target, Report):
        other = Report(org_id=target.org_id,
                       module_id=target.module_id, name=target.name, recipe=target.recipe)
    else:
        other = BoardEvent(
            org_id=target.org_id,
            board_id=target.board_id,
            author_id=actor.id,
            title=target.title,
            all_day=True,
            start_date=target.start_date,
            end_date=target.end_date,
            timezone_name="UTC",
        )
    db.add(other)
    db.flush()
    _archive(db, other)
    preview = api.post(f"{path}/purge/preview")
    assert preview.status_code == 200, preview.text
    body = _payload(preview.json())
    wrong_target_path = path.rsplit("/", 1)[0] + f"/{other.id}/purge"
    wrong_target = api.post(wrong_target_path, json=body)
    assert wrong_target.status_code == 403
    assert wrong_target.json()["detail"]["code"] == "challenge_binding_mismatch"
    another_admin = _actor(db, admin=True)
    db.commit()
    with client(db, another_admin, report_router, event_router) as wrong_actor_api:
        wrong_actor = wrong_actor_api.post(f"{path}/purge", json=body)
    assert wrong_actor.status_code == 403
    assert wrong_actor.json()["detail"]["code"] == "challenge_binding_mismatch"
    missing = api.post(f"{path}/purge", json={**body, "token": "unknown"})
    assert missing.status_code == 404
    if isinstance(target, BoardEvent):
        board = project_board(db)
        db.commit()
        wrong_board = api.post(f"/api/boards/{board.id}/events/{target.id}/purge", json=body)
        assert wrong_board.status_code == 404
    assert db.get(type(target), target.id) is not None
    assert db.get(type(other), other.id) is not None


@pytest.mark.parametrize("outcome", ["success", "child_change", "flush_failure"])
def test_event_purge_inventories_children_keeps_sources_and_rolls_back(
    integration_owner_db: Session,
    monkeypatch,
    outcome: str,
) -> None:
    from uuid6 import uuid7

    db = integration_owner_db
    actor = _actor(db, admin=True)
    board = project_board(db)
    module, _ = _module(db)
    event = BoardEvent(
        org_id=board.org_id,
        board_id=board.id,
        author_id=actor.id,
        title="Retained event",
        details="Private event body",
        archived=True,
        all_day=True,
        start_date=date(2026, 10, 8),
        end_date=date(2026, 10, 8),
        timezone_name="UTC",
    )
    record = Record(org_id=module.org_id, module_id=module.id, data={"name": "Source remains"})
    file = File(
        org_id=board.org_id,
        purpose="board_attachment",
        board_id=board.id,
        creator_id=actor.id,
        filename="retained.txt",
        expected_size=1,
        actual_size=1,
        digest="a" * 64,
        object_key=uuid7().hex,
        state="ready",
    )
    db.add_all([event, record, file])
    db.flush()
    attachment = BoardAttachment(org_id=board.org_id,
                                 board_id=board.id, event_id=event.id, file_id=file.id)
    link = BoardRecordLink(
        org_id=board.org_id,
        board_id=board.id, event_id=event.id, module_id=module.id, record_id=record.id
    )
    reminder = BoardEventReminder(org_id=board.org_id,
                                  board_id=board.id, event_id=event.id, timing="start")
    db.add_all([attachment, link, reminder])
    db.flush()
    instant = datetime.now(UTC)
    work = ScheduledWork(
        org_id=reminder.org_id,
        kind="event-reminder",
        reminder_id=reminder.id,
        occurrence_start_at=instant,
        scheduled_for=instant,
        next_attempt_at=instant,
        state="succeeded",
    )
    db.add(work)
    db.flush()
    notice = InAppNotification(
        org_id=work.org_id,
        work_id=work.id,
        recipient_id=actor.id,
        kind="event-reminder",
        subject_type="board_event",
        subject_id=event.id,
    )
    db.add(notice)
    db.commit()
    children = [event, attachment, link, reminder, work, notice]
    identities = [(type(row), row.id) for row in children]
    path = f"/api/boards/{board.id}/events/{event.id}/purge"
    monkeypatch.setattr(
        "app.systems.boards.event_purge_router.get_settings",
        lambda: SimpleNamespace(lifecycle_purge_enabled=True),
    )
    with client(db, actor, event_router) as api:
        preview = api.post(f"{path}/preview")
        assert preview.status_code == 200, preview.text
        assert {row["entity_type"] for row in preview.json()["impact"]["rows"]} == {
            "board_events",
            "board_attachments",
            "board_record_links",
            "board_event_reminders",
            "scheduled_work",
            "in_app_notifications",
        }
        assert "Private event body" not in str(preview.json()["impact"])

        def step_up_action() -> None:
            if outcome == "child_change":
                work.attempt_count += 1
                db.commit()

        _password(monkeypatch, actor, step_up_action)
        if outcome == "flush_failure":
            actual = db.flush

            def conflict_after_flush(*args, **kwargs):
                deleting = bool(db.deleted)
                actual(*args, **kwargs)
                if deleting:
                    raise IntegrityError("controlled child conflict", {}, RuntimeError("conflict"))

            monkeypatch.setattr(db, "flush", conflict_after_flush)
        result = api.post(path, json=_payload(preview.json()))
        assert result.status_code == (200 if outcome == "success" else 409), result.text
    for model, entity_id in identities:
        assert (db.get(model, entity_id) is None) == (outcome == "success")
    assert db.get(File, file.id).object_key == file.object_key
    assert db.get(File, file.id).state == "ready"
    assert db.get(Record, record.id).data == {"name": "Source remains"}
    assert board.revision == (2 if outcome == "success" else 1)
