"""Current-user Board preferences remain private and follow live Board access."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import Role, User
from app.systems.boards.models import Board, BoardGrant, BoardStatus
from app.systems.boards.personal_models import BoardFavorite, BoardHome
from app.systems.boards.personal_router import router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditLog
from tests.rbac.support import make_role, make_user


def _actor(db: Session, name: str, *, read: bool = True, write: bool = False) -> User:
    role = Role(
        role=f"board-personal-{name}-{uuid7().hex[:8]}",
        permissions={"records.read": read, "records.write": write},
    )
    db.add(role)
    db.flush()
    user_id = uuid7()
    actor = User(
        id=user_id,
        email=f"personal-{name}-{user_id.hex}@example.test",
        username=f"personal_{user_id.hex[:12]}",
        status="active",
        role_id=role.id,
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _grant(db: Session, board: Board, actor: User) -> BoardGrant:
    grant = BoardGrant(
        board_id=board.id,
        principal_type="user",
        principal_user_id=actor.id,
        permission="view",
        effect="allow",
    )
    db.add(grant)
    return grant


def test_personal_routes_require_global_record_read_before_database_access() -> None:
    from unittest.mock import Mock

    db = Mock(spec=Session)
    actor = make_user("personal_no_read", role=make_role("member", {}))
    client = _client(db, actor)

    assert client.get("/api/boards/personal").status_code == 403
    assert client.put("/api/boards/personal/home", json={"board_id": None}).status_code == 403
    assert (
        client.put(f"/api/boards/personal/favorites/{uuid7()}", json={"favorite": True}).status_code
        == 403
    )
    db.scalar.assert_not_called()
    db.scalars.assert_not_called()


@pytest.mark.integration
def test_get_hides_inaccessible_deleted_and_archived_home_but_keeps_stored_rows(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "list-owner", write=True)
    viewer = _actor(db, "list-viewer")
    active = Board(owner_id=owner.id, name="Active")
    archived = Board(owner_id=owner.id, name="Archived", status=BoardStatus.ARCHIVED)
    hidden = Board(owner_id=owner.id, name="Hidden")
    deleted = Board(owner_id=owner.id, name="Deleted", is_deleted=True)
    db.add_all([active, archived, hidden, deleted])
    db.flush()
    active_grant = _grant(db, active, viewer)
    _grant(db, archived, viewer)
    _grant(db, deleted, viewer)
    db.add_all(
        [
            BoardFavorite(user_id=viewer.id, board_id=board.id)
            for board in (active, archived, hidden, deleted)
        ]
    )
    home = BoardHome(user_id=viewer.id, board_id=active.id)
    db.add(home)
    db.commit()
    client = _client(db, viewer)

    visible = client.get("/api/boards/personal")
    assert visible.status_code == 200
    assert visible.headers["Cache-Control"] == "private, no-store"
    assert set(visible.json()["favorite_board_ids"]) == {str(active.id), str(archived.id)}
    assert visible.json()["home_board_id"] == str(active.id)

    active_grant.is_deleted = True
    db.commit()
    revoked = client.get("/api/boards/personal")
    assert revoked.status_code == 200
    assert revoked.json()["favorite_board_ids"] == [str(archived.id)]
    assert revoked.json()["home_board_id"] is None
    assert db.get(BoardHome, home.id) is not None
    assert (
        db.scalar(
            select(func.count())
            .select_from(BoardFavorite)
            .where(BoardFavorite.user_id == viewer.id)
        )
        == 4
    )

    active_grant.is_deleted = False
    db.commit()
    active.status = BoardStatus.ARCHIVED
    db.commit()
    archived_home = client.get("/api/boards/personal")
    assert set(archived_home.json()["favorite_board_ids"]) == {str(active.id), str(archived.id)}
    assert archived_home.json()["home_board_id"] is None
    active.status = BoardStatus.ACTIVE
    db.commit()
    assert client.get("/api/boards/personal").json()["home_board_id"] == str(active.id)


@pytest.mark.integration
def test_read_only_viewer_can_toggle_archived_favorite_and_active_home_idempotently(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "write-owner", write=True)
    viewer = _actor(db, "write-viewer")
    active = Board(owner_id=owner.id, name="Active home")
    archived = Board(owner_id=owner.id, name="Archived favorite", status=BoardStatus.ARCHIVED)
    db.add_all([active, archived])
    db.flush()
    _grant(db, active, viewer)
    _grant(db, archived, viewer)
    db.commit()
    set_audit_actor(db, viewer.id)
    client = _client(db, viewer)

    favorite_url = f"/api/boards/personal/favorites/{archived.id}"
    added = client.put(favorite_url, json={"favorite": True})
    assert added.status_code == 200
    assert added.json()["favorite_board_ids"] == [str(archived.id)]
    favorite = db.scalar(select(BoardFavorite).where(BoardFavorite.user_id == viewer.id))
    assert favorite is not None and favorite.board_id == archived.id
    assert client.put(favorite_url, json={"favorite": True}).status_code == 200
    assert (
        db.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.entity_type == "board_favorites", AuditLog.entity_id == favorite.id)
        )
        == 1
    )

    home_url = "/api/boards/personal/home"
    home_set = client.put(home_url, json={"board_id": str(active.id)})
    assert home_set.status_code == 200
    assert home_set.json()["home_board_id"] == str(active.id)
    home = db.scalar(select(BoardHome).where(BoardHome.user_id == viewer.id))
    assert home is not None and home.board_id == active.id
    assert client.put(home_url, json={"board_id": str(active.id)}).status_code == 200
    assert (
        db.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.entity_type == "board_homes", AuditLog.entity_id == home.id)
        )
        == 1
    )

    archived_home = client.put(home_url, json={"board_id": str(archived.id)})
    assert archived_home.status_code == 409
    assert archived_home.json()["detail"]["code"] == "home_board_archived"
    assert db.get(BoardHome, home.id).board_id == active.id

    removed = client.put(favorite_url, json={"favorite": False})
    assert removed.status_code == 200
    assert removed.json()["favorite_board_ids"] == []
    assert db.get(BoardFavorite, favorite.id) is None
    assert client.put(favorite_url, json={"favorite": False}).status_code == 200
    assert (
        db.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.entity_type == "board_favorites", AuditLog.entity_id == favorite.id)
        )
        == 2
    )

    cleared = client.put(home_url, json={"board_id": None})
    assert cleared.status_code == 200
    assert cleared.json()["home_board_id"] is None
    assert db.get(BoardHome, home.id) is None
    assert client.put(home_url, json={"board_id": None}).status_code == 200
    assert (
        db.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.entity_type == "board_homes", AuditLog.entity_id == home.id)
        )
        == 2
    )


@pytest.mark.integration
def test_personal_mutations_reject_inaccessible_and_deleted_boards_without_state_change(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "denial-owner", write=True)
    viewer = _actor(db, "denial-viewer")
    private = Board(owner_id=owner.id, name="Private")
    deleted = Board(owner_id=owner.id, name="Deleted", is_deleted=True)
    db.add_all([private, deleted])
    db.flush()
    _grant(db, deleted, viewer)
    db.commit()
    set_audit_actor(db, viewer.id)
    client = _client(db, viewer)

    for board in (private, deleted):
        favorite = client.put(f"/api/boards/personal/favorites/{board.id}", json={"favorite": True})
        home = client.put("/api/boards/personal/home", json={"board_id": str(board.id)})
        assert favorite.status_code == home.status_code == 404
    assert (
        db.scalar(
            select(func.count())
            .select_from(BoardFavorite)
            .where(BoardFavorite.user_id == viewer.id)
        )
        == 0
    )
    assert (
        db.scalar(select(func.count()).select_from(BoardHome).where(BoardHome.user_id == viewer.id))
        == 0
    )
