"""Published author choices derive only from visible announcements and active identities."""

from datetime import UTC, datetime, timedelta

import pytest
from boards.test_announcement_routes import _actor, _board, _grant
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.boards.announcement_author_router import router
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.models import Board

pytestmark = pytest.mark.integration


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
    audience_user_id=None,
    expires_at: datetime | None = None,
    published_at: datetime | None = None,
) -> BoardAnnouncement:
    item = BoardAnnouncement(
        board_id=board.id,
        author_id=author.id,
        title="Private announcement title",
        body="Private announcement body",
        audience_kind="everyone",
        status="published",
        displayed_publication_number=1,
    )
    db.add(item)
    db.flush()
    db.add(
        BoardAnnouncementRevision(
            announcement_id=item.id,
            publication_number=1,
            publication_key=uuid7(),
            content_fingerprint="a" * 64,
            author_id=author.id,
            title="Published private title",
            body="Published private body",
            audience_kind="user" if audience_user_id is not None else "everyone",
            audience_user_id=audience_user_id,
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
    _grant(db, board, viewer, "view")
    _published(db, board, visible_b)
    _published(db, board, visible_a)
    _published(db, board, visible_a)
    _published(db, board, hidden, audience_user_id=owner.id)
    _published(db, board, expired, expires_at=datetime.now(UTC) - timedelta(days=1))
    db.commit()

    response = _client(db, viewer).get(f"/api/boards/{board.id}/announcement-authors")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.json() == sorted(
        [
            {"id": str(visible_a.id), "label": visible_a.username},
            {"id": str(visible_b.id), "label": visible_b.username},
        ],
        key=lambda choice: (choice["label"], choice["id"]),
    )
    assert "Private announcement" not in response.text
    assert "Published private" not in response.text
    assert str(hidden.id) not in response.text


def test_manager_cannot_bypass_published_audience_for_author_choices(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "authors-manager-owner")
    manager = _actor(db, "authors-manager")
    visible = _actor(db, "authors-manager-visible")
    hidden = _actor(db, "authors-manager-hidden")
    board = _board(db, owner)
    _grant(db, board, manager, "manage")
    _published(db, board, visible)
    _published(db, board, hidden, audience_user_id=owner.id)
    db.commit()

    response = _client(db, manager).get(f"/api/boards/{board.id}/announcement-authors")
    assert response.status_code == 200
    assert response.json() == [{"id": str(visible.id), "label": visible.username}]
    assert str(hidden.id) not in response.text


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
    role_deleted = _actor(db, "authors-role-deleted")
    board = _board(db, owner)
    _grant(db, board, viewer, "view")
    for author in (active, disabled, deleted, unestablished, role_deleted):
        _published(db, board, author)
    disabled.status = UserStatus.DISABLED.value
    deleted.is_deleted = True
    deleted.deleted_at = datetime.now(UTC)
    unestablished.invitation_sent_at = datetime.now(UTC)
    assert role_deleted.role is not None
    role_deleted.role.is_deleted = True
    db.commit()

    response = _client(db, viewer).get(f"/api/boards/{board.id}/announcement-authors")
    assert response.status_code == 200
    assert response.json() == [{"id": str(active.id), "label": active.username}]


def test_missing_board_access_and_global_read_capability_do_not_reveal_authors(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "authors-denial-owner")
    outsider = _actor(db, "authors-denial-outsider")
    writer = _actor(db, "authors-denial-writer", read=False)
    board = _board(db, owner)
    _grant(db, board, writer, "view")
    _published(db, board, owner)
    db.commit()
    endpoint = f"/api/boards/{board.id}/announcement-authors"

    assert _client(db, outsider).get(endpoint).status_code == 404
    assert _client(db, writer).get(endpoint).status_code == 403


def test_author_choices_are_bounded_to_active_board_announcement_limit(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "authors-bounded-owner")
    board = _board(db, owner)
    role = Role(role=f"authors-bounded-{uuid7().hex}", permissions={"records.read": True})
    db.add(role)
    db.flush()
    for index in range(501):
        author_id = uuid7()
        author = User(
            id=author_id,
            email=f"authors-bounded-{author_id.hex}@example.test",
            username=f"authors_bounded_{index:03d}",
            status="active",
            role_id=role.id,
        )
        db.add(author)
        db.flush()
        _published(db, board, author)
    db.commit()

    response = _client(db, owner).get(f"/api/boards/{board.id}/announcement-authors")
    assert response.status_code == 200
    assert len(response.json()) == 500
    assert response.json()[0]["label"] == "authors_bounded_000"
    assert response.json()[-1]["label"] == "authors_bounded_499"
