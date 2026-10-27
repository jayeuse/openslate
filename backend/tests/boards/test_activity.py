"""Board activity is a reader-safe projection, not the administrator audit API."""

from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel, Group
from app.systems.access.users.models import User
from app.systems.boards.activity_router import router
from app.systems.boards.group_router import router as group_router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.boards.support import admin, board_group, client, member, project_board
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
        frozenset({"id", "created_at", "kind", "action", "summary", "actor_label", "group"})
    }
    # A reader sees that groups changed, never which group or level (Board settings > Access
    # is manager-only).
    assert [item["group"] for item in result["items"]] == [None, None]
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


def _named_group(db: Session, board_org_id: object, name: str) -> Group:
    group = Group(org_id=board_org_id, name=name)
    db.add(group)
    db.flush()
    return group


def _rows(payload: dict[str, object]) -> set[tuple[object, ...]]:
    items = payload["items"]
    assert isinstance(items, list)
    return {
        (item["kind"], item["action"], None if item["group"] is None
         else frozenset(item["group"].items()))
        for item in items
    }


def _change(name: str | None, level: str | None, previous: str | None) -> frozenset[object]:
    return frozenset({"name": name, "level": level, "previous_level": previous}.items())


def test_board_activity_names_each_group_change_for_board_managers_only(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, reader = admin(db), member(db)
    board = project_board(db)
    audit = _named_group(db, board.org_id, "Internal Audit")
    crew = _named_group(db, board.org_id, "Field Crew")
    retired = _named_group(db, board.org_id, "Old Team")
    board_group(db, board, [reader], AccessLevel.READ, group=audit)
    board_group(db, board, [], AccessLevel.WRITE, group=crew)
    board_group(db, board, [], AccessLevel.MANAGE, group=retired)
    db.commit()

    # The level change and the removal go through the route that Board settings uses.
    replaced = client(db, manager, group_router).put(
        f"/api/boards/{board.id}/groups",
        json={"revision": board.revision, "groups": [
            {"group_id": str(audit.id), "level": "write"},
            {"group_id": str(retired.id), "level": "manage"},
        ]},
    )
    assert replaced.status_code == 200
    board.name = "Renamed"
    db.commit()
    # A group deleted after the change has no name to show any more.
    retired.is_deleted = True
    retired.deleted_at = datetime.now(UTC)
    db.commit()

    root = f"/api/boards/{board.id}/activity"
    managed = client(db, manager, router).get(root).json()
    assert managed["pagination"]["total"] == 7
    assert _rows(managed) == {
        ("board", "create", None),
        ("board", "update", None),
        ("group", "create", _change("Internal Audit", "read", None)),
        ("group", "update", _change("Internal Audit", "write", "read")),
        ("group", "create", _change("Field Crew", "write", None)),
        ("group", "delete", _change("Field Crew", None, "write")),
        ("group", "create", _change(None, "manage", None)),
    }
    assert {item["summary"] for item in managed["items"] if item["kind"] == "group"} == {
        "Board groups changed"
    }

    read = client(db, reader, router).get(root).json()
    assert read["pagination"]["total"] == 7
    assert _rows(read) == {
        ("board", "create", None),
        ("board", "update", None),
        ("group", "create", None),
        ("group", "update", None),
        ("group", "delete", None),
    }
    for hidden in ("Internal Audit", "Field Crew", "previous_level"):
        assert hidden not in str(read)


def test_board_activity_keeps_level_changes_after_the_group_is_removed(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, reader = admin(db), member(db)
    board, other = project_board(db), project_board(db)
    readers = _named_group(db, board.org_id, "Readers")
    triage = _named_group(db, board.org_id, "Service Triage")
    board_group(db, board, [reader], AccessLevel.READ, group=readers)
    db.commit()

    def replace(target: object, revision: int, groups: dict[Group, str]) -> int:
        response = client(db, manager, group_router).put(
            f"/api/boards/{target}/groups",
            json={"revision": revision, "groups": [
                {"group_id": str(group.id), "level": level} for group, level in groups.items()
            ]},
        )
        assert response.status_code == 200
        revision_after = response.json()["revision"]
        assert isinstance(revision_after, int)
        return revision_after

    # Board settings > Access: add at Read, change to Post, then Manager, then remove.
    revision = board.revision
    for level in ("read", "write", "manage"):
        revision = replace(board.id, revision, {readers: "read", triage: level})
    replace(board.id, revision, {readers: "read"})
    # The same group's history on another Board stays on that Board.
    revision = other.revision
    for level in ("write", "read"):
        revision = replace(other.id, revision, {triage: level})
    replace(other.id, revision, {})

    root = f"/api/boards/{board.id}/activity"
    managed = client(db, manager, router).get(root).json()
    assert managed["pagination"]["total"] == 6
    assert len(managed["items"]) == 6
    assert _rows(managed) == {
        ("board", "create", None),
        ("group", "create", _change("Readers", "read", None)),
        ("group", "create", _change("Service Triage", "read", None)),
        ("group", "update", _change("Service Triage", "write", "read")),
        ("group", "update", _change("Service Triage", "manage", "write")),
        ("group", "delete", _change("Service Triage", None, "manage")),
    }

    read = client(db, reader, router).get(root).json()
    assert read["pagination"]["total"] == 6
    assert [item["group"] for item in read["items"]] == [None] * 6
    assert sorted((item["kind"], item["action"]) for item in read["items"]) == [
        ("board", "create"),
        ("group", "create"),
        ("group", "create"),
        ("group", "delete"),
        ("group", "update"),
        ("group", "update"),
    ]
