"""Board deletion inventories file ownership and refuses undisposed bytes."""

from datetime import UTC, date, datetime
from secrets import token_urlsafe
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.boards import lifecycle_router
from app.systems.boards.attachment_models import BoardAttachment
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board
from app.systems.platform.files.board_router import router as board_file_router
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import transfer_admission
from app.systems.platform.files.storage import get_storage
from tests.boards.support import client as board_client
from tests.boards.test_permanent_delete import _actor, _enabled
from tests.files.test_integration import Store
from tests.organization_scope_support import scoped_override
from tests.rbac.support import organization

pytestmark = pytest.mark.integration


def test_board_purge_blocks_unpurged_file_then_deletes_purged_file_and_detached_owner(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    password = token_urlsafe(32)
    admin = _actor(db, admin=True, password=password)
    board = Board(org_id=organization(db).id,
                  scope="project", name="Board with file", status="archived")
    db.add(board)
    db.flush()
    event = BoardEvent(
        org_id=board.org_id,
        board_id=board.id,
        author_id=admin.id,
        title="Old event",
        all_day=True,
        start_date=date(2026, 9, 24),
        end_date=date(2026, 9, 24),
        timezone_name="Asia/Manila",
        archived=True,
    )
    file = File(
        org_id=board.org_id,
        purpose="board_attachment",
        board_id=board.id,
        record_id=None,
        creator_id=admin.id,
        filename="old.pdf",
        expected_size=3,
        object_key=uuid7().hex,
        state="awaiting_upload",
    )
    db.add_all((event, file))
    db.flush()
    ownership = BoardAttachment(
        org_id=board.org_id,
        board_id=board.id, file_id=file.id, event_id=event.id, is_linked=False
    )
    db.add(ownership)
    db.commit()
    _enabled(monkeypatch, True)
    client = board_client(db, admin, lifecycle_router.router)
    path = f"/api/boards/{board.id}/purge"
    denied = client.post(f"{path}/preview")
    assert denied.status_code == 409
    assert db.get(Board, board.id) is not None

    file.state = "purged"
    file.is_deleted = True
    file.deleted_at = datetime.now(UTC)
    db.commit()
    preview = client.post(f"{path}/preview")
    assert preview.status_code == 200, preview.text
    types = {row["entity_type"] for row in preview.json()["impact"]["rows"]}
    assert {"files", "board_attachments"} <= types
    executed = client.post(
        path,
        json={
            "token": preview.json()["token"],
            "confirmation_name": board.name,
            "password": password,
        },
    )
    assert executed.status_code == 200, executed.text
    assert db.get(Board, board.id) is None
    assert db.get(BoardAttachment, ownership.id) is None
    assert db.get(File, file.id) is None


def test_unlinked_board_file_admin_can_preview_and_confirm_purge(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    password = token_urlsafe(32)
    admin = _actor(db, admin=True, password=password)
    board = Board(org_id=organization(db).id,
                  scope="project", name="Purge one file", status="active")
    db.add(board)
    db.flush()
    file = File(
        org_id=board.org_id,
        purpose="board_attachment",
        board_id=board.id,
        record_id=None,
        creator_id=admin.id,
        filename="unused.pdf",
        expected_size=3,
        object_key=uuid7().hex,
        state="awaiting_upload",
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add(file)
    db.commit()

    def enabled() -> SimpleNamespace:
        return SimpleNamespace(lifecycle_purge_enabled=True)

    monkeypatch.setattr("app.systems.platform.files.lifecycle_router.get_settings", enabled)
    monkeypatch.setattr("app.systems.platform.files.board_router.get_settings", enabled)
    monkeypatch.setattr("app.systems.platform.files.purge.get_settings", enabled)
    app = FastAPI()
    app.include_router(board_file_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = scoped_override(lambda: admin)
    app.dependency_overrides[get_storage] = lambda: Store(db)

    @app.middleware("http")
    async def admitted(request, call_next):
        with transfer_admission() as lease:
            request.state.file_transfer_lease = lease
            return await call_next(request)

    path = f"/api/boards/{board.id}/files/{file.id}/purge"
    with TestClient(app) as client:
        preview = client.post(f"{path}/preview")
        assert preview.status_code == 200, preview.text
        executed = client.post(
            path,
            json={
                "token": preview.json()["token"],
                "confirmation_name": file.filename,
                "password": password,
            },
        )
    assert executed.status_code == 200, executed.text
    assert executed.json()["state"] == "purged"
