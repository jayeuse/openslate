"""Publication staging belongs to its caller's transaction."""

from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.announcement_service import publish_locked
from app.systems.boards.attachment_models import (
    BoardAnnouncementRevisionAttachment,
    BoardContentAttachment,
)
from app.systems.boards.models import Board
from app.systems.platform.files.access import require_unlinked
from app.systems.platform.files.models import File
from tests.boards.test_announcement_routes import _actor, _board


@pytest.mark.integration
def test_locked_publication_helper_stages_snapshot_until_caller_commits(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "staged-publication")
    board = _board(db, owner)
    item = BoardAnnouncement(
        board_id=board.id,
        author_id=owner.id,
        title="Original notice",
        body="Published details",
        links=[{"label": "Policy", "url": "https://example.org/policy"}],
        audience_kind="everyone",
    )
    db.add(item)
    db.commit()
    locked_board = db.scalar(select(Board).where(Board.id == board.id).with_for_update())
    locked_item = db.scalar(
        select(BoardAnnouncement).where(BoardAnnouncement.id == item.id).with_for_update()
    )
    assert locked_board is not None and locked_item is not None

    published = publish_locked(
        db,
        locked_board,
        locked_item,
        owner,
        publication_key=uuid7(),
        published_at=datetime.now(UTC),
        board_revision=1,
        announcement_revision=1,
    )
    assert db.get(BoardAnnouncementRevision, published.id) is published
    assert published.links == [{"label": "Policy", "url": "https://example.org/policy"}]
    assert locked_board.revision == 2
    assert locked_item.revision == 2
    assert locked_item.displayed_publication_number == 1
    db.flush()
    assert db.scalar(
        select(BoardAnnouncementRevision.id).where(
            BoardAnnouncementRevision.announcement_id == item.id
        )
    ) == published.id

    db.rollback()
    assert db.get(Board, board.id).revision == 1
    assert db.get(BoardAnnouncement, item.id).displayed_publication_number is None
    assert db.scalar(
        select(BoardAnnouncementRevision.id).where(
            BoardAnnouncementRevision.announcement_id == item.id
        )
    ) is None


@pytest.mark.integration
def test_locked_publication_helper_rejects_another_board_without_mutation(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "wrong-board-publication")
    original = _board(db, owner)
    unrelated = _board(db, owner)
    item = BoardAnnouncement(
        board_id=original.id,
        author_id=owner.id,
        title="Private notice",
        body="Unpublished details",
        audience_kind="everyone",
    )
    db.add(item)
    db.commit()
    locked_board = db.scalar(select(Board).where(Board.id == unrelated.id).with_for_update())
    locked_item = db.scalar(
        select(BoardAnnouncement).where(BoardAnnouncement.id == item.id).with_for_update()
    )
    assert locked_board is not None and locked_item is not None

    with pytest.raises(HTTPException) as error:
        publish_locked(
            db,
            locked_board,
            locked_item,
            owner,
            publication_key=uuid7(),
            published_at=datetime.now(UTC),
            board_revision=1,
            announcement_revision=1,
        )
    assert error.value.status_code == 404
    assert locked_board.revision == 1
    assert locked_item.revision == 1
    assert db.scalar(
        select(BoardAnnouncementRevision.id).where(
            BoardAnnouncementRevision.announcement_id == item.id
        )
    ) is None


@pytest.mark.integration
def test_published_revision_retains_file_snapshot_after_draft_detach(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "attachment-publication")
    board = _board(db, owner)
    item = BoardAnnouncement(
        board_id=board.id, author_id=owner.id, title="Attachment notice",
        body="Published with a file", audience_kind="everyone",
    )
    file = File(
        purpose="board_attachment", board_id=board.id, record_id=None,
        creator_id=owner.id, filename="notice.pdf", object_key=uuid7().hex,
        expected_size=3, actual_size=3, digest="a" * 64,
        scanner_version="test", signature_version="test", state="ready",
    )
    db.add_all((item, file))
    db.flush()
    link = BoardContentAttachment(
        board_id=board.id, file_id=file.id, announcement_id=item.id
    )
    db.add(link)
    db.commit()

    locked_board = db.scalar(select(Board).where(Board.id == board.id).with_for_update())
    locked_item = db.scalar(
        select(BoardAnnouncement).where(BoardAnnouncement.id == item.id).with_for_update()
    )
    assert locked_board is not None and locked_item is not None
    published = publish_locked(
        db, locked_board, locked_item, owner, publication_key=uuid7(),
        published_at=datetime.now(UTC), board_revision=1, announcement_revision=1,
    )
    db.commit()
    assert db.scalar(
        select(BoardAnnouncementRevisionAttachment.file_id).where(
            BoardAnnouncementRevisionAttachment.revision_id == published.id
        )
    ) == file.id
    link.is_linked = False
    db.commit()
    assert db.scalar(
        select(BoardAnnouncementRevisionAttachment.file_id).where(
            BoardAnnouncementRevisionAttachment.revision_id == published.id
        )
    ) == file.id
    with pytest.raises(HTTPException) as caught:
        require_unlinked(db, file.id)
    assert caught.value.detail["code"] == "file_linked"
