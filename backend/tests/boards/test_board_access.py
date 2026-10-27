"""Board scope decides who reads and writes: company, department and project Boards."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User, UserRole
from app.systems.boards.access import board_level, board_reader_ids
from app.systems.boards.event_router import router as event_router
from app.systems.boards.models import Board
from app.systems.boards.post_models import BoardPost
from app.systems.boards.post_router import router as post_router
from app.systems.boards.router import router as boards_router
from tests.boards.support import (
    admin,
    board_group,
    company_board,
    department_board,
    grant,
    guest,
    member,
    project_board,
)
from tests.boards.support import client as _board_client
from tests.live_session_support import with_live_session
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration

ROUTERS = (boards_router, post_router, event_router)


def client(db: Session, actor: User, *routers: APIRouter) -> TestClient:
    """Board writers resolve the full identity, so the actor needs a live session."""

    return with_live_session(_board_client(db, actor, *routers), db, actor)


def _post(board: Board) -> dict[str, object]:
    return {"board_revision": board.revision, "title": "Stock count", "body": "Friday at 9."}


def _event(board: Board) -> dict[str, object]:
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(days=3)
    return {
        "board_revision": board.revision,
        "title": "Stock count",
        "all_day": False,
        "start_at": start.isoformat().replace("+00:00", "Z"),
        "end_at": (start + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        "timezone_name": "UTC",
    }


def test_every_active_account_reads_the_company_board_and_only_administrators_post(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board = company_board(db)
    reader, visitor, administrator = member(db), guest(db), admin(db)
    disabled = add_user(db, "disabled", status="disabled")

    assert board_level(db, reader, board) is AccessLevel.READ
    assert board_level(db, visitor, board) is AccessLevel.READ
    assert board_level(db, administrator, board) is AccessLevel.MANAGE
    assert board_level(db, disabled, board) is None
    assert client(db, reader, *ROUTERS).get(f"/api/boards/{board.id}").json()["level"] == "read"

    refused = client(db, reader, *ROUTERS).post(f"/api/boards/{board.id}/posts", json=_post(board))
    assert refused.status_code == 403
    created = client(db, administrator, *ROUTERS).post(
        f"/api/boards/{board.id}/posts", json=_post(board)
    )
    assert created.status_code == 201
    assert {reader.id, visitor.id, administrator.id} <= board_reader_ids(db, board)
    assert disabled.id not in board_reader_ids(db, board)


def test_department_board_follows_the_department_level(integration_owner_db: Session) -> None:
    db = integration_owner_db
    inventory = add_department(db, f"Inventory {uuid7().hex[:8]}")
    finance = add_department(db, f"Finance {uuid7().hex[:8]}")
    inventory_board, finance_board = department_board(db, inventory), department_board(db, finance)
    writer, reader, outsider, visitor = member(db), member(db), member(db), guest(db)
    make_group_access(db, [writer], inventory, level=AccessLevel.WRITE)
    make_group_access(db, [reader], inventory, level=AccessLevel.READ)
    make_group_access(db, [outsider], finance, level=AccessLevel.MANAGE)
    make_group_access(db, [visitor], inventory, level=AccessLevel.MANAGE)

    assert board_level(db, writer, inventory_board) is AccessLevel.WRITE
    assert board_level(db, reader, inventory_board) is AccessLevel.READ
    assert board_level(db, outsider, inventory_board) is None
    assert board_level(db, outsider, finance_board) is AccessLevel.MANAGE
    assert board_level(db, visitor, inventory_board) is AccessLevel.READ

    posted = client(db, writer, *ROUTERS).post(
        f"/api/boards/{inventory_board.id}/posts", json=_post(inventory_board)
    )
    assert posted.status_code == 201
    db.refresh(inventory_board)
    assert (
        client(db, writer, *ROUTERS)
        .post(f"/api/boards/{inventory_board.id}/events", json=_event(inventory_board))
        .status_code
        == 201
    )
    hidden = client(db, outsider, *ROUTERS)
    assert hidden.get(f"/api/boards/{inventory_board.id}").status_code == 404
    assert hidden.get(f"/api/boards/{inventory_board.id}/posts").status_code == 404
    listed = {item["id"] for item in hidden.get("/api/boards?limit=100").json()["items"]}
    assert str(finance_board.id) in listed and str(inventory_board.id) not in listed


def test_a_member_who_reads_only_some_modules_reads_the_department_board(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    department = add_department(db)
    module = add_module(db, department)
    board = department_board(db, department)
    module_reader = member(db)
    make_group_access(db, [module_reader], department, module, level=AccessLevel.WRITE)

    assert board_level(db, module_reader, board) is AccessLevel.READ
    assert module_reader.id in board_reader_ids(db, board)
    assert (
        client(db, module_reader, *ROUTERS)
        .post(f"/api/boards/{board.id}/posts", json=_post(board))
        .status_code
        == 403
    )


def test_project_board_follows_board_groups(integration_owner_db: Session) -> None:
    db = integration_owner_db
    board = project_board(db)
    reader, writer, manager, outsider = member(db), member(db), member(db), member(db)
    board_group(db, board, [reader], AccessLevel.READ)
    board_group(db, board, [writer], AccessLevel.WRITE)
    both = board_group(db, board, [manager], AccessLevel.READ)
    board_group(db, board, [manager], AccessLevel.MANAGE)

    assert board_level(db, reader, board) is AccessLevel.READ
    assert board_level(db, writer, board) is AccessLevel.WRITE
    assert board_level(db, manager, board) is AccessLevel.MANAGE
    assert board_level(db, outsider, board) is None
    assert both.level == "read"
    assert board_reader_ids(db, board) >= {reader.id, writer.id, manager.id}
    assert outsider.id not in board_reader_ids(db, board)
    assert client(db, outsider, *ROUTERS).get(f"/api/boards/{board.id}").status_code == 404
    assert client(db, reader, *ROUTERS).get(f"/api/boards/{board.id}").status_code == 200


def test_readers_and_members_without_a_group_cannot_change_board_content(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    department = add_department(db)
    board = department_board(db, department)
    reader, no_group, author = member(db), member(db), member(db)
    make_group_access(db, [reader], department, level=AccessLevel.READ)
    make_group_access(db, [author], department, level=AccessLevel.WRITE)
    item = BoardPost(org_id=board.org_id, board_id=board.id,
                     author_id=author.id, title="Mine", body="Body")
    db.add(item)
    db.flush()
    revision = {"board_revision": board.revision, "post_revision": item.revision}

    for actor, missing in ((reader, 403), (no_group, 404)):
        api = client(db, actor, *ROUTERS)
        root = f"/api/boards/{board.id}"
        assert api.post(f"{root}/posts", json=_post(board)).status_code == missing
        assert api.post(f"{root}/events", json=_event(board)).status_code == missing
        assert (
            api.patch(f"{root}/posts/{item.id}", json={**revision, "title": "Changed"}).status_code
            == missing
        )
        assert (
            api.request("DELETE", f"{root}/posts/{item.id}", json=revision).status_code == missing
        )
        assert api.patch(
            root, json={"revision": board.revision, "description": "x"}
        ).status_code in {
            missing,
            403,
        }
        assert api.post("/api/boards", json={"name": "Mine"}).status_code == 403


def test_managers_pin_and_change_the_posts_of_others(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    department = add_department(db)
    board = department_board(db, department)
    writer, other_writer, manager = member(db), member(db), member(db)
    make_group_access(db, [writer, other_writer], department, level=AccessLevel.WRITE)
    make_group_access(db, [manager], department, level=AccessLevel.MANAGE)
    item = BoardPost(org_id=board.org_id, board_id=board.id,
                     author_id=other_writer.id, title="Theirs", body="Body")
    db.add(item)
    db.flush()
    root = f"/api/boards/{board.id}"

    pin = {"board_revision": board.revision, "post_revision": item.revision, "pinned": True}
    assert (
        client(db, writer, *ROUTERS).patch(f"{root}/posts/{item.id}", json=pin).status_code == 403
    )
    assert (
        client(db, writer, *ROUTERS)
        .post(f"{root}/posts", json={**_post(board), "pinned": True})
        .status_code
        == 403
    )
    changed = client(db, manager, *ROUTERS).patch(f"{root}/posts/{item.id}", json=pin)
    assert changed.status_code == 200


def test_only_administrators_create_project_boards_and_company_scope_is_fixed(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    administrator = admin(db)
    manager = member(db)
    board = project_board(db)
    grant(db, board, [manager], AccessLevel.MANAGE)

    created = client(db, administrator, *ROUTERS).post("/api/boards", json={"name": "Opening"})
    assert created.status_code == 201
    assert created.json()["scope"] == "project"
    assert client(db, manager, *ROUTERS).post("/api/boards", json={"name": "No"}).status_code == 403

    renamed = client(db, manager, *ROUTERS).patch(
        f"/api/boards/{board.id}", json={"revision": board.revision, "name": "Store opening"}
    )
    assert renamed.status_code == 200
    company = company_board(db)
    archived = client(db, administrator, *ROUTERS).post(
        f"/api/boards/{company.id}/archive", json={"revision": company.revision}
    )
    assert archived.status_code == 409
    assert archived.json()["detail"]["code"] == "board_scope_fixed"


def test_department_board_name_follows_the_department(integration_owner_db: Session) -> None:
    db = integration_owner_db
    department = add_department(db, f"Inventory {uuid7().hex[:8]}")
    board = department_board(db, department)
    administrator = admin(db)

    refused = client(db, administrator, *ROUTERS).patch(
        f"/api/boards/{board.id}", json={"revision": board.revision, "name": "Other"}
    )
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "board_name_fixed"
    department.department_name = f"Stock {uuid7().hex[:8]}"
    department.is_deleted = True
    department_board(db, department)
    db.refresh(board)
    assert board.name == department.department_name
    assert board.status == "archived"


def test_an_expired_guest_reads_nothing(integration_owner_db: Session) -> None:
    db = integration_owner_db
    visitor = add_user(
        db, "expired", role=UserRole.GUEST, expires_at=datetime.now(UTC) - timedelta(days=1)
    )
    assert board_level(db, visitor, company_board(db)) is None
    assert visitor.id not in board_reader_ids(db, company_board(db))


def test_readable_board_ids_match_live_board_levels_and_account_eligibility(
    integration_owner_db: Session,
) -> None:
    from app.systems.boards.access import readable_board_ids

    db = integration_owner_db
    company = company_board(db)
    department = add_department(db)
    module = add_module(db, department)
    department_scope = department_board(db, department)
    project = project_board(db)
    archived = project_board(db)
    archived.status = "archived"
    deleted = project_board(db)
    deleted.is_deleted = True
    deleted.deleted_at = datetime.now(UTC)
    reader, visitor, outsider, administrator = member(db), guest(db), member(db), admin(db)
    make_group_access(db, [reader], department, module, level=AccessLevel.WRITE)
    make_group_access(db, [visitor], department, level=AccessLevel.MANAGE)
    board_group(db, project, [reader, visitor], AccessLevel.WRITE)
    board_group(db, archived, [reader, visitor], AccessLevel.READ)
    board_group(db, deleted, [reader, visitor], AccessLevel.MANAGE)
    inactive = add_user(db, "inactive-admin", role=UserRole.ADMIN, status="disabled")
    expired = add_user(
        db, "expired-reader", role=UserRole.GUEST, expires_at=datetime.now(UTC) - timedelta(days=1)
    )
    pending = add_user(db, "pending-reader", status="pending")
    removed = add_user(db, "deleted-reader")
    removed.is_deleted = True
    removed.deleted_at = datetime.now(UTC)
    db.flush()
    boards = (company, department_scope, project, archived, deleted)
    for actor in (reader, visitor, outsider, inactive, expired, pending, removed):
        actual = readable_board_ids(db, actor)
        assert actual is not None
        assert {board.id for board in boards if board.id in actual} == {
            board.id for board in boards if board_level(db, actor, board) is not None
        }
    assert {company.id, department_scope.id, project.id, archived.id} <= readable_board_ids(
        db, reader
    )
    assert deleted.id not in readable_board_ids(db, reader)
    assert readable_board_ids(db, administrator) is None
    for actor in (inactive, expired, pending, removed):
        assert readable_board_ids(db, actor) == frozenset()
