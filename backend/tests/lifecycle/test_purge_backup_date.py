"""Every purge preview reports historical backup success for the current installation."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import router as events
from app.systems.boards.lifecycle_router import router as boards
from app.systems.manage.backups.models import BackupRun
from app.systems.manage.backups.service import installation_id
from app.systems.openview.reports.models import Report
from app.systems.openview.reports.router import router as reports
from app.systems.platform.files.board_router import router as board_files
from app.systems.platform.files.lifecycle_router import router as files
from app.systems.platform.files.models import File
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.router import router as lifecycle
from app.systems.sandbox.records.models import Record
from tests.boards.support import client, project_board
from tests.boards.test_permanent_delete import _actor
from tests.rbac.support import organization
from tests.reports.test_report_routes import _module, _recipe
from tests.sandbox_designs.fixtures import create_document

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def sandbox_draft(integration_owner_db):
    create_document(integration_owner_db, organization(integration_owner_db))


def backup(
    db: Session, actor_id, instance: str, finished: datetime, *, state="succeeded"
) -> BackupRun:
    row = BackupRun(
        installation_id=instance,
        name="Synthetic historical backup",
        provenance="manual",
        requester_id=actor_id,
        idempotency_hash=uuid7().hex * 2,
        schedule="disabled",
        retention_days=30,
        requested_at=finished - timedelta(hours=2),
        started_at=finished - timedelta(hours=1),
        finished_at=finished,
        reconciled_at=finished + timedelta(minutes=1),
        verified_at=finished - timedelta(minutes=1) if state == "succeeded" else None,
        state=state,
        claim_id=uuid7(),
        claimed_schedule="disabled",
        claimed_retention_days=30,
        snapshot_id="a" * 64 if state == "succeeded" else None,
        manifest_sha256="b" * 64 if state == "succeeded" else None,
        failure_code=None if state == "succeeded" else "backup_failed",
    )
    db.add(row)
    return row


@pytest.mark.parametrize(
    "kind",
    [
        "department",
        "module",
        "field",
        "record",
        "board",
        "file",
        "board_file",
        "report",
        "board_event",
    ],
)
def test_every_preview_reports_latest_success_fenced_to_installation(
    integration_owner_db: Session, monkeypatch, kind: str
) -> None:
    db = integration_owner_db
    actor = _actor(db, admin=True)
    module, field = _module(db)
    department = db.get(Department, module.department_id)
    record = Record(org_id=module.org_id,
                    module_id=module.id, data={}, is_deleted=True, deleted_at=datetime.now(UTC))
    db.add(record)
    for target in (department, module, field):
        target.is_deleted, target.deleted_at = True, datetime.now(UTC)
    board, file_board = project_board(db), project_board(db)
    board.status = "archived"
    event = BoardEvent(
        org_id=file_board.org_id,
        board_id=file_board.id,
        author_id=actor.id,
        title="Historical event",
        archived=True,
        all_day=True,
        start_date=datetime(2026, 10, 8).date(),
        end_date=datetime(2026, 10, 8).date(),
        timezone_name="UTC",
    )
    report = Report(
        org_id=module.org_id,
        module_id=module.id,
        name="Historical report",
        recipe=_recipe(field),
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    private_file = File(
        org_id=module.org_id,
        purpose="workspace_logo",
        creator_id=actor.id,
        filename="old-logo.png",
        expected_size=1,
        object_key=uuid7().hex,
        state="awaiting_upload",
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    board_file = File(
        org_id=file_board.org_id,
        purpose="board_attachment",
        board_id=file_board.id,
        creator_id=actor.id,
        filename="old-note.txt",
        expected_size=1,
        object_key=uuid7().hex,
        state="awaiting_upload",
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add_all([event, report, private_file, board_file])
    db.commit()
    for module_name in (
        "sandbox.lifecycle.router",
        "boards.lifecycle_router",
        "boards.event_purge_router",
        "openview.reports.purge_router",
        "platform.files.lifecycle_router",
    ):
        monkeypatch.setattr(
            f"app.systems.{module_name}.get_settings",
            lambda: SimpleNamespace(lifecycle_purge_enabled=True),
        )
    paths = {
        "department": f"/api/departments/{department.id}",
        "module": f"/api/modules/{module.id}",
        "field": f"/api/fields/{field.id}",
        "record": f"/api/records/{record.id}",
        "board": f"/api/boards/{board.id}",
        "file": f"/api/files/{private_file.id}",
        "board_file": f"/api/boards/{file_board.id}/files/{board_file.id}",
        "report": f"/api/reports/{report.id}",
        "board_event": f"/api/boards/{file_board.id}/events/{event.id}",
    }
    path = f"{paths[kind]}/purge/preview"
    with client(db, actor, lifecycle, boards, events, reports, files, board_files) as api:
        empty = api.post(path)
        assert empty.status_code == 200, empty.text
        assert empty.json()["last_successful_backup_at"] is None
        instant = datetime(2026, 10, 7, 10, tzinfo=UTC)
        instance = installation_id(db)
        backup(db, actor.id, instance, instant - timedelta(days=1))
        backup(db, actor.id, instance, instant)
        backup(db, actor.id, "different-installation", instant + timedelta(hours=1))
        backup(db, actor.id, instance, instant + timedelta(hours=2), state="failed")
        db.commit()
        result = api.post(path)
        assert result.status_code == 200, result.text
        assert (
            datetime.fromisoformat(
                result.json()["last_successful_backup_at"].replace("Z", "+00:00")
            )
            == instant
        )
        assert result.json()["impact"]["impact_digest"] == empty.json()["impact"]["impact_digest"]
