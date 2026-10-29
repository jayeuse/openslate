"""Objective cards own files and linked records through the Board content routes.

Writers add and remove them, readers list and download them, and a record card is
refused: its files and links belong to its Record.
"""

from datetime import UTC, datetime
from hashlib import sha256
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.attachment_models import BoardAttachment
from app.systems.boards.attachment_router import router as attachment_router
from app.systems.boards.kanban_models import BoardCard
from app.systems.boards.models import Board
from app.systems.boards.record_link_models import BoardRecordLink
from app.systems.boards.record_link_router import router as record_link_router
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import transfer_admission
from app.systems.platform.files.storage import get_storage
from tests.boards.kanban_support import add_objective, add_record_card, add_stage, record_source
from tests.boards.support import grant, guest, member, project_board
from tests.files.test_integration import Store
from tests.organization_scope_support import scoped_override

pytestmark = pytest.mark.integration
CONTENT = b"crane berth plan"


def _api(db: Session, actor: User, store: Store) -> TestClient:
    app = FastAPI()
    app.include_router(attachment_router, prefix="/api")
    app.include_router(record_link_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = scoped_override(lambda: actor)
    app.dependency_overrides[get_storage] = lambda: store

    @app.middleware("http")
    async def admitted(request, call_next):
        with transfer_admission() as lease:
            request.state.file_transfer_lease = lease
            return await call_next(request)

    return TestClient(app)


def _file(db: Session, board: Board, creator: User, store: Store) -> File:
    file = File(
        org_id=board.org_id, purpose="board_attachment", board_id=board.id, record_id=None,
        creator_id=creator.id, filename="berth.pdf", expected_size=len(CONTENT),
        actual_size=len(CONTENT), digest=sha256(CONTENT).hexdigest(), object_key=uuid4().hex,
        media_type="application/pdf", state="ready",
    )
    db.add(file)
    db.flush()
    store.objects[file.object_key] = CONTENT
    return file


def _world(db: Session):
    writer, reader, outsider, capped = member(db), member(db), member(db), guest(db)
    board = project_board(db)
    grant(db, board, [writer], AccessLevel.WRITE)
    grant(db, board, [reader, capped], AccessLevel.READ)
    stage = add_stage(db, board)
    objective = add_objective(db, board, stage, "Prepare berth", 1024)
    return board, stage, objective, writer, reader, outsider, capped


def _versions(db: Session, board: Board, card: BoardCard) -> dict[str, int]:
    db.expire_all()
    return {"board_revision": board.revision, "content_revision": card.revision}


def test_objective_files_writers_attach_and_detach_readers_list_and_download(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    board, _stage, card, writer, reader, outsider, capped = _world(db)
    store = Store(db)
    file = _file(db, board, writer, store)
    db.commit()
    monkeypatch.setattr(
        "app.systems.boards.attachment_router.append_committed_security_event",
        lambda *_args, **_kwargs: None,
    )
    root = f"/api/boards/{board.id}/cards/{card.id}/attachments"
    body = {"file_id": str(file.id), **_versions(db, board, card)}
    assert _api(db, reader, store).post(root, json=body).status_code == 404
    assert _api(db, capped, store).post(root, json=body).status_code == 403
    attached = _api(db, writer, store).post(root, json=body)
    assert attached.status_code == 200, attached.text
    owner = db.scalar(select(BoardAttachment).where(BoardAttachment.file_id == file.id))
    assert owner is not None and owner.card_id == card.id and owner.post_id is None
    assert _versions(db, board, card)["content_revision"] == 2

    with _api(db, reader, store) as api:
        listed = api.get(root)
        assert listed.status_code == 200, listed.text
        assert [item["id"] for item in listed.json()["items"]] == [str(file.id)]
        downloaded = api.get(f"{root}/{file.id}/content")
        assert downloaded.status_code == 200 and downloaded.content == CONTENT
    for url in (root, f"{root}/{file.id}/content"):
        assert _api(db, outsider, store).get(url).status_code == 404

    detached = _api(db, writer, store).request(
        "DELETE", f"{root}/{file.id}", json=_versions(db, board, card)
    )
    assert detached.status_code == 204, detached.text
    assert _api(db, reader, store).get(root).json()["items"] == []


def test_objective_record_links_follow_record_access(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, _stage, card, writer, reader, outsider, _capped = _world(db)
    source = record_source(db, writer, reader)
    hidden = record_source(db, writer)
    db.commit()
    store = Store(db)
    root = f"/api/boards/{board.id}/cards/{card.id}/record-links"
    payload = {"record_id": str(source.record.id), **_versions(db, board, card)}
    assert _api(db, reader, store).post(root, json=payload).status_code == 404
    created = _api(db, writer, store).post(root, json=payload)
    assert created.status_code == 201, created.text
    assert created.headers["Location"] == f"{root}/{created.json()['id']}"
    assert created.json()["label"] == "Harbor crane quote"
    second = _api(db, writer, store).post(
        root, json={"record_id": str(hidden.record.id), **_versions(db, board, card)}
    )
    assert second.status_code == 201, second.text
    stored = db.scalars(select(BoardRecordLink).where(BoardRecordLink.card_id == card.id)).all()
    assert len(stored) == 2

    listed = _api(db, reader, store).get(root)
    assert listed.status_code == 200, listed.text
    assert [(item["label"], item["available"]) for item in listed.json()["items"]] == [
        ("Harbor crane quote", True), ("Record unavailable", False),
    ]
    assert _api(db, outsider, store).get(root).status_code == 404

    removed = _api(db, writer, store).request(
        "DELETE", f"{root}/{created.json()['id']}", json=_versions(db, board, card)
    )
    assert removed.status_code == 204, removed.text
    assert len(_api(db, writer, store).get(root).json()["items"]) == 1


def test_a_record_card_refuses_files_and_links_and_an_archived_card_keeps_its_files(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    board, stage, card, writer, reader, *_ = _world(db)
    source = record_source(db, writer, reader)
    record_card = add_record_card(db, board, stage, source.record, 2048)
    store = Store(db)
    file, other = _file(db, board, writer, store), _file(db, board, writer, store)
    db.commit()
    monkeypatch.setattr(
        "app.systems.boards.attachment_router.append_committed_security_event",
        lambda *_args, **_kwargs: None,
    )
    base = f"/api/boards/{board.id}/cards"
    refused = (
        ("POST", f"{base}/{record_card.id}/attachments",
         {"file_id": str(file.id), **_versions(db, board, record_card)}),
        ("POST", f"{base}/{record_card.id}/record-links",
         {"record_id": str(source.record.id), **_versions(db, board, record_card)}),
        ("GET", f"{base}/{record_card.id}/attachments", None),
        ("GET", f"{base}/{record_card.id}/record-links", None),
    )
    for method, url, body in refused:
        response = _api(db, writer, store).request(method, url, json=body)
        assert response.status_code == 409, (url, response.text)
        assert response.json()["detail"]["code"] == "card_objectives_only"
    assert db.scalar(select(BoardAttachment.id).where(BoardAttachment.file_id == file.id)) is None

    root = f"{base}/{card.id}/attachments"
    attached = _api(db, writer, store).post(
        root, json={"file_id": str(file.id), **_versions(db, board, card)}
    )
    assert attached.status_code == 200, attached.text
    db.expire_all()
    card.archived_at = datetime.now(UTC)
    db.commit()
    blocked = _api(db, writer, store).post(
        root, json={"file_id": str(other.id), **_versions(db, board, card)}
    )
    assert blocked.status_code == 409 and blocked.json()["detail"]["code"] == "card_archived"
    with _api(db, reader, store) as api:
        assert [item["id"] for item in api.get(root).json()["items"]] == [str(file.id)]
        assert api.get(f"{root}/{file.id}/content").content == CONTENT
