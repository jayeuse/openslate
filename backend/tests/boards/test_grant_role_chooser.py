"""Board-manager role chooser route contracts on disposable PostgreSQL."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.boards.grant_router import router
from app.systems.boards.models import Board, BoardGrant, BoardStatus
from app.systems.manage.audit.models import AuditLog

pytestmark = pytest.mark.integration


def _user(db: Session, *, permissions: dict[str, bool], role: Role | None = None) -> User:
    if role is None:
        role = Role(role=f"role-chooser-actor-{uuid7().hex}", permissions=permissions)
        db.add(role)
        db.flush()
    user_id = uuid7()
    actor = User(
        id=user_id,
        email=f"role-chooser-{user_id.hex}@example.test",
        username=f"role_chooser_{user_id.hex[:20]}",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


def _managed_board(db: Session) -> tuple[User, Board]:
    manager = _user(db, permissions={"records.write": True})
    owner = _user(db, permissions={}, role=manager.role)
    board = Board(owner_id=owner.id, name="Role chooser test")
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


def _path(board_id: UUID) -> str:
    return f"/api/boards/{board_id}/grant-roles"


def test_role_chooser_returns_only_active_role_ids_and_labels_with_stable_bounded_pages(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _managed_board(db)
    prefix = f"role-chooser-target-{uuid7().hex}-"
    active = [Role(role=f"{prefix}{name}", permissions={}) for name in ("alpha", "beta", "gamma")]
    deleted = Role(role=f"{prefix}deleted", permissions={}, is_deleted=True)
    dated = Role(role=f"{prefix}dated", permissions={}, deleted_at=datetime.now(UTC))
    db.add_all([*active, deleted, dated])
    db.flush()
    before_revision = board.revision
    before_audit_count = db.scalar(select(func.count()).select_from(AuditLog))
    client = _client(db, manager)

    url = f"{_path(board.id)}?search={prefix}&limit=2&offset=1"
    response = client.get(url)
    again = client.get(url)

    assert response.status_code == again.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json() == again.json()
    assert response.json() == {
        "items": [
            {"id": str(active[1].id), "role": active[1].role},
            {"id": str(active[2].id), "role": active[2].role},
        ],
        "pagination": {"limit": 2, "offset": 1, "count": 2, "total": 3, "has_more": False},
    }
    assert client.get(f"{_path(board.id)}?search={prefix}&limit=101").status_code == 422
    assert client.get(f"{_path(board.id)}?search={prefix}&deleted=include").status_code == 422
    assert board.revision == before_revision
    assert db.scalar(select(func.count()).select_from(AuditLog)) == before_audit_count


def test_role_chooser_requires_grant_mutation_authority_and_hides_inaccessible_board(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _managed_board(db)
    reader = _user(db, permissions={"records.read": True})
    outsider = _user(db, permissions={}, role=manager.role)
    editor = _user(db, permissions={}, role=manager.role)
    db.add_all(
        [
            BoardGrant(
                board_id=board.id,
                principal_type="user",
                principal_user_id=reader.id,
                permission="manage",
                effect="allow",
            ),
            BoardGrant(
                board_id=board.id,
                principal_type="user",
                principal_user_id=editor.id,
                permission="edit",
                effect="allow",
            ),
        ]
    )
    db.flush()
    path = _path(board.id)

    assert _client(db, None).get(path).status_code == 401
    assert _client(db, reader).get(path).status_code == 403
    assert _client(db, manager).get(path).status_code == 200
    for actor in (outsider, editor):
        hidden = _client(db, actor).get(path)
        missing = _client(db, actor).get(_path(uuid7()))
        assert hidden.status_code == missing.status_code == 404
        assert hidden.json() == missing.json() == {"detail": "Board not found"}


def test_role_chooser_rejects_archived_and_hides_soft_deleted_board(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _managed_board(db)
    path = _path(board.id)
    client = _client(db, manager)

    board.status = BoardStatus.ARCHIVED
    db.flush()
    archived = client.get(path)
    assert archived.status_code == 409
    assert archived.json()["detail"]["code"] == "board_archived"

    board.is_deleted = True
    board.deleted_at = datetime.now(UTC)
    db.flush()
    deleted = client.get(path)
    assert deleted.status_code == 404
    assert deleted.json() == {"detail": "Board not found"}


def test_content_audience_user_chooser_excludes_expired_active_identities(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _managed_board(db)
    active = _user(db, permissions={}, role=manager.role)
    expired = _user(db, permissions={}, role=manager.role)
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
