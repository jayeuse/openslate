"""Manager metadata must not disclose a working or published announcement audience."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from boards.test_announcement_routes import _actor, _board, _grant
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.announcement_manage_state_router import router
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.models import Board

pytestmark = pytest.mark.integration


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _announcement(
    db: Session,
    board: Board,
    author: User,
    *,
    status: str = "draft",
    working_user_id: UUID | None = None,
    displayed_user_id: UUID | None = None,
) -> BoardAnnouncement:
    item = BoardAnnouncement(
        board_id=board.id,
        author_id=author.id,
        title="Private working title",
        body="Private working body",
        audience_kind="user" if working_user_id is not None else "everyone",
        audience_user_id=working_user_id,
        status=status,
        revision=7,
        displayed_publication_number=1 if status == "published" else None,
    )
    db.add(item)
    db.flush()
    if status == "published":
        db.add(
            BoardAnnouncementRevision(
                announcement_id=item.id,
                publication_number=1,
                publication_key=uuid7(),
                content_fingerprint="a" * 64,
                author_id=author.id,
                title="Earlier published title",
                body="Earlier published body",
                audience_kind="user" if displayed_user_id is not None else "everyone",
                audience_user_id=displayed_user_id,
                published_at=item.created_at,
            )
        )
    db.commit()
    return item


def test_published_manage_state_returns_working_revision_without_content(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "manage-state-owner")
    board = _board(db, owner)
    item = _announcement(db, board, owner, status="published")
    response = _client(db, owner).get(
        f"/api/boards/{board.id}/announcements/{item.id}/manage-state"
    )

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.json() == {
        "id": str(item.id),
        "status": "published",
        "board_revision": board.revision,
        "announcement_revision": 7,
    }


@pytest.mark.parametrize("hidden_source", ["working", "displayed"])
def test_manager_excluded_from_either_audience_cannot_read_manage_state(
    integration_owner_db: Session, hidden_source: str,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "manage-state-private-owner")
    manager = _actor(db, "manage-state-private-manager")
    board = _board(db, owner)
    _grant(db, board, manager, "manage")
    item = _announcement(
        db,
        board,
        owner,
        status="published",
        working_user_id=owner.id if hidden_source == "working" else None,
        displayed_user_id=owner.id if hidden_source == "displayed" else None,
    )

    response = _client(db, manager).get(
        f"/api/boards/{board.id}/announcements/{item.id}/manage-state"
    )
    assert response.status_code == 404
    assert "Private working" not in response.text
    assert "Earlier published" not in response.text


def test_a_guest_board_manager_cannot_read_the_manage_state(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "manage-state-write-owner")
    manager = _actor(db, "manage-state-guest", write=False)
    board = _board(db, owner)
    _grant(db, board, manager, "manage")
    item = _announcement(db, board, owner)

    response = _client(db, manager).get(
        f"/api/boards/{board.id}/announcements/{item.id}/manage-state"
    )
    assert response.status_code == 403


def test_board_viewer_without_manage_cannot_read_working_revision(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "manage-state-view-owner")
    viewer = _actor(db, "manage-state-view-only")
    board = _board(db, owner)
    _grant(db, board, viewer, "view")
    item = _announcement(db, board, owner)

    response = _client(db, viewer).get(
        f"/api/boards/{board.id}/announcements/{item.id}/manage-state"
    )
    assert response.status_code == 404


@pytest.mark.parametrize("deleted_source", ["board", "announcement"])
def test_soft_deleted_source_cannot_reveal_manage_state(
    integration_owner_db: Session, deleted_source: str,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "manage-state-deleted-owner")
    board = _board(db, owner)
    item = _announcement(db, board, owner)
    source = board if deleted_source == "board" else item
    source.is_deleted = True
    source.deleted_at = datetime.now(UTC)
    db.commit()

    response = _client(db, owner).get(
        f"/api/boards/{board.id}/announcements/{item.id}/manage-state"
    )
    assert response.status_code == 404


@pytest.mark.parametrize("item_status", ["draft", "archived"])
def test_draft_and_archived_board_manage_state_remain_content_free(
    integration_owner_db: Session, item_status: str,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "manage-state-archived-owner")
    board = _board(db, owner)
    item = _announcement(db, board, owner, status=item_status)
    board.status = "archived"
    db.commit()

    response = _client(db, owner).get(
        f"/api/boards/{board.id}/announcements/{item.id}/manage-state"
    )
    assert response.status_code == 200
    assert response.json() == {
        "id": str(item.id),
        "status": item_status,
        "board_revision": board.revision,
        "announcement_revision": 7,
    }
