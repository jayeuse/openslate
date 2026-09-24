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
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.boards.models import Board, BoardGrant
from app.systems.boards.router import router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.departments.models import Department

pytestmark = pytest.mark.integration


def _actor(
    db: Session,
    *,
    capabilities: dict[str, bool] | None = None,
    role: Role | None = None,
) -> User:
    if role is None:
        suffix = uuid7().hex
        role = Role(role=f"board-test-{suffix}", permissions=capabilities or {})
        db.add(role)
        db.flush()

    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"board-{user_id.hex}@example.test",
        username=f"board_{user_id.hex[:20]}",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
        role=role,
    )
    db.add(user)
    db.flush()
    return user


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
    role_id: UUID | None = None,
) -> None:
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type=principal_type,
            principal_user_id=user_id,
            principal_role_id=role_id,
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


def test_list_applies_user_role_everyone_precedence_before_count_and_pagination(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    role = Role(
        role=f"board-acl-{uuid7().hex}",
        permissions={"records.read": True},
    )
    db.add(role)
    db.flush()
    actor = _actor(db, role=role)
    owner = _actor(db, role=role)
    set_audit_actor(db, actor.id)

    everyone_only = _board(db, owner.id, "01 everyone allow")
    role_over_everyone = _board(db, owner.id, "02 role beats everyone deny")
    user_over_broader_denials = _board(db, owner.id, "03 user beats broader denials")
    role_deny_over_everyone = _board(db, owner.id, "04 role deny beats everyone allow")
    user_deny_over_role = _board(db, owner.id, "05 user deny beats role allow")
    user_tie_deny = _board(db, owner.id, "06 user deny wins tie")

    _grant(db, everyone_only, "everyone", "allow")

    _grant(db, role_over_everyone, "role", "allow", role_id=role.id)
    _grant(db, role_over_everyone, "everyone", "deny")

    _grant(db, user_over_broader_denials, "user", "allow", user_id=actor.id)
    _grant(db, user_over_broader_denials, "role", "deny", role_id=role.id)
    _grant(db, user_over_broader_denials, "everyone", "deny")

    _grant(db, role_deny_over_everyone, "role", "deny", role_id=role.id)
    _grant(db, role_deny_over_everyone, "everyone", "allow")

    _grant(db, user_deny_over_role, "user", "deny", user_id=actor.id)
    _grant(db, user_deny_over_role, "role", "allow", role_id=role.id)
    _grant(db, user_deny_over_role, "everyone", "allow")

    _grant(db, user_tie_deny, "user", "allow", user_id=actor.id)
    _grant(db, user_tie_deny, "user", "deny", user_id=actor.id)

    response = _client(db, actor).get("/api/boards?limit=2&offset=1")

    assert response.status_code == 200
    result = response.json()
    assert [item["name"] for item in result["items"]] == [
        "02 role beats everyone deny",
        "03 user beats broader denials",
    ]
    assert result["pagination"] == {
        "limit": 2,
        "offset": 1,
        "count": 2,
        "total": 3,
        "has_more": False,
    }


def test_global_record_capability_gates_are_enforced_by_routes(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    read_only = _actor(db, capabilities={"records.read": True})
    write_only = _actor(db, capabilities={"records.write": True})
    set_audit_actor(db, read_only.id)

    read_client = _client(db, read_only)
    write_client = _client(db, write_only)
    assert read_client.get("/api/boards").status_code == 200
    assert read_client.post("/api/boards", json={"name": "Not allowed"}).status_code == 403
    assert write_client.get("/api/boards").status_code == 403
    set_audit_actor(db, write_only.id)
    created = write_client.post("/api/boards", json={"name": "Write only create"})
    assert created.status_code == 201
    assert created.json()["owner_id"] == str(write_only.id)


def test_hidden_board_detail_has_the_same_not_found_response_as_missing(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    role = Role(role=f"board-hidden-{uuid7().hex}", permissions={"records.read": True})
    db.add(role)
    db.flush()
    reader = _actor(db, role=role)
    owner = _actor(db, role=role)
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
    owner = _actor(db, capabilities={"records.read": True, "records.write": True})
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
    owner = _actor(db, capabilities={"records.read": True, "records.write": True})
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
