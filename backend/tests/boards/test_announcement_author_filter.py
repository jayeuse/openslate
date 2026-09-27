"""Author filters use the same source that supplies each announcement view."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.announcement_router import router
from app.systems.boards.models import Board, BoardGrant


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _actor(db: Session, label: str) -> User:
    role = "member"
    db.flush()
    user_id = uuid7()
    actor = User(
        id=user_id,
        email=f"announcement-author-filter-{user_id.hex}@example.test",
        username=f"announcement_author_filter_{user_id.hex[:12]}",
        status="active",
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


def _working_announcement(
    db: Session,
    board: Board,
    author: User,
    *,
    title: str,
    status: str,
    audience_user: User | None = None,
) -> BoardAnnouncement:
    item = BoardAnnouncement(
        board_id=board.id,
        author_id=author.id,
        title=title,
        body=f"Body for {title}",
        status=status,
        publish_at=datetime.now(UTC) if status == "published" else None,
        audience_kind="user" if audience_user is not None else "everyone",
        audience_user_id=audience_user.id if audience_user is not None else None,
    )
    db.add(item)
    db.flush()
    return item


def _published_revision(
    db: Session,
    item: BoardAnnouncement,
    author: User,
    *,
    title: str,
    audience_user: User | None = None,
) -> None:
    db.add(
        BoardAnnouncementRevision(
            announcement_id=item.id,
            publication_number=1,
            publication_key=uuid7(),
            content_fingerprint="a" * 64,
            author_id=author.id,
            title=title,
            body=f"Published body for {title}",
            links=[],
            audience_kind="user" if audience_user is not None else "everyone",
            audience_user_id=audience_user.id if audience_user is not None else None,
            published_at=datetime.now(UTC),
        )
    )
    item.displayed_publication_number = 1


@pytest.mark.integration
def test_author_filter_uses_view_source_and_preserves_audience_and_pagination(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "owner")
    reader = _actor(db, "reader")
    working_author = _actor(db, "working-author")
    published_author = _actor(db, "published-author")
    private_author = _actor(db, "private-author")
    recipient = _actor(db, "recipient")
    draft_author = _actor(db, "draft-author")
    archived_author = _actor(db, "archived-author")
    board = Board(owner_id=owner.id, name=f"Author filter {uuid7().hex[:8]}")
    db.add(board)
    db.flush()
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=reader.id,
            permission="view",
            effect="allow",
        )
    )

    public_ids: set[UUID] = set()
    for title in ("Public published one", "Public published two"):
        item = _working_announcement(db, board, working_author, title=title, status="published")
        _published_revision(db, item, published_author, title=title)
        public_ids.add(item.id)

    hidden = _working_announcement(
        db,
        board,
        private_author,
        title="Hidden published",
        status="published",
        audience_user=recipient,
    )
    _published_revision(
        db, hidden, private_author, title="Hidden published", audience_user=recipient
    )
    _working_announcement(db, board, draft_author, title="A draft", status="draft")
    _working_announcement(db, board, archived_author, title="An archive", status="archived")
    db.commit()

    root = f"/api/boards/{board.id}/announcements"
    reader_client = _client(db, reader)
    owner_client = _client(db, owner)

    first = reader_client.get(root, params={"author_id": str(published_author.id), "limit": 1})
    second = reader_client.get(
        root, params={"author_id": str(published_author.id), "limit": 1, "offset": 1}
    )
    assert first.status_code == second.status_code == 200
    assert first.json()["pagination"] == {
        "limit": 1,
        "offset": 0,
        "count": 1,
        "total": 2,
        "has_more": True,
    }
    assert second.json()["pagination"]["total"] == 2
    assert {first.json()["items"][0]["id"], second.json()["items"][0]["id"]} == {
        str(item_id) for item_id in public_ids
    }

    assert (
        reader_client.get(root, params={"author_id": str(working_author.id)}).json()["pagination"][
            "total"
        ]
        == 0
    )
    assert (
        reader_client.get(root, params={"author_id": str(private_author.id)}).json()["pagination"][
            "total"
        ]
        == 0
    )
    assert (
        owner_client.get(root, params={"view": "draft", "author_id": str(draft_author.id)}).json()[
            "pagination"
        ]["total"]
        == 1
    )
    assert (
        owner_client.get(
            root, params={"view": "archive", "author_id": str(archived_author.id)}
        ).json()["pagination"]["total"]
        == 1
    )
    assert reader_client.get(root, params={"author_id": "not-a-uuid"}).status_code == 422
