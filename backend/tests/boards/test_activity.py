"""Board activity is a reader-safe projection, not the administrator audit API."""

from uuid import UUID

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.activity_router import router
from app.systems.boards.models import BoardWidget
from app.systems.manage.audit.context import set_audit_actor
from tests.boards.support import board_group, client, member, project_board
from tests.rbac.support import add_department, add_module

pytestmark = pytest.mark.integration


def _widget(board_id: UUID, module_id: UUID, name: str, position: int) -> BoardWidget:
    return BoardWidget(
        board_id=board_id,
        module_id=module_id,
        name=name,
        position=position,
        widget_type="records",
        config={"private_note": f"{name.upper()} CONFIG"},
    )


def test_board_activity_lists_metadata_groups_and_tiles_without_content(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager: User = member(db)
    reader, outsider = member(db), member(db)
    set_audit_actor(db, manager.id)
    board = project_board(db, description="PRIVATE BOARD NOTES")
    module = add_module(db, add_department(db))
    group_row = board_group(db, board, [reader], AccessLevel.READ)
    first, second = (
        _widget(board.id, module.id, "First tile", 0),
        _widget(board.id, module.id, "Second tile", 1),
    )
    db.add_all([first, second])
    db.flush()
    board.revision += 1  # A content change also moves the Board revision; it is not activity.
    db.commit()

    root = f"/api/boards/{board.id}/activity"
    reader_client = client(db, reader, router)
    response = reader_client.get(root)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    result = response.json()
    assert {item["kind"] for item in result["items"]} == {"board", "group", "widget"}
    assert result["pagination"]["total"] == 4
    assert {frozenset(item) for item in result["items"]} == {
        frozenset({"id", "created_at", "kind", "action", "summary", "actor_label"})
    }
    assert all(item["actor_label"] == manager.username for item in result["items"])
    for secret in (
        str(reader.id),
        str(group_row.group_id),
        str(first.id),
        "PRIVATE BOARD NOTES",
        "FIRST TILE CONFIG",
        "Second tile",
        "private_note",
        "before",
        "after",
    ):
        assert secret not in response.text

    page = reader_client.get(f"{root}?limit=2&offset=2").json()
    assert page["pagination"] == {
        "limit": 2, "offset": 2, "count": 2, "total": 4, "has_more": False
    }
    assert client(db, outsider, router).get(root).status_code == 404
    assert reader_client.get(f"/api/boards/{uuid7()}/activity").json() == {
        "detail": "Board not found"
    }

    # A removed group row stays Board-scoped only through its audit snapshot.
    db.delete(group_row)
    db.delete(second)
    db.commit()
    board_group(db, board, [reader], AccessLevel.READ)
    db.commit()
    after = client(db, reader, router).get(root)
    assert ("group", "delete") in {(item["kind"], item["action"]) for item in after.json()["items"]}
    assert all(
        item["kind"] != "widget" or item["action"] != "delete" for item in after.json()["items"]
    )


def test_board_activity_hides_the_labels_of_inactive_actors(integration_owner_db: Session) -> None:
    db = integration_owner_db
    author, viewer = member(db), member(db)
    board = project_board(db)
    board_group(db, board, [viewer], AccessLevel.READ)
    set_audit_actor(db, author.id)
    board.name = "Renamed"
    db.commit()
    author.status = "disabled"
    db.commit()

    result = client(db, viewer, router).get(f"/api/boards/{board.id}/activity").json()
    assert result["items"]
    assert all(item["actor_label"] is None for item in result["items"])
