"""Board content-audience user chooser contracts on disposable PostgreSQL."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User, UserStatus
from app.systems.boards.grant_router import router
from app.systems.boards.models import Board, BoardGrant

pytestmark = pytest.mark.integration


def _user(db: Session, *, role: str = "member") -> User:
    user_id = uuid7()
    actor = User(
        id=user_id,
        email=f"audience-chooser-{user_id.hex}@example.test",
        username=f"audience_chooser_{user_id.hex[:20]}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


def _managed_board(db: Session) -> tuple[User, Board]:
    manager = _user(db)
    owner = _user(db)
    board = Board(owner_id=owner.id, name="Audience chooser test")
    db.add(board)
    db.flush()
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=manager.id,
            permission="manage",
            effect="allow",
        )
    )
    db.flush()
    return manager, board


def _client(db: Session, actor: User | None) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    if actor is not None:
        app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def test_content_audience_user_chooser_excludes_expired_active_identities(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _managed_board(db)
    active = _user(db)
    expired = _user(db)
    active.username = f"audience-active-{uuid7().hex}"
    expired.username = f"audience-expired-{uuid7().hex}"
    expired.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.flush()
    client = _client(db, manager)

    response = client.get(
        f"/api/boards/{board.id}/content-audience-targets?kind=user"
        f"&search=audience-"
    )

    assert response.status_code == 200
    assert response.json()["items"] == [{"id": str(active.id), "label": active.username}]
    assert response.json()["pagination"]["total"] == 1
