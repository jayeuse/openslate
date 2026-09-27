"""Board activity is a viewer-safe projection, not the administrator audit API."""

from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.activity_router import router
from app.systems.boards.models import Board, BoardGrant, BoardRecordPlacement, BoardWidget
from app.systems.manage.audit.context import set_audit_actor
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.rbac.support import capability_actor, grant_capability_actors

pytestmark = pytest.mark.integration


def _actor(db: Session, *, read: bool = True) -> User:
    """A member; Boards reads need no capability since slice 3."""

    return capability_actor(db, "board", {"records.write": True})


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def test_board_activity_filters_acl_and_widget_audience_before_count_and_page(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    manager = _actor(db)
    outsider = _actor(db)
    set_audit_actor(db, owner.id)
    board = Board(owner_id=owner.id, name="Operations", description="PRIVATE BOARD NOTES")
    other = Board(owner_id=owner.id, name="Other")
    department = Department(department_name=f"Activity {uuid7()}")
    db.add_all([board, other, department])
    db.flush()
    module = Module(department_id=department.id, module_name="Requests")
    db.add(module)
    db.flush()
    grant_capability_actors(db, department, module)
    record = Record(module_id=module.id, data={})
    db.add(record)
    db.flush()
    grant = BoardGrant(
        board_id=board.id,
        principal_type="user",
        principal_user_id=manager.id,
        permission="manage",
        effect="allow",
    )
    private = BoardWidget(
        board_id=board.id,
        module_id=module.id,
        creator_id=owner.id,
        name="Secret widget",
        position=0,
        widget_type="records",
        config={"private_note": "HIDDEN WIDGET CONFIG"},
        audience_kind="private",
    )
    public = BoardWidget(
        board_id=board.id,
        module_id=module.id,
        creator_id=owner.id,
        name="Visible widget",
        position=1,
        widget_type="records",
        config={"private_note": "VISIBLE WIDGET CONFIG"},
        audience_kind="everyone",
    )
    placement = BoardRecordPlacement(board_id=board.id, record_id=record.id)
    db.add_all([grant, private, public, placement])
    db.flush()
    board.revision += 1  # A hidden-widget mutation also produces a Board revision audit row.
    db.commit()

    root = f"/api/boards/{board.id}/activity"
    manager_client = _client(db, manager)
    response = manager_client.get(root)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    result = response.json()
    assert result["pagination"]["total"] == 4
    assert result["pagination"]["count"] == 4
    assert {item["kind"] for item in result["items"]} == {
        "board", "grant", "widget", "placement"
    }
    assert {frozenset(item) for item in result["items"]} == {
        frozenset({"id", "created_at", "kind", "action", "summary", "actor_label"})
    }
    assert all(item["actor_label"] == owner.username for item in result["items"])
    serialized = response.text
    for secret in (
        str(manager.id), str(private.id), str(public.id), str(record.id),
        "PRIVATE BOARD NOTES", "HIDDEN WIDGET CONFIG", "VISIBLE WIDGET CONFIG",
        "Secret widget", "Visible widget", "private_note", "request_path", "before", "after",
    ):
        assert secret not in serialized

    first = manager_client.get(f"{root}?limit=2&offset=0").json()
    second = manager_client.get(f"{root}?limit=2&offset=2").json()
    assert first["pagination"] == {
        "limit": 2, "offset": 0, "count": 2, "total": 4, "has_more": True
    }
    assert second["pagination"] == {
        "limit": 2, "offset": 2, "count": 2, "total": 4, "has_more": False
    }
    assert {item["id"] for item in first["items"]}.isdisjoint(
        {item["id"] for item in second["items"]}
    )
    assert _client(db, owner).get(root).json()["pagination"]["total"] == 5
    assert _client(db, outsider).get(root).status_code == 404
    assert manager_client.get(f"/api/boards/{uuid7()}/activity").json() == {
        "detail": "Board not found"
    }

    # Physically removed child rows remain Board-scoped only through private audit
    # snapshots; the endpoint must still return no principal or record identifier.
    db.delete(grant)
    db.delete(placement)
    db.commit()
    owner_activity = _client(db, owner).get(root)
    assert owner_activity.status_code == 200
    assert {(item["kind"], item["action"]) for item in owner_activity.json()["items"]} >= {
        ("grant", "delete"), ("placement", "delete")
    }
    assert str(manager.id) not in owner_activity.text
    assert str(record.id) not in owner_activity.text


def test_board_activity_omits_deleted_widget_history_and_inactive_actor_label(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    author = _actor(db)
    viewer = _actor(db)
    board = Board(owner_id=owner.id, name="Updates")
    department = Department(department_name=f"Activity deletion {uuid7()}")
    db.add_all([board, department])
    db.flush()
    db.add(
        BoardGrant(
            board_id=board.id, principal_type="user", principal_user_id=viewer.id,
            permission="view", effect="allow",
        )
    )
    module = Module(department_id=department.id, module_name="Requests")
    db.add(module)
    db.flush()
    grant_capability_actors(db, department, module)
    set_audit_actor(db, author.id)
    widget = BoardWidget(
        board_id=board.id, module_id=module.id, creator_id=author.id,
        name="Removed", position=0, widget_type="records", config={},
        audience_kind="everyone",
    )
    db.add(widget)
    board.name = "Renamed"
    db.commit()
    widget_id: UUID = widget.id
    db.delete(widget)
    author.status = "disabled"
    db.commit()

    response = _client(db, viewer).get(f"/api/boards/{board.id}/activity")
    assert response.status_code == 200
    result = response.json()
    assert all(item["kind"] != "widget" for item in result["items"])
    assert str(widget_id) not in response.text
    assert all(item["actor_label"] is None for item in result["items"])
    assert result["pagination"]["total"] == len(result["items"])
