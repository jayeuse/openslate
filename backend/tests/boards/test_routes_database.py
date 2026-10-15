"""Board routes and the visible-Board SQL filter on the runner-owned PostgreSQL database."""

from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.boards.models import Board
from app.systems.boards.router import router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.boards.support import (
    admin,
    board_group,
    client,
    company_board,
    department_board,
    guest,
    member,
    project_board,
)
from tests.rbac.support import add_department, make_group_access

pytestmark = pytest.mark.integration


def _board_audit_rows(db: Session, board_id: UUID) -> list[AuditLog]:
    return list(
        db.scalars(
            select(AuditLog)
            .where(AuditLog.entity_type == "boards", AuditLog.entity_id == board_id)
            .order_by(AuditLog.created_at, AuditLog.id)
        ).all()
    )


def test_list_filters_to_visible_boards_before_count_and_pagination(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    actor = member(db)
    company_board(db)
    department = add_department(db, f"Visible {uuid7().hex[:6]}")
    make_group_access(db, [actor], department, level=AccessLevel.READ)
    tag = uuid7().hex[:6]
    department.department_name = f"{tag} 02 department"
    department_board(db, department)
    visible = project_board(db, f"{tag} 01 project")
    board_group(db, visible, [actor], AccessLevel.READ)
    project_board(db, f"{tag} 03 hidden project")
    department_board(db, add_department(db, f"{tag} 04 hidden department"))
    archived = project_board(db, f"{tag} 05 archived project")
    board_group(db, archived, [actor], AccessLevel.READ)
    archived.status = "archived"
    db.flush()

    api = client(db, actor, router)
    response = api.get(f"/api/boards?search={tag}&limit=1&offset=1")
    assert response.status_code == 200
    assert [item["name"] for item in response.json()["items"]] == [f"{tag} 02 department"]
    assert response.json()["pagination"] == {
        "limit": 1,
        "offset": 1,
        "count": 1,
        "total": 2,
        "has_more": False,
    }
    every = api.get(f"/api/boards?search={tag}&status=all").json()
    assert every["pagination"]["total"] == 3
    assert {item["level"] for item in every["items"]} == {"read"}
    projects = api.get("/api/boards?scope=project&status=all&limit=100").json()["items"]
    assert {item["scope"] for item in projects} == {"project"}
    company = api.get("/api/boards?scope=company").json()["items"]
    assert [item["id"] for item in company] == [str(company_board(db).id)]


def test_a_guest_reads_boards_but_cannot_create_one(integration_owner_db: Session) -> None:
    db = integration_owner_db
    visitor = guest(db)
    administrator = admin(db)
    set_audit_actor(db, administrator.id)

    visitor_client = client(db, visitor, router)
    assert visitor_client.get("/api/boards").status_code == 200
    assert visitor_client.post("/api/boards", json={"name": "Not allowed"}).status_code == 403
    created = client(db, administrator, router).post("/api/boards", json={"name": "Store opening"})
    assert created.status_code == 201
    assert created.json()["scope"] == "project"
    assert created.json()["level"] == "manage"
    assert created.headers["location"] == f"/api/boards/{created.json()['id']}"


def test_hidden_board_detail_has_the_same_not_found_response_as_missing(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    reader = member(db)
    hidden = project_board(db, "Private")

    api = client(db, reader, router)
    hidden_response = api.get(f"/api/boards/{hidden.id}")
    missing_response = api.get(f"/api/boards/{uuid7()}")

    assert hidden_response.status_code == missing_response.status_code == 404
    assert hidden_response.json() == missing_response.json() == {"detail": "Board not found"}


def test_patch_archive_restore_and_stale_revision_are_individually_audited(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager = member(db)
    board = project_board(db, "Initial")
    board_group(db, board, [manager], AccessLevel.MANAGE)
    set_audit_actor(db, manager.id)
    db.commit()
    api = client(db, manager, router)

    patched = api.patch(f"/api/boards/{board.id}", json={"revision": 1, "name": "Renamed"})
    assert patched.status_code == 200
    assert patched.json()["revision"] == 2
    archived = api.post(f"/api/boards/{board.id}/archive", json={"revision": 2})
    assert archived.status_code == 200
    assert archived.json()["status"] == "archived"
    stale = api.patch(f"/api/boards/{board.id}", json={"revision": 2, "name": "Stale"})
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "stale_revision"
    restored = api.post(f"/api/boards/{board.id}/restore", json={"revision": 3})
    assert restored.status_code == 200
    assert restored.json()["revision"] == 4

    stored = db.get(Board, board.id)
    assert stored is not None and stored.name == "Renamed" and stored.status == "active"
    rows = _board_audit_rows(db, board.id)
    assert [row.action for row in rows] == [
        AuditAction.CREATE,
        AuditAction.UPDATE,
        AuditAction.UPDATE,
        AuditAction.UPDATE,
    ]
    assert rows[1].after == {"name": "Renamed", "revision": 2}
    assert rows[2].after == {"status": "archived", "revision": 3}
    assert rows[3].after == {"status": "active", "revision": 4}


def test_writers_cannot_change_board_metadata(integration_owner_db: Session) -> None:
    db = integration_owner_db
    writer = member(db)
    board = project_board(db, "Writers")
    board_group(db, board, [writer], AccessLevel.WRITE)
    api = client(db, writer, router)

    assert (
        api.patch(f"/api/boards/{board.id}", json={"revision": 1, "name": "X"}).status_code == 403
    )
    assert api.post(f"/api/boards/{board.id}/archive", json={"revision": 1}).status_code == 403
    assert _board_audit_rows(db, board.id)[-1].action == AuditAction.CREATE
