"""Board purge removes Record-link children but preserves the source Record."""

from datetime import UTC, date, datetime
from secrets import token_urlsafe

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.record_link_models import (
    BoardPostRevisionRecordLink,
    BoardRecordLink,
)
from app.systems.sandbox.records.models import Record
from tests.boards.test_permanent_delete import _actor, _client, _enabled
from tests.boards.test_record_links import _source

pytestmark = pytest.mark.integration


def test_board_purge_removes_record_links_and_snapshots_without_purging_source(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    password = token_urlsafe(32)
    admin = _actor(db, admin=True, password=password)
    board = Board(scope="project", name="Purge linked Board", status="archived")
    module, record = _source(db)
    db.add(board)
    db.flush()
    event = BoardEvent(
        board_id=board.id,
        author_id=admin.id,
        title="Retained event",
        all_day=True,
        start_date=date(2026, 9, 24),
        end_date=date(2026, 9, 24),
        timezone_name="UTC",
        archived=True,
    )
    notice = BoardPost(
        board_id=board.id,
        author_id=admin.id,
        title="Archived notice",
        body="Retained",
        status="archived",
    )
    db.add_all((event, notice))
    db.flush()
    revision = BoardPostRevision(
        post_id=notice.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=admin.id,
        title="Published notice",
        body="Retained",
        published_at=datetime.now(UTC),
    )
    db.add(revision)
    db.flush()
    db.add_all(
        (
            BoardRecordLink(
                board_id=board.id,
                event_id=event.id,
                record_id=record.id,
                module_id=module.id,
            ),
            BoardRecordLink(
                board_id=board.id,
                post_id=notice.id,
                record_id=record.id,
                module_id=module.id,
            ),
        )
    )
    db.flush()
    db.add(
        BoardPostRevisionRecordLink(
            revision_id=revision.id,
            record_id=record.id,
            module_id=module.id,
        )
    )
    db.commit()
    _enabled(monkeypatch, True)
    path = f"/api/boards/{board.id}/purge"
    with _client(db, admin) as client:
        preview = client.post(f"{path}/preview")
        assert preview.status_code == 200, preview.text
        types = {row["entity_type"] for row in preview.json()["impact"]["rows"]}
        assert {"board_record_links", "board_post_revision_record_links"} <= types
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
    assert db.get(Record, record.id) is not None
    assert (
        db.scalar(
            select(BoardRecordLink.id).where(BoardRecordLink.board_id == board.id)
        )
        is None
    )
    assert (
        db.scalar(
            select(BoardPostRevisionRecordLink.id).where(
                BoardPostRevisionRecordLink.record_id == record.id
            )
        )
        is None
    )
