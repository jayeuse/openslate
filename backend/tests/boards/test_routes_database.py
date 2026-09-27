"""Board routes and SQL ACL behavior on the runner-owned PostgreSQL database."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User, UserRole
from app.systems.boards.models import Board, BoardGrant
from app.systems.boards.personal_models import BoardFavorite
from app.systems.boards.router import router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.departments.models import Department
from tests.rbac.support import add_user

pytestmark = pytest.mark.integration


def _actor(db: Session, *, role: str = UserRole.MEMBER) -> User:
    return add_user(db, "board", role=role)


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _board(db: Session, owner_id: UUID, name: str) -> Board:
    board = Board(owner_id=owner_id, name=name)
    db.add(board)
    db.flush()
    return board


def _grant(
    db: Session,
    board: Board,
    principal_type: str,
    effect: str,
    permission: str = "view",
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


def _board_audit_rows(db: Session, board_id: UUID) -> list[AuditLog]:
    return list(
        db.scalars(
            select(AuditLog)
            .where(AuditLog.entity_type == "boards", AuditLog.entity_id == board_id)
            .order_by(AuditLog.created_at, AuditLog.id)
        ).all()
    )


def test_list_applies_user_everyone_precedence_before_count_and_pagination(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    actor = _actor(db)
    owner = _actor(db)
    set_audit_actor(db, actor.id)

    everyone_only = _board(db, owner.id, "01 everyone allow")
    user_over_everyone = _board(db, owner.id, "02 user beats everyone deny")
    user_only = _board(db, owner.id, "03 user allow")
    user_deny_over_everyone = _board(db, owner.id, "04 user deny beats everyone allow")
    user_tie_deny = _board(db, owner.id, "05 user deny wins tie")

    _grant(db, everyone_only, "everyone", "allow")

    _grant(db, user_over_everyone, "user", "allow", user_id=actor.id)
    _grant(db, user_over_everyone, "everyone", "deny")

    _grant(db, user_only, "user", "allow", user_id=actor.id)

    _grant(db, user_deny_over_everyone, "user", "deny", user_id=actor.id)
    _grant(db, user_deny_over_everyone, "everyone", "allow")

    _grant(db, user_tie_deny, "user", "allow", user_id=actor.id)
    _grant(db, user_tie_deny, "user", "deny", user_id=actor.id)

    response = _client(db, actor).get("/api/boards?limit=2&offset=1")

    assert response.status_code == 200
    result = response.json()
    assert [item["name"] for item in result["items"]] == [
        "02 user beats everyone deny",
        "03 user allow",
    ]
    assert result["pagination"] == {
        "limit": 2,
        "offset": 1,
        "count": 2,
        "total": 3,
        "has_more": False,
    }


def test_list_filters_favorites_before_combined_filters_and_offset_pagination(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    actor = _actor(db)
    department = Department(department_name=f"Favorite filter {uuid7().hex}")
    other_department = Department(department_name=f"Other filter {uuid7().hex}")
    db.add_all((department, other_department))
    db.flush()
    favorite_one = _board(db, actor.id, "A favorite")
    favorite_one.department_id = department.id
    favorite_two = _board(db, actor.id, "B favorite")
    favorite_two.department_id = department.id
    _board(db, actor.id, "C not favorite").department_id = department.id
    _board(db, actor.id, "D other department").department_id = other_department.id
    db.add_all(
        [
            BoardFavorite(user_id=actor.id, board_id=favorite_one.id),
            BoardFavorite(user_id=actor.id, board_id=favorite_two.id),
        ]
    )
    db.flush()
    client = _client(db, actor)

    page = client.get(
        f"/api/boards?favorites_only=true&department_id={department.id}"
        "&status=active&limit=1&offset=1"
    )
    all_boards = client.get("/api/boards?favorites_only=false&limit=10")

    assert page.status_code == 200
    assert [item["name"] for item in page.json()["items"]] == ["B favorite"]
    assert page.json()["pagination"] == {
        "limit": 1,
        "offset": 1,
        "count": 1,
        "total": 2,
        "has_more": False,
    }
    assert all_boards.status_code == 200
    assert all_boards.json()["pagination"]["total"] == 4


def test_a_guest_reads_boards_but_cannot_create_one(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    guest = _actor(db, role=UserRole.GUEST)
    member = _actor(db)
    set_audit_actor(db, guest.id)

    guest_client = _client(db, guest)
    assert guest_client.get("/api/boards").status_code == 200
    assert guest_client.post("/api/boards", json={"name": "Not allowed"}).status_code == 403
    set_audit_actor(db, member.id)
    created = _client(db, member).post("/api/boards", json={"name": "Member create"})
    assert created.status_code == 201
    assert created.json()["owner_id"] == str(member.id)


def test_hidden_board_detail_has_the_same_not_found_response_as_missing(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    reader = _actor(db)
    owner = _actor(db)
    hidden = _board(db, owner.id, "Private")
    _grant(
        db,
        hidden,
        "user",
        "deny",
        user_id=reader.id,
    )
    set_audit_actor(db, reader.id)

    client = _client(db, reader)
    hidden_response = client.get(f"/api/boards/{hidden.id}")
    missing_response = client.get(f"/api/boards/{uuid7()}")

    assert hidden_response.status_code == missing_response.status_code == 404
    assert hidden_response.json() == missing_response.json() == {"detail": "Board not found"}


def test_create_patch_archive_restore_and_stale_revision_are_individually_audited(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    set_audit_actor(db, owner.id)
    client = _client(db, owner)

    created = client.post("/api/boards", json={"name": "Initial"})
    assert created.status_code == 201
    board_id = UUID(created.json()["id"])
    assert created.json()["revision"] == 1

    patched = client.patch(
        f"/api/boards/{board_id}",
        json={"revision": 1, "name": "Renamed"},
    )
    assert patched.status_code == 200
    assert patched.json()["revision"] == 2

    archived = client.post(f"/api/boards/{board_id}/archive", json={"revision": 2})
    assert archived.status_code == 200
    assert archived.json()["status"] == "archived"
    assert archived.json()["revision"] == 3

    stale = client.patch(
        f"/api/boards/{board_id}",
        json={"revision": 2, "name": "Stale rename"},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "stale_revision"

    restored = client.post(f"/api/boards/{board_id}/restore", json={"revision": 3})
    assert restored.status_code == 200
    assert restored.json()["status"] == "active"
    assert restored.json()["revision"] == 4

    board = db.get(Board, board_id)
    assert board is not None
    assert board.name == "Renamed"
    assert board.status == "active"
    assert board.is_deleted is False
    rows = _board_audit_rows(db, board_id)
    assert [row.action for row in rows] == [
        AuditAction.CREATE,
        AuditAction.UPDATE,
        AuditAction.UPDATE,
        AuditAction.UPDATE,
    ]
    assert all(row.performed_by == owner.id for row in rows)
    assert rows[1].after == {"name": "Renamed", "revision": 2}
    assert rows[2].after == {"status": "archived", "revision": 3}
    assert rows[3].after == {"status": "active", "revision": 4}


def test_routes_reject_a_soft_deleted_department_reference(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    department = Department(department_name=f"Board active department {uuid7()}")
    db.add(department)
    db.flush()
    set_audit_actor(db, owner.id)
    client = _client(db, owner)

    created = client.post(
        "/api/boards",
        json={"name": "Department board", "department_id": str(department.id)},
    )
    assert created.status_code == 201
    board_id = UUID(created.json()["id"])
    assert created.json()["department_id"] == str(department.id)

    department.is_deleted = True
    department.deleted_at = datetime.now(UTC)
    db.flush()
    rejected = client.patch(
        f"/api/boards/{board_id}",
        json={"revision": 1, "department_id": str(department.id)},
    )

    assert rejected.status_code == 409
    assert rejected.json()["detail"]["code"] == "department_unavailable"
    board = db.get(Board, board_id)
    assert board is not None and board.department_id == department.id
    assert [row.action for row in _board_audit_rows(db, board_id)] == [AuditAction.CREATE]
