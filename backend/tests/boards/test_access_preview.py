"""Board-manager access preview against the runner-owned PostgreSQL database."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User, UserStatus
from app.systems.boards.access import can_access_board
from app.systems.boards.access_preview_router import router
from app.systems.boards.models import Board, BoardGrant, BoardPermission

pytestmark = pytest.mark.integration


def _user(
    db: Session,
    *,
    role: str = "member",
    username: str | None = None,
    status: UserStatus = UserStatus.ACTIVE,
    deleted: bool = False,
    invitation_sent_at: datetime | None = None,
) -> User:
    guest = role == "guest"
    sponsor = _user(db) if guest else None
    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"preview-{user_id.hex}@example.test",
        username=username or f"preview_{user_id.hex[:20]}",
        status=status.value,
        role=role,
        sponsor_user_id=sponsor.id if sponsor is not None else None,
        expires_at=datetime.now(UTC) + timedelta(days=30) if guest else None,
        is_deleted=deleted,
        invitation_sent_at=invitation_sent_at,
    )
    db.add(user)
    db.flush()
    return user


def _board_for_manager(db: Session) -> tuple[User, Board]:
    # A guest manager can read the Board's access but can never edit or manage it.
    manager = _user(db, role="guest")
    owner = _user(db, role="guest")
    board = Board(owner_id=owner.id, name="Access preview test")
    db.add(board)
    db.flush()
    _grant(db, board, "user", "manage", "allow", user_id=manager.id)
    return manager, board


def _grant(
    db: Session,
    board: Board,
    principal_type: str,
    permission: str,
    effect: str,
    *,
    user_id: UUID | None = None,
) -> None:
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type=principal_type,
            principal_user_id=user_id,
            permission=permission,
            effect=effect,
        )
    )
    db.flush()


def _client(db: Session, actor: User | None) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    if actor is not None:
        app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _preview(client: TestClient, board: Board, target: User | UUID) -> dict[str, bool]:
    target_id = target.id if isinstance(target, User) else target
    response = client.get(f"/api/boards/{board.id}/access-preview?user_id={target_id}")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    payload = response.json()
    assert set(payload) == {"view", "edit", "manage"}
    return payload


def test_manager_preview_matches_board_acl_guest_limit_and_tie_denial(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _board_for_manager(db)
    fully_gated = _user(db)
    tied_deny = _user(db)
    guest = _user(db, role="guest")
    _grant(db, board, "everyone", "manage", "allow")
    _grant(db, board, "user", "manage", "allow", user_id=fully_gated.id)
    _grant(db, board, "user", "manage", "allow", user_id=tied_deny.id)
    _grant(db, board, "user", "view", "deny", user_id=tied_deny.id)
    grants = db.query(BoardGrant).filter(BoardGrant.board_id == board.id).all()
    client = _client(db, manager)

    for target in (fully_gated, tied_deny, guest):
        expected = {
            permission.value: can_access_board(board, target, permission, grants)
            for permission in BoardPermission
        }
        assert _preview(client, board, target) == expected
    assert _preview(client, board, fully_gated) == {
        "view": True,
        "edit": True,
        "manage": True,
    }
    assert _preview(client, board, tied_deny) == {
        "view": False,
        "edit": False,
        "manage": False,
    }
    assert _preview(client, board, guest) == {
        "view": True,
        "edit": False,
        "manage": False,
    }


def test_preview_and_chooser_require_board_manager(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _board_for_manager(db)
    target = _user(db, role="guest")
    outsider = _user(db)
    paths = (
        f"/api/boards/{board.id}/access-preview?user_id={target.id}",
        f"/api/boards/{board.id}/preview-users",
    )
    for path in paths:
        assert _client(db, None).get(path).status_code == 401
        hidden = _client(db, outsider).get(path)
        missing = _client(db, outsider).get(path.replace(str(board.id), str(uuid7())))
        assert hidden.status_code == missing.status_code == 404
        assert hidden.json() == missing.json() == {"detail": "Board not found"}
        assert _client(db, manager).get(path).status_code == 200


def test_preview_rejects_unavailable_target_without_leaking_identity_state(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _board_for_manager(db)
    disabled = _user(db, status=UserStatus.DISABLED)
    pending = _user(db, status=UserStatus.PENDING)
    deleted = _user(db, deleted=True)
    unaccepted = _user(db, invitation_sent_at=datetime.now(UTC))
    client = _client(db, manager)
    missing = client.get(f"/api/boards/{board.id}/access-preview?user_id={uuid7()}")
    assert missing.status_code == 404
    for target in (disabled, pending, deleted, unaccepted):
        response = client.get(f"/api/boards/{board.id}/access-preview?user_id={target.id}")
        assert response.status_code == 404
        assert response.json() == missing.json()


def test_preview_user_chooser_filters_before_bounded_pagination_and_exposes_no_private_fields(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _board_for_manager(db)
    eligible = [_user(db, username=f"choice_{name}") for name in ("alpha", "beta", "gamma")]
    _user(db, username="choice_disabled", status=UserStatus.DISABLED)
    _user(db, username="choice_pending", status=UserStatus.PENDING)
    _user(db, username="choice_deleted", deleted=True)
    _user(db, username="choice_unaccepted", invitation_sent_at=datetime.now(UTC))
    client = _client(db, manager)

    response = client.get(f"/api/boards/{board.id}/preview-users?search=choice_&limit=2&offset=1")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    payload = response.json()
    assert payload["pagination"] == {
        "limit": 2,
        "offset": 1,
        "count": 2,
        "total": 3,
        "has_more": False,
    }
    assert payload["items"] == [
        {"id": str(eligible[1].id), "username": "choice_beta"},
        {"id": str(eligible[2].id), "username": "choice_gamma"},
    ]
    assert client.get(f"/api/boards/{board.id}/preview-users?limit=101").status_code == 422


def test_expired_active_identity_is_hidden_from_preview_and_chooser(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _board_for_manager(db)
    expired = _user(db, username="choice_expired")
    expired.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.flush()
    client = _client(db, manager)

    chooser = client.get(f"/api/boards/{board.id}/preview-users?search=choice_expired")
    missing = client.get(f"/api/boards/{board.id}/access-preview?user_id={uuid7()}")
    direct = client.get(
        f"/api/boards/{board.id}/access-preview?user_id={expired.id}"
    )

    assert chooser.status_code == 200
    assert chooser.json()["items"] == []
    assert chooser.json()["pagination"]["total"] == 0
    assert direct.status_code == missing.status_code == 404
    assert direct.json() == missing.json()


def test_my_access_returns_only_the_authenticated_readers_effective_permissions(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _board_for_manager(db)
    owner = db.get(User, board.owner_id)
    assert owner is not None
    reader = _user(db, role="guest")
    writer = _user(db)
    _grant(db, board, "user", "view", "allow", user_id=reader.id)
    _grant(db, board, "user", "manage", "allow", user_id=writer.id)
    _grant(db, board, "user", "edit", "deny", user_id=writer.id)
    client = _client(db, reader)

    response = client.get(f"/api/boards/{board.id}/my-access")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json() == {"view": True, "edit": False, "manage": False}
    assert _client(db, writer).get(f"/api/boards/{board.id}/my-access").json() == {
        "view": True,
        "edit": False,
        "manage": True,
    }
    assert _client(db, owner).get(f"/api/boards/{board.id}/my-access").json() == {
        "view": True,
        "edit": False,
        "manage": False,
    }
    assert _client(db, manager).get(f"/api/boards/{board.id}/my-access").json() == {
        "view": True,
        "edit": False,
        "manage": False,
    }


def test_my_access_hides_invisible_boards(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    _, board = _board_for_manager(db)
    outsider = _user(db, role="guest")
    denied = _user(db)
    inactive = _user(db, status=UserStatus.DISABLED)
    _grant(db, board, "user", "manage", "allow", user_id=denied.id)
    _grant(db, board, "user", "view", "deny", user_id=denied.id)
    path = f"/api/boards/{board.id}/my-access"

    assert _client(db, None).get(path).status_code == 401
    missing = _client(db, outsider).get(f"/api/boards/{uuid7()}/my-access")
    assert missing.status_code == 404
    for actor in (outsider, denied, inactive):
        hidden = _client(db, actor).get(path)
        assert hidden.status_code == 404
        assert hidden.json() == missing.json() == {"detail": "Board not found"}


def test_my_access_keeps_archived_board_readable_but_hides_soft_deleted_board(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _user(db)
    board = Board(owner_id=owner.id, name="Archived access")
    db.add(board)
    db.flush()
    board.status = "archived"
    db.flush()
    client = _client(db, owner)

    archived = client.get(f"/api/boards/{board.id}/my-access")
    assert archived.status_code == 200
    assert archived.json() == {"view": True, "edit": True, "manage": True}

    board.is_deleted = True
    board.deleted_at = datetime.now(UTC)
    db.flush()
    hidden = client.get(f"/api/boards/{board.id}/my-access")
    missing = client.get(f"/api/boards/{uuid7()}/my-access")
    assert hidden.status_code == missing.status_code == 404
    assert hidden.json() == missing.json()
