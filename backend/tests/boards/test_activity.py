"""Board activity is a reader-safe projection, not the administrator audit API."""

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.activity_router import router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.boards.support import board_group, client, member, project_board
from tests.conftest import membership_of

pytestmark = pytest.mark.integration


def test_board_activity_lists_metadata_and_groups_without_content(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager: User = member(db)
    reader, outsider = member(db), member(db)
    set_audit_actor(db, manager.id)
    board = project_board(db, description="PRIVATE BOARD NOTES")
    group_row = board_group(db, board, [reader], AccessLevel.READ)
    # Board widgets are gone; their past audit rows stay in Manage > Audit only.
    past_widget = uuid7()
    past_row = AuditLog(
        org_id=board.org_id,
        performed_by=manager.id,
        action=AuditAction.CREATE,
        entity_type="board_widgets",
        entity_id=past_widget,
        after={"board_id": str(board.id), "name": "PAST WIDGET"},
    )
    object.__setattr__(past_row, "_audit_internal", True)
    db.add(past_row)
    db.flush()
    board.revision += 1  # A content change also moves the Board revision; it is not activity.
    db.commit()

    root = f"/api/boards/{board.id}/activity"
    reader_client = client(db, reader, router)
    response = reader_client.get(root)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    result = response.json()
    assert {item["kind"] for item in result["items"]} == {"board", "group"}
    assert result["pagination"]["total"] == 2
    assert {frozenset(item) for item in result["items"]} == {
        frozenset({"id", "created_at", "kind", "action", "summary", "actor_label"})
    }
    assert all(item["actor_label"] == manager.username for item in result["items"])
    for secret in (
        str(reader.id),
        str(group_row.group_id),
        str(past_widget),
        "PRIVATE BOARD NOTES",
        "PAST WIDGET",
        "before",
        "after",
    ):
        assert secret not in response.text

    page = reader_client.get(f"{root}?limit=1&offset=1").json()
    assert page["pagination"] == {
        "limit": 1, "offset": 1, "count": 1, "total": 2, "has_more": False
    }
    assert client(db, outsider, router).get(root).status_code == 404
    assert reader_client.get(f"/api/boards/{uuid7()}/activity").json() == {
        "detail": "Board not found"
    }

    # A removed group row stays Board-scoped only through its audit snapshot.
    db.delete(group_row)
    db.commit()
    board_group(db, board, [reader], AccessLevel.READ)
    db.commit()
    after = client(db, reader, router).get(root)
    assert ("group", "delete") in {(item["kind"], item["action"]) for item in after.json()["items"]}


@pytest.mark.parametrize("actor_state", ["disabled", "unaccepted"])
def test_board_activity_hides_the_labels_of_inactive_actors(
    integration_owner_db: Session, actor_state: str,
) -> None:
    db = integration_owner_db
    author, viewer = member(db), member(db)
    board = project_board(db)
    board_group(db, board, [viewer], AccessLevel.READ)
    set_audit_actor(db, author.id)
    board.name = "Renamed"
    db.commit()
    if actor_state == "disabled":
        author.status = "disabled"
    else:
        membership_of(db, author.id).invitation_sent_at = author.created_at
    db.commit()

    result = client(db, viewer, router).get(f"/api/boards/{board.id}/activity").json()
    assert result["items"]
    assert all(item["actor_label"] is None for item in result["items"])
