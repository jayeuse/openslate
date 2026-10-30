"""A linked file follows its Board and its post or event, not its bare identifier."""

from datetime import UTC, date, datetime
from hashlib import sha256
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.boards.attachment_models import (
    BoardAttachment,
    BoardPostRevisionAttachment,
)
from app.systems.boards.attachment_router import router as content_router
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.post_models import (
    BoardPost,
    BoardPostRevision,
    publication_content_fingerprint,
)
from app.systems.platform.files.board_router import router as board_file_router
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import transfer_admission
from app.systems.platform.files.router import router as generic_file_router
from app.systems.platform.files.storage import get_storage
from tests.boards.support import board_group
from tests.conftest import create_member
from tests.files.test_integration import Store
from tests.organization_scope_support import scoped_override
from tests.rbac.support import organization

pytestmark = pytest.mark.integration


def _client(db, actor, store) -> TestClient:
    app = FastAPI()
    app.include_router(board_file_router, prefix="/api")
    app.include_router(content_router, prefix="/api")
    app.include_router(generic_file_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = scoped_override(lambda: actor)
    app.dependency_overrides[get_storage] = lambda: store

    @app.middleware("http")
    async def admitted(request, call_next):
        with transfer_admission() as lease:
            request.state.file_transfer_lease = lease
            return await call_next(request)

    return TestClient(app)


def test_event_file_context_hides_bare_id_other_board_and_outsiders(
    guarded_db, actor, monkeypatch
):
    db = guarded_db
    board = Board(org_id=organization(db).id, scope="project", name="Operations", status="active")
    other = Board(org_id=board.org_id, scope="project", name="Other", status="active")
    db.add_all((board, other))
    db.flush()
    event = BoardEvent(
        org_id=board.org_id,
        board_id=board.id, author_id=actor.id, title="Author only", all_day=True,
        start_date=date(2026, 9, 24), end_date=date(2026, 9, 24),
        timezone_name="Asia/Manila",
    )
    db.add(event)
    db.flush()
    content = b"private board bytes"
    file = File(
        org_id=board.org_id,
        purpose="board_attachment", board_id=board.id, record_id=None,
        creator_id=actor.id, filename="notice.pdf", expected_size=len(content),
        actual_size=len(content), digest=sha256(content).hexdigest(),
        object_key=uuid4().hex,
        media_type="application/pdf", state="ready",
    )
    db.add(file)
    db.commit()
    store = Store(db)
    store.objects[file.object_key] = content
    events = []
    monkeypatch.setattr(
        "app.systems.boards.attachment_router.append_committed_security_event",
        lambda event, **_kwargs: events.append(event)
    )
    with _client(db, actor, store) as client:
        assert client.get(f"/api/files/{file.id}").status_code == 403
        assert client.get(f"/api/files/{file.id}/content").status_code == 403
        assert client.get(f"/api/boards/{other.id}/files/{file.id}").status_code == 404
        response = client.post(
            f"/api/boards/{board.id}/events/{event.id}/attachments",
            json={"file_id": str(file.id), "board_revision": 1, "content_revision": 1},
        )
        assert response.status_code == 200, response.text
        result = client.get(f"/api/boards/{board.id}/events/{event.id}/attachments")
        assert result.status_code == 200 and result.json()["items"][0]["id"] == str(file.id)
        result = client.get(
            f"/api/boards/{board.id}/events/{event.id}/attachments/{file.id}/content"
        )
        assert result.status_code == 200 and result.content == content
        assert result.headers["cache-control"] == "no-store"
    assert len(events) == 1

    reader_id = uuid4()
    reader, _reader_membership = create_member(db, organization(db),
        id=reader_id, email=f"excluded-{reader_id.hex}@example.test",
        username=f"excluded_{reader_id.hex[:12]}", status="active", role="member",
    )
    db.add(reader)
    db.commit()
    with _client(db, reader, store) as client:
        for url in (
            f"/api/boards/{board.id}/events/{event.id}/attachments",
            f"/api/boards/{board.id}/events/{event.id}/attachments/{file.id}/content",
        ):
            result = client.get(url)
            assert result.status_code == 404
            assert result.headers["cache-control"] == "no-store"
    assert db.scalar(select(File.id).where(File.id == file.id)) == file.id


def test_published_post_file_uses_the_published_snapshot_for_readers(
    guarded_db, actor, monkeypatch
):
    db = guarded_db
    reader_id = uuid4()
    reader, _reader_membership = create_member(db, organization(db),
        id=reader_id, email=f"eligible-{reader_id.hex}@example.test",
        username=f"eligible_{reader_id.hex[:12]}", status="active", role="member",
    )
    outsider, _outsider_membership = create_member(db, organization(db),
        id=uuid4(), email=f"outsider-{uuid4().hex}@example.test",
        username=f"outsider_{uuid4().hex[:12]}", status="active", role="member",
    )
    board = Board(org_id=organization(db).id,
                  scope="project", name="Private notice", status="active")
    db.add_all((reader, outsider, board))
    db.flush()
    board_group(db, board, [reader], "read")
    notice = BoardPost(
        org_id=board.org_id,
        board_id=board.id, author_id=actor.id, title="Draft for author",
        body="Previous publication", status="published",
        displayed_publication_number=1,
    )
    content = b"published attachment"
    file = File(
        org_id=board.org_id,
        purpose="board_attachment", board_id=board.id, record_id=None,
        creator_id=actor.id, filename="published.pdf", expected_size=len(content),
        actual_size=len(content), digest=sha256(content).hexdigest(),
        object_key=uuid4().hex,
        state="ready", media_type="application/pdf",
    )
    db.add_all((notice, file))
    db.flush()
    revision = BoardPostRevision(
        org_id=notice.org_id,
        post_id=notice.id, publication_number=1, publication_key=uuid4(),
        content_fingerprint=publication_content_fingerprint(
            author_id=actor.id, title="Published for reader", body="Previous publication",
        ),
        author_id=actor.id, title="Published for reader", body="Previous publication",
        published_at=datetime.now(UTC),
    )
    db.add(revision)
    db.flush()
    db.add(BoardAttachment(
        org_id=board.org_id,
        board_id=board.id, file_id=file.id, post_id=notice.id, is_linked=False
    ))
    db.flush()
    db.add(BoardPostRevisionAttachment(org_id=revision.org_id,
                                       revision_id=revision.id, file_id=file.id))
    db.commit()
    store = Store(db)
    store.objects[file.object_key] = content
    logged = []
    monkeypatch.setattr(
        "app.systems.boards.attachment_router.append_committed_security_event",
        lambda event, **_kwargs: logged.append(event)
    )
    path = f"/api/boards/{board.id}/posts/{notice.id}/attachments"
    with _client(db, outsider, store) as client:
        assert client.get(path).status_code == 404
        denied = client.get(f"{path}/{file.id}/content")
        assert denied.status_code == 404
        assert denied.headers["cache-control"] == "no-store"
    with _client(db, reader, store) as client:
        assert client.get(f"{path}?view=draft").status_code == 404
        result = client.get(path)
        assert result.status_code == 200
        assert result.json()["items"][0]["id"] == str(file.id)
        downloaded = client.get(f"{path}/{file.id}/content")
        assert downloaded.status_code == 200 and downloaded.content == content
    assert len(logged) == 1


def test_viewer_can_read_linked_event_attachment_after_board_archive_but_cannot_write(
    guarded_db, actor, monkeypatch
):
    db = guarded_db
    reader_role = "member"
    viewer, _membership = create_member(db, organization(db),
        id=uuid4(),
        email=f"archived-viewer-{uuid4().hex}@example.test",
        username=f"archived_viewer_{uuid4().hex[:12]}",
        status="active",
        role=reader_role,
    )
    board = Board(org_id=organization(db).id,
                  scope="project", name="Archived Board", status=BoardStatus.ACTIVE)
    db.add_all((viewer, board))
    db.flush()
    board_group(db, board, [viewer], "read")
    event = BoardEvent(
        org_id=board.org_id,
        board_id=board.id,
        author_id=actor.id,
        title="Retained event",
        all_day=True,
        start_date=date(2026, 9, 24),
        end_date=date(2026, 9, 24),
        timezone_name="Asia/Manila",
    )
    content = b"retained event attachment"
    file = File(
        org_id=board.org_id,
        purpose="board_attachment",
        board_id=board.id,
        record_id=None,
        creator_id=actor.id,
        filename="retained.pdf",
        expected_size=len(content),
        actual_size=len(content),
        digest=sha256(content).hexdigest(),
        object_key=uuid4().hex,
        media_type="application/pdf",
        state="ready",
    )
    db.add_all((event, file))
    db.flush()
    db.add(BoardAttachment(org_id=board.org_id,
                           board_id=board.id, file_id=file.id, event_id=event.id))
    db.commit()
    store = Store(db)
    store.objects[file.object_key] = content
    monkeypatch.setattr(
        "app.systems.boards.attachment_router.append_committed_security_event",
        lambda _event, **_kwargs: None,
    )

    with _client(db, viewer, store) as client:
        denied_write = client.request(
            "DELETE",
            f"/api/boards/{board.id}/events/{event.id}/attachments/{file.id}",
            json={"board_revision": board.revision, "content_revision": event.revision},
        )
    assert denied_write.status_code == 404

    board.status = BoardStatus.ARCHIVED
    db.commit()
    with _client(db, viewer, store) as client:
        listing = client.get(f"/api/boards/{board.id}/events/{event.id}/attachments")
        downloaded = client.get(
            f"/api/boards/{board.id}/events/{event.id}/attachments/{file.id}/content"
        )
        refused_write = client.request(
            "DELETE",
            f"/api/boards/{board.id}/events/{event.id}/attachments/{file.id}",
            json={"board_revision": board.revision, "content_revision": event.revision},
        )

    assert listing.status_code == 200
    assert listing.json()["items"][0]["id"] == str(file.id)
    assert downloaded.status_code == 200 and downloaded.content == content
    assert refused_write.status_code == 409


def test_archived_board_attachment_stays_hidden_from_outsiders(
    guarded_db, actor, monkeypatch
):
    db = guarded_db
    board = Board(org_id=organization(db).id,
                  scope="project", name="Archived audience Board", status=BoardStatus.ACTIVE)
    db.add(board)
    db.flush()
    event = BoardEvent(
        org_id=board.org_id,
        board_id=board.id,
        author_id=actor.id,
        title="Author only",
        all_day=True,
        start_date=date(2026, 9, 24),
        end_date=date(2026, 9, 24),
        timezone_name="Asia/Manila",
    )
    file = File(
        org_id=board.org_id,
        purpose="board_attachment",
        board_id=board.id,
        record_id=None,
        creator_id=actor.id,
        filename="private.pdf",
        expected_size=3,
        actual_size=3,
        digest=sha256(b"own").hexdigest(),
        object_key=uuid4().hex,
        state="ready",
        media_type="application/pdf",
    )
    db.add_all((event, file))
    db.flush()
    db.add(BoardAttachment(org_id=board.org_id,
                           board_id=board.id, file_id=file.id, event_id=event.id))
    db.commit()
    board.status = BoardStatus.ARCHIVED
    db.commit()
    excluded, _membership = create_member(db, organization(db),
        id=uuid4(),
        email=f"archived-excluded-{uuid4().hex}@example.test",
        username=f"archived_excluded_{uuid4().hex[:12]}",
        status="active",
        role="member",
    )
    db.add(excluded)
    db.commit()
    store = Store(db)
    store.objects[file.object_key] = b"own"
    monkeypatch.setattr(
        "app.systems.boards.attachment_router.append_committed_security_event",
        lambda _event, **_kwargs: None,
    )

    with _client(db, excluded, store) as client:
        listing = client.get(f"/api/boards/{board.id}/events/{event.id}/attachments")
        downloaded = client.get(
            f"/api/boards/{board.id}/events/{event.id}/attachments/{file.id}/content"
        )

    assert listing.status_code == 404
    assert downloaded.status_code == 404


def test_a_detached_file_cannot_move_to_other_content(guarded_db, actor):
    """One lifetime owner per file: sample runs upload a second file for the event."""
    db = guarded_db
    board = Board(org_id=organization(db).id,
                  scope="project", name="Single owner", status=BoardStatus.ACTIVE)
    db.add(board)
    db.flush()
    first, second = (
        BoardEvent(
            org_id=board.org_id,
            board_id=board.id, author_id=actor.id, title=title, all_day=True,
            start_date=date(2026, 9, 24), end_date=date(2026, 9, 24),
            timezone_name="Asia/Manila",
        )
        for title in ("First owner", "Second owner")
    )
    content = b"single owner bytes"
    file = File(
        org_id=board.org_id,
        purpose="board_attachment", board_id=board.id, record_id=None,
        creator_id=actor.id, filename="owner.pdf", expected_size=len(content),
        actual_size=len(content), digest=sha256(content).hexdigest(),
        object_key=uuid4().hex, media_type="application/pdf", state="ready",
    )
    db.add_all((first, second, file))
    db.commit()

    def versions(event: BoardEvent) -> dict[str, int]:
        db.refresh(board)
        db.refresh(event)
        return {"board_revision": board.revision, "content_revision": event.revision}

    with _client(db, actor, Store(db)) as client:
        base = f"/api/boards/{board.id}/events"
        attached = client.post(
            f"{base}/{first.id}/attachments", json={"file_id": str(file.id), **versions(first)}
        )
        detached = client.request(
            "DELETE", f"{base}/{first.id}/attachments/{file.id}", json=versions(first)
        )
        moved = client.post(
            f"{base}/{second.id}/attachments", json={"file_id": str(file.id), **versions(second)}
        )

    assert attached.status_code == 200, attached.text
    assert detached.status_code == 204
    assert moved.status_code == 409
    assert moved.json()["detail"]["code"] == "file_already_owned"
