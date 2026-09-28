"""A Board file has one durable parent and is never a generic file capability."""

from datetime import date
from io import BytesIO
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from PIL import Image
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.access.users.models import User
from app.systems.boards.attachment_models import BoardAttachment
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board
from app.systems.platform.files import service
from app.systems.platform.files.access import authorize
from app.systems.platform.files.lifecycle_router import purge_impact
from app.systems.platform.files.models import File
from app.systems.platform.files.purge import purge_confirmed
from app.systems.platform.files.scan_processing import process_next
from app.systems.platform.files.schemas import BoardFileCreate, FileCreate
from tests.files.test_integration import Clean, Store

pytestmark = pytest.mark.integration


def _file(actor, *, purpose: str, board_id=None, record_id=None) -> File:
    item = File(
        purpose=purpose,
        record_id=record_id,
        creator_id=actor.id,
        filename="notice.pdf",
        expected_size=100,
        object_key=uuid4().hex,
        state="awaiting_upload",
    )
    item.board_id = board_id
    return item


def test_board_file_requires_exactly_one_board_parent_and_restricts_board_delete(guarded_db, actor):
    db = guarded_db
    board = Board(scope="project", name="Attached files", status="active")
    db.add(board)
    db.flush()

    valid = _file(actor, purpose="board_attachment", board_id=board.id)
    db.add(valid)
    db.flush()
    assert valid.board_id == board.id

    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(_file(actor, purpose="board_attachment"))
            db.flush()
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(_file(actor, purpose="library_document", board_id=board.id))
            db.flush()

    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.delete(board)
            db.flush()


def test_board_file_cannot_move_to_another_board(guarded_db, actor):
    db = guarded_db
    original = Board(scope="project", name="Original", status="active")
    other = Board(scope="project", name="Other", status="active")
    db.add_all((original, other))
    db.flush()
    item = _file(actor, purpose="board_attachment", board_id=original.id)
    db.add(item)
    db.flush()

    with pytest.raises(IntegrityError):
        with db.begin_nested():
            item.board_id = other.id
            db.flush()


def test_board_file_purpose_is_not_granted_by_generic_file_authorization(guarded_db, actor):
    with pytest.raises(HTTPException) as caught:
        authorize(guarded_db, actor, "board_attachment", write=True)
    assert caught.value.status_code == 403


def test_board_file_requires_context_for_reserve_upload_scan_and_download(
    guarded_db, actor, monkeypatch
):
    db = guarded_db
    board = Board(scope="project", name="Private files", status="active")
    other = Board(scope="project", name="Different Board", status="active")
    db.add_all((board, other))
    db.commit()
    output = BytesIO()
    Image.new("RGB", (2, 2)).save(output, format="PNG")
    content = output.getvalue()
    with pytest.raises(ValidationError):
        FileCreate(purpose="board_attachment", filename="image.png", expected_size=len(content))
    reserved = service.reserve_board(
        db, actor, board.id, BoardFileCreate(filename="image.png", expected_size=len(content))
    )
    assert reserved.board_id == board.id and reserved.record_id is None
    store = Store(db)
    for context in (None, other.id):
        with pytest.raises(HTTPException) as caught:
            service.upload(db, actor.id, reserved.id, content, store, board_id=context)
        assert caught.value.status_code == 404
        db.rollback()
    uploaded = service.upload(db, actor.id, reserved.id, content, store, board_id=board.id)
    assert uploaded.state == "pending_scan"
    with pytest.raises(HTTPException) as caught:
        service.scan(db, actor.id, reserved.id)
    assert caught.value.status_code == 404
    db.rollback()
    assert service.scan(db, actor.id, reserved.id, board_id=board.id).state == "pending_scan"
    assert process_next(db, store, Clean()) is True
    assert db.get(File, reserved.id).state == "ready"
    with pytest.raises(HTTPException) as caught:
        service.download(db, actor.id, reserved.id, store)
    assert caught.value.status_code == 403
    db.rollback()
    monkeypatch.setattr(
        "app.systems.platform.files.lifecycle_router.get_settings",
        lambda: type("Settings", (), {"lifecycle_purge_enabled": True})(),
    )
    with pytest.raises(HTTPException) as caught:
        purge_impact(db, actor.id, reserved.id)
    assert caught.value.status_code == 404


def test_board_archive_suspends_pending_scan(guarded_db, actor):
    db = guarded_db
    board = Board(scope="project", name="Paused files", status="active")
    db.add(board)
    db.commit()
    output = BytesIO()
    Image.new("RGB", (2, 2)).save(output, format="PNG")
    content = output.getvalue()
    reserved = service.reserve_board(
        db, actor, board.id, BoardFileCreate(filename="image.png", expected_size=len(content))
    )
    store = Store(db)
    service.upload(db, actor.id, reserved.id, content, store, board_id=board.id)
    board.status = "archived"
    db.commit()
    assert process_next(db, store, Clean()) is False
    item = db.get(File, reserved.id)
    assert item.state == "pending_scan" and item.failure_code == "scan_suspended"


def test_board_file_uncertain_upload_reconciles_only_in_owning_board(guarded_db, actor):
    db = guarded_db
    board = Board(scope="project", name="Recovery board", status="active")
    other = Board(scope="project", name="Other recovery board", status="active")
    db.add_all((board, other))
    db.commit()
    output = BytesIO()
    Image.new("RGB", (2, 2)).save(output, format="PNG")
    content = output.getvalue()
    reserved = service.reserve_board(
        db, actor, board.id, BoardFileCreate(filename="image.png", expected_size=len(content))
    )
    store = Store(db)
    store.fail_upload = True
    with pytest.raises(HTTPException) as caught:
        service.upload(db, actor.id, reserved.id, content, store, board_id=board.id)
    assert caught.value.detail["code"] == "upload_unresolved"
    for context in (None, other.id):
        with pytest.raises(HTTPException) as denied:
            service.reconcile(db, actor.id, reserved.id, store, board_id=context)
        assert denied.value.status_code == 404
        db.rollback()
    assert (
        service.reconcile(db, actor.id, reserved.id, store, board_id=board.id).state
        == "pending_scan"
    )


def test_global_records_writer_without_board_grant_cannot_reserve_or_upload(guarded_db, actor):
    db = guarded_db
    board = Board(scope="project", name="Owner only", status="active")
    role = "member"
    db.add(board)
    db.flush()
    identity = uuid7()
    outsider = User(
        id=identity,
        email=f"outsider-{identity.hex}@example.test",
        username=f"outsider_{identity.hex[:16]}",
        status="active",
        role=role,
    )
    db.add(outsider)
    db.commit()
    payload = BoardFileCreate(filename="image.png", expected_size=100)
    with pytest.raises(HTTPException) as caught:
        service.reserve_board(db, outsider, board.id, payload)
    assert caught.value.status_code == 404
    db.rollback()
    reserved = service.reserve_board(db, actor, board.id, payload)
    with pytest.raises(HTTPException) as caught:
        service.upload(db, outsider.id, reserved.id, b"x" * 100, Store(db), board_id=board.id)
    assert caught.value.status_code == 404


def test_board_file_purge_waits_for_content_unlink_then_removes_bytes(
    guarded_db, actor, monkeypatch
):
    db = guarded_db
    board = Board(scope="project", name="File purge", status="active")
    db.add(board)
    db.flush()
    event = BoardEvent(
        board_id=board.id,
        author_id=actor.id,
        title="Attached event",
        all_day=True,
        start_date=date(2026, 9, 24),
        end_date=date(2026, 9, 24),
        timezone_name="Asia/Manila",
    )
    db.add(event)
    db.flush()
    file = File(
        purpose="board_attachment",
        board_id=board.id,
        record_id=None,
        creator_id=actor.id,
        filename="notice.pdf",
        expected_size=3,
        actual_size=3,
        digest="a" * 64,
        scanner_version="test",
        signature_version="test",
        object_key=uuid4().hex,
        state="ready",
    )
    db.add(file)
    db.flush()
    link = BoardAttachment(board_id=board.id, file_id=file.id, event_id=event.id)
    db.add(link)
    db.commit()

    def enabled():
        return SimpleNamespace(lifecycle_purge_enabled=True)

    monkeypatch.setattr("app.systems.platform.files.lifecycle_router.get_settings", enabled)
    monkeypatch.setattr("app.systems.platform.files.purge.get_settings", enabled)
    with pytest.raises(HTTPException) as caught:
        service.archive(db, actor.id, file.id, board_id=board.id)
    assert caught.value.detail["code"] == "file_linked"
    db.rollback()
    link.is_linked = False
    db.commit()
    service.archive(db, actor.id, file.id, board_id=board.id)
    assert purge_impact(db, actor.id, file.id, board_id=board.id).target_id == file.id
    store = Store(db)
    assert purge_confirmed(db, actor.id, file.id, store, board_id=board.id).state == "purged"
