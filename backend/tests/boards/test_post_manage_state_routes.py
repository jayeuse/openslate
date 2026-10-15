"""The content-free state that an author or a manager needs before changing a post."""

from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.models import Board
from app.systems.boards.post_manage_state_router import router
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from tests.boards.support import client, grant, guest, member, project_board

pytestmark = pytest.mark.integration


def _post(db: Session, board: Board, author: User, *, status: str = "draft") -> BoardPost:
    item = BoardPost(
        org_id=board.org_id,
        board_id=board.id,
        author_id=author.id,
        title="Private working title",
        body="Private working body",
        status=status,
        revision=7,
        displayed_publication_number=1 if status == "published" else None,
    )
    db.add(item)
    db.flush()
    if status == "published":
        db.add(
            BoardPostRevision(
                org_id=item.org_id,
                post_id=item.id,
                publication_number=1,
                publication_key=uuid7(),
                content_fingerprint="a" * 64,
                author_id=author.id,
                title="Earlier published title",
                body="Earlier published body",
                published_at=datetime.now(UTC),
            )
        )
    db.commit()
    return item


def _path(board: Board, item: BoardPost) -> str:
    return f"/api/boards/{board.id}/posts/{item.id}/manage-state"


def test_author_and_manager_read_the_working_revision_without_content(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author, manager = member(db), member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    grant(db, board, [manager], AccessLevel.MANAGE)
    published = _post(db, board, author, status="published")
    draft = _post(db, board, author)

    for actor in (author, manager):
        response = client(db, actor, router).get(_path(board, published))
        assert response.status_code == 200
        assert response.headers["Cache-Control"] == "private, no-store"
        assert response.json() == {
            "id": str(published.id),
            "status": "published",
            "board_revision": board.revision,
            "post_revision": 7,
            "published_before": True,
        }
        assert "Private working" not in response.text and "Earlier" not in response.text
    assert client(db, author, router).get(_path(board, draft)).json()["published_before"] is False


def test_other_writers_readers_guests_and_outsiders_cannot_read_the_state(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author, other_writer, reader, outsider = member(db), member(db), member(db), member(db)
    visitor = guest(db)
    board = project_board(db)
    grant(db, board, [author, other_writer], AccessLevel.WRITE)
    grant(db, board, [visitor], AccessLevel.MANAGE)
    grant(db, board, [reader], AccessLevel.READ)
    item = _post(db, board, author)

    assert client(db, other_writer, router).get(_path(board, item)).status_code == 403
    assert client(db, reader, router).get(_path(board, item)).status_code == 403
    assert client(db, visitor, router).get(_path(board, item)).status_code == 403
    assert client(db, outsider, router).get(_path(board, item)).status_code == 404


def test_soft_deleted_post_cannot_reveal_its_state(integration_owner_db: Session) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    item = _post(db, board, author)
    item.is_deleted = True
    item.deleted_at = datetime.now(UTC)
    db.commit()

    response = client(db, author, router).get(_path(board, item))
    assert response.status_code == 404
    assert response.json() == {"detail": "Board post not found"}
