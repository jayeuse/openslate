"""Board metadata API contracts using a non-persistent session double."""

from datetime import UTC, datetime
from typing import Any
from unittest.mock import Mock
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.models import Board, BoardGrant, BoardStatus
from app.systems.boards.router import router
from tests.rbac.support import make_user


def _user(name: str, *capabilities: str) -> User:
    """A member for Board writes; a guest when the old test gave only read."""

    return make_user(name, role="member" if "records.write" in capabilities else "guest")


def _board(*, owner_id: UUID, status: BoardStatus = BoardStatus.ACTIVE) -> Board:
    now = datetime.now(UTC)
    return Board(
        id=uuid7(),
        owner_id=owner_id,
        department_id=None,
        name="Operations",
        description="Board description",
        status=status,
        default_section="overview",
        revision=1,
        created_at=now,
        updated_at=now,
        deleted_at=None,
        is_deleted=False,
        performed_by=None,
    )


def _grant(
    board_id: UUID,
    *,
    user_id: UUID,
    permission: str = "manage",
    effect: str = "allow",
) -> BoardGrant:
    now = datetime.now(UTC)
    return BoardGrant(
        id=uuid7(),
        board_id=board_id,
        principal_type="user",
        principal_user_id=user_id,
        permission=permission,
        effect=effect,
        created_at=now,
        updated_at=now,
        deleted_at=None,
        is_deleted=False,
        performed_by=None,
    )


def _database(*, target: Board | None = None, grants: tuple[BoardGrant, ...] = ()) -> Mock:
    database = Mock(spec=Session)
    database.scalar.return_value = target
    database.scalars.return_value.all.return_value = list(grants)

    def refresh(entity: Any) -> None:
        now = datetime.now(UTC)
        if entity.id is None:
            entity.id = uuid7()
        if entity.created_at is None:
            entity.created_at = now
        if entity.updated_at is None:
            entity.updated_at = now
        if entity.revision is None:
            entity.revision = 1

    database.refresh.side_effect = refresh
    return database


def _client(database: Session, actor: User | None = None) -> TestClient:
    application = FastAPI()
    application.include_router(router, prefix="/api")
    application.dependency_overrides[get_db] = lambda: database
    if actor is not None:
        application.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(application)


def test_list_uses_acl_filter_before_offset_pagination_and_status_department_filters() -> None:
    actor = _user("board_reader", "records.read")
    target = _board(owner_id=actor.id)
    department_id = uuid7()
    target.status = BoardStatus.ARCHIVED
    target.department_id = department_id
    database = _database()
    database.scalar.return_value = 1
    database.scalars.return_value.all.return_value = [target]

    response = _client(database, actor).get(
        f"/api/boards?status=archived&department_id={department_id}&limit=10&offset=20"
    )

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.json()["items"][0]["id"] == str(target.id)
    assert response.json()["pagination"] == {
        "limit": 10,
        "offset": 20,
        "count": 1,
        "total": 1,
        "has_more": False,
    }
    item_statement = database.scalars.call_args.args[0]
    sql = str(item_statement.compile(dialect=postgresql.dialect()))
    assert "board_grants" in sql
    assert "boards.owner_id" in sql
    assert "boards.status" in sql
    assert "boards.department_id" in sql
    assert "LIMIT" in sql and "OFFSET" in sql


def test_list_rejects_soft_deleted_board_filter() -> None:
    actor = _user("board_reader_deleted_filter", "records.read")
    database = _database()

    response = _client(database, actor).get("/api/boards?deleted=include")

    assert response.status_code == 422
    assert database.scalar.call_count == 0


def test_read_hides_an_existing_board_without_view_access() -> None:
    actor = _user("board_reader_hidden", "records.read")
    target = _board(owner_id=uuid7())
    database = _database(target=target)

    response = _client(database, actor).get(f"/api/boards/{target.id}")

    assert response.status_code == 404
    assert response.json() == {"detail": "Board not found"}
    database.commit.assert_not_called()


def test_read_returns_board_for_creator() -> None:
    owner = _user("board_owner_reader", "records.read")
    target = _board(owner_id=owner.id)

    readable = _client(_database(target=target), owner).get(f"/api/boards/{target.id}")

    assert readable.status_code == 200
    assert readable.json()["id"] == str(target.id)


def test_read_and_missing_board_have_the_same_not_found_contract() -> None:
    actor = _user("board_reader_non_enumerating", "records.read")
    target = _board(owner_id=uuid7())
    hidden_response = _client(_database(target=target), actor).get(f"/api/boards/{target.id}")
    missing_response = _client(_database(), actor).get(f"/api/boards/{target.id}")

    assert hidden_response.status_code == missing_response.status_code == 404
    assert hidden_response.json() == missing_response.json()


def test_create_uses_actor_as_owner_and_returns_location_without_grants() -> None:
    actor = _user("board_creator", "records.write")
    department_id = uuid7()
    database = _database()
    database.scalar.return_value = department_id

    response = _client(database, actor).post(
        "/api/boards",
        json={
            "name": "  Team board  ",
            "description": "Notes",
            "department_id": str(department_id),
            "default_section": "calendar",
        },
    )

    assert response.status_code == 201
    created = database.add.call_args.args[0]
    assert isinstance(created, Board)
    assert created.owner_id == actor.id
    assert created.name == "Team board"
    assert created.department_id == department_id
    assert created.status is BoardStatus.ACTIVE
    assert created.default_section == "calendar"
    assert response.headers["location"] == f"/api/boards/{created.id}"
    assert response.json()["owner_id"] == str(actor.id)
    database.commit.assert_called_once()


def test_create_rejects_inactive_department_without_writing() -> None:
    actor = _user("board_creator_bad_department", "records.write")
    database = _database()

    response = _client(database, actor).post(
        "/api/boards",
        json={"name": "Team board", "department_id": str(uuid7())},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "department_unavailable"
    database.add.assert_not_called()
    database.commit.assert_not_called()


def test_create_requires_records_write_and_rejects_client_owned_fields() -> None:
    reader = _user("board_reader_cannot_create", "records.read")
    database = _database()

    denied = _client(database, reader).post("/api/boards", json={"name": "Team board"})
    malformed = _client(database, _user("board_writer_extra", "records.write")).post(
        "/api/boards",
        json={"name": "Team board", "owner_id": str(uuid7())},
    )

    assert denied.status_code == 403
    assert malformed.status_code == 422
    database.add.assert_not_called()


def test_metadata_patch_requires_manage_and_accepts_write_only_manager() -> None:
    writer = _user("board_editor_not_manager", "records.write")
    target = _board(owner_id=uuid7())
    edit_grant = _grant(target.id, user_id=writer.id, permission="edit")
    edit_only = _database(target=target, grants=(edit_grant,))

    denied = _client(edit_only, writer).patch(
        f"/api/boards/{target.id}", json={"revision": 1, "name": "Changed"}
    )

    manager = _user("board_manager_stale", "records.write")
    stale_db = _database(target=target, grants=(_grant(target.id, user_id=manager.id),))
    stale = _client(stale_db, manager).patch(
        f"/api/boards/{target.id}", json={"revision": 1, "name": "Changed"}
    )

    assert denied.status_code == 404
    assert stale.status_code == 200
    assert stale.json()["name"] == "Changed"
    assert stale.json()["revision"] == 2
    stale_db.commit.assert_called_once()


def test_stale_metadata_patch_returns_structured_conflict_without_mutation() -> None:
    manager = _user("board_manager_stale_patch", "records.write")
    target = _board(owner_id=uuid7())
    target.revision = 4
    database = _database(target=target, grants=(_grant(target.id, user_id=manager.id),))

    response = _client(database, manager).patch(
        f"/api/boards/{target.id}", json={"revision": 3, "name": "Changed"}
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "stale_revision"
    assert response.json()["detail"]["current_revision"] == 4
    assert target.name == "Operations"
    database.commit.assert_not_called()


def test_metadata_patch_rejects_inactive_department_without_mutation() -> None:
    manager = _user("board_manager_bad_department", "records.write")
    target = _board(owner_id=uuid7())
    database = _database(target=target, grants=(_grant(target.id, user_id=manager.id),))
    database.scalar.side_effect = [target, None]

    response = _client(database, manager).patch(
        f"/api/boards/{target.id}",
        json={"revision": 1, "department_id": str(uuid7())},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "department_unavailable"
    assert target.department_id is None
    database.commit.assert_not_called()


@pytest.mark.parametrize(
    ("command", "initial_status", "expected_status"),
    [
        ("archive", BoardStatus.ACTIVE, BoardStatus.ARCHIVED),
        ("restore", BoardStatus.ARCHIVED, BoardStatus.ACTIVE),
    ],
)
def test_archive_and_restore_use_status_and_revision_without_soft_deleting(
    command: str,
    initial_status: BoardStatus,
    expected_status: BoardStatus,
) -> None:
    manager = _user(f"board_manager_{command}", "records.write")
    target = _board(owner_id=uuid7(), status=initial_status)
    database = _database(target=target, grants=(_grant(target.id, user_id=manager.id),))

    response = _client(database, manager).post(
        f"/api/boards/{target.id}/{command}", json={"revision": 1}
    )

    assert response.status_code == 200
    assert response.json()["status"] == expected_status.value
    assert response.json()["revision"] == 2
    assert target.status is expected_status
    assert target.is_deleted is False
    database.commit.assert_called_once()


@pytest.mark.parametrize(
    ("command", "initial_status"),
    [("archive", BoardStatus.ACTIVE), ("restore", BoardStatus.ARCHIVED)],
)
def test_archive_and_restore_reject_stale_revision_without_mutation(
    command: str,
    initial_status: BoardStatus,
) -> None:
    manager = _user(f"board_manager_stale_{command}", "records.write")
    target = _board(owner_id=uuid7(), status=initial_status)
    target.revision = 5
    database = _database(target=target, grants=(_grant(target.id, user_id=manager.id),))

    response = _client(database, manager).post(
        f"/api/boards/{target.id}/{command}", json={"revision": 4}
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "stale_revision"
    assert target.status is initial_status
    assert target.revision == 5
    assert target.is_deleted is False
    database.commit.assert_not_called()


def test_missing_identity_is_rejected_before_database_access() -> None:
    database = _database()

    response = _client(database).get("/api/boards")

    assert response.status_code == 401
    assert database.scalar.call_count == 0
