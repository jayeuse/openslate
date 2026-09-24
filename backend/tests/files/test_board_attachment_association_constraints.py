"""Database ownership survives direct writes, not only FastAPI checks."""

from datetime import date
from uuid import uuid4

import pytest
from sqlalchemy.exc import IntegrityError

from app.systems.boards.attachment_models import BoardContentAttachment
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board
from app.systems.platform.files.models import File

pytestmark = pytest.mark.integration


def test_board_content_owner_cannot_change_after_first_attachment(guarded_db, actor):
    db = guarded_db
    board = Board(owner_id=actor.id, name="Single content owner", status="active")
    db.add(board)
    db.flush()
    first = BoardEvent(
        board_id=board.id,
        author_id=actor.id,
        title="First",
        all_day=True,
        start_date=date(2026, 9, 24),
        end_date=date(2026, 9, 24),
        timezone_name="UTC",
        audience_kind="everyone",
    )
    second = BoardEvent(
        board_id=board.id,
        author_id=actor.id,
        title="Second",
        all_day=True,
        start_date=date(2026, 9, 24),
        end_date=date(2026, 9, 24),
        timezone_name="UTC",
        audience_kind="everyone",
    )
    file = File(
        purpose="board_attachment",
        board_id=board.id,
        record_id=None,
        creator_id=actor.id,
        filename="one.pdf",
        expected_size=3,
        object_key=uuid4().hex,
        state="awaiting_upload",
    )
    db.add_all((first, second, file))
    db.flush()
    owner = BoardContentAttachment(board_id=board.id, file_id=file.id, event_id=first.id)
    db.add(owner)
    db.flush()

    with pytest.raises(IntegrityError):
        with db.begin_nested():
            owner.event_id = second.id
            db.flush()

    assert owner.event_id == first.id


def test_board_content_link_rejects_file_and_event_from_different_boards(guarded_db, actor):
    db = guarded_db
    file_board = Board(owner_id=actor.id, name="File Board", status="active")
    event_board = Board(owner_id=actor.id, name="Event Board", status="active")
    db.add_all((file_board, event_board))
    db.flush()
    event = BoardEvent(
        board_id=event_board.id,
        author_id=actor.id,
        title="Other Board",
        all_day=True,
        start_date=date(2026, 9, 24),
        end_date=date(2026, 9, 24),
        timezone_name="UTC",
        audience_kind="everyone",
    )
    file = File(
        purpose="board_attachment",
        board_id=file_board.id,
        record_id=None,
        creator_id=actor.id,
        filename="private.pdf",
        expected_size=3,
        object_key=uuid4().hex,
        state="awaiting_upload",
    )
    db.add_all((event, file))
    db.flush()
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(
                BoardContentAttachment(board_id=file_board.id, file_id=file.id, event_id=event.id)
            )
            db.flush()
