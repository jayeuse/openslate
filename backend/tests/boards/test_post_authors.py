"""Published author choices derive only from visible posts and active identities."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User, UserStatus
from app.systems.boards.models import Board
from app.systems.boards.post_author_router import router
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from tests.boards.support import grant, member, project_board

pytestmark = pytest.mark.integration


def _actor(db: Session, label: str, *, write: bool = True) -> User:
    return member(db, label)


def _board(db: Session, owner: User) -> Board:
    board = project_board(db)
    grant(db, board, [owner], "write")
    return board


def _grant(db: Session, board: Board, actor: User, level: str) -> None:
    grant(db, board, [actor], level)


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _published(
    db: Session,
    board: Board,
    author: User,
    *,
    status: str = "published",
    expires_at: datetime | None = None,
    published_at: datetime | None = None,
) -> BoardPost:
    item = BoardPost(
        board_id=board.id,
        author_id=author.id,
        title="Private post title",
        body="Private post body",
        status=status,
        displayed_publication_number=1,
    )
    db.add(item)
    db.flush()
    db.add(
        BoardPostRevision(
            post_id=item.id,
            publication_number=1,
            publication_key=uuid7(),
            content_fingerprint="a" * 64,
            author_id=author.id,
            title="Published private title",
            body="Published private body",
            published_at=published_at or datetime.now(UTC) - timedelta(days=2),
            expires_at=expires_at,
        )
    )
    db.flush()
    return item


def test_authors_are_distinct_ordered_and_only_from_visible_publications(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "authors-owner")
    viewer = _actor(db, "authors-viewer", write=False)
    visible_a = _actor(db, "authors-a")
    visible_b = _actor(db, "authors-b")
    hidden = _actor(db, "authors-hidden")
    expired = _actor(db, "authors-expired")
    board = _board(db, owner)
    _grant(db, board, viewer, "read")
    _published(db, board, visible_b)
    _published(db, board, visible_a)
    _published(db, board, visible_a)
    _published(db, board, hidden, status="archived")
    _published(db, board, expired, expires_at=datetime.now(UTC) - timedelta(days=1))
    db.commit()

    response = _client(db, viewer).get(f"/api/boards/{board.id}/post-authors")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.json() == sorted(
        [
            {"id": str(visible_a.id), "label": visible_a.username},
            {"id": str(visible_b.id), "label": visible_b.username},
        ],
        key=lambda choice: (choice["label"], choice["id"]),
    )
    assert "Private post" not in response.text
    assert "Published private" not in response.text
    assert str(hidden.id) not in response.text


def test_managers_also_see_the_authors_of_expired_posts(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "authors-manager-owner")
    manager = _actor(db, "authors-manager")
    expired = _actor(db, "authors-manager-expired")
    board = _board(db, owner)
    _grant(db, board, manager, "manage")
    _published(db, board, expired, expires_at=datetime.now(UTC) - timedelta(days=1))
    db.commit()

    response = _client(db, manager).get(f"/api/boards/{board.id}/post-authors")
    assert response.status_code == 200
    assert response.json() == [{"id": str(expired.id), "label": expired.username}]


def test_inactive_deleted_or_unestablished_authors_are_not_choices(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "authors-active-owner")
    viewer = _actor(db, "authors-active-viewer", write=False)
    active = _actor(db, "authors-active")
    disabled = _actor(db, "authors-disabled")
    deleted = _actor(db, "authors-deleted")
    unestablished = _actor(db, "authors-unestablished")
    board = _board(db, owner)
    _grant(db, board, viewer, "read")
    for author in (active, disabled, deleted, unestablished):
        _published(db, board, author)
    disabled.status = UserStatus.DISABLED.value
    deleted.is_deleted = True
    deleted.deleted_at = datetime.now(UTC)
    unestablished.invitation_sent_at = datetime.now(UTC)
    db.commit()

    response = _client(db, viewer).get(f"/api/boards/{board.id}/post-authors")
    assert response.status_code == 200
    assert response.json() == [{"id": str(active.id), "label": active.username}]


def test_missing_board_access_does_not_reveal_authors(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "authors-denial-owner")
    outsider = _actor(db, "authors-denial-outsider")
    board = _board(db, owner)
    _published(db, board, owner)
    db.commit()
    endpoint = f"/api/boards/{board.id}/post-authors"

    assert _client(db, outsider).get(endpoint).status_code == 404


def test_author_choices_are_bounded_to_active_board_post_limit(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "authors-bounded-owner")
    board = _board(db, owner)
    role = "member"
    db.flush()
    for index in range(501):
        author_id = uuid7()
        author = User(
            id=author_id,
            email=f"authors-bounded-{author_id.hex}@example.test",
            username=f"authors_bounded_{index:03d}",
            status="active",
            role=role,
        )
        db.add(author)
        db.flush()
        _published(db, board, author)
    db.commit()

    response = _client(db, owner).get(f"/api/boards/{board.id}/post-authors")
    assert response.status_code == 200
    assert len(response.json()) == 500
    assert response.json()[0]["label"] == "authors_bounded_000"
    assert response.json()[-1]["label"] == "authors_bounded_499"
