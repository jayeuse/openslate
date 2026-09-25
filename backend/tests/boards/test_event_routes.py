"""Board event API authorization, audience, lifecycle, and occurrence contracts."""

from datetime import UTC, date, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import Role, User, UserDepartment
from app.systems.boards.event_author_router import router as author_router
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import router
from app.systems.boards.event_schemas import EventCreate
from app.systems.boards.models import Board, BoardGrant
from app.systems.sandbox.departments.models import Department
from tests.rbac.support import make_role, make_user


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(author_router, prefix="/api")
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _actor(db: Session, label: str, *, read: bool = True, write: bool = True) -> User:
    role = Role(
        role=f"event-{label}-{uuid7().hex[:8]}",
        permissions={
            "records.read": read,
            "records.write": write,
        },
    )
    db.add(role)
    db.flush()
    user_id = uuid7()
    actor = User(
        id=user_id,
        email=f"event-{user_id.hex}@example.test",
        username=f"event_{user_id.hex[:12]}",
        status="active",
        role_id=role.id,
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


def _board(db: Session, owner: User) -> Board:
    board = Board(owner_id=owner.id, name=f"Events {uuid7().hex[:12]}", status="active")
    db.add(board)
    db.flush()
    return board


def _grant(db: Session, board: Board, actor: User, permission: str) -> None:
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=actor.id,
            permission=permission,
            effect="allow",
        )
    )


def _series(
    db: Session,
    board: Board,
    author: User,
    title: str,
    *,
    audience: str = "everyone",
    role_id=None,
    user_id=None,
    department_id=None,
    day: date = date(2026, 9, 14),
) -> BoardEvent:
    event = BoardEvent(
        board_id=board.id,
        author_id=author.id,
        title=title,
        all_day=True,
        start_date=day,
        end_date=day,
        timezone_name="UTC",
        audience_kind=audience,
        audience_role_id=role_id,
        audience_user_id=user_id,
        audience_department_id=department_id,
    )
    db.add(event)
    db.flush()
    return event


def _payload(revision: int, *, audience: dict | None = None) -> dict:
    return {
        "board_revision": revision,
        "title": "Planning",
        "all_day": True,
        "start_date": "2026-09-14",
        "end_date": "2026-09-14",
        "timezone_name": "UTC",
        "audience": audience or {"kind": "everyone"},
    }


def test_event_routes_require_global_capabilities_before_board_or_event_lookup() -> None:
    reader = make_user("event_reader", role=make_role("member", {"records.read": True}))
    writer = make_user("event_writer", role=make_role("member", {"records.write": True}))
    db = Mock(spec=Session)
    board_id, event_id = uuid7(), uuid7()

    assert _client(db, writer).get(f"/api/boards/{board_id}/events").status_code == 403
    assert (
        _client(db, reader)
        .post(f"/api/boards/{board_id}/events", json={"board_revision": 1})
        .status_code
        == 403
    )
    assert (
        _client(db, reader)
        .request("DELETE", f"/api/boards/{board_id}/events/{event_id}", json={"board_revision": 1})
        .status_code
        == 403
    )
    db.scalar.assert_not_called()
    db.scalars.assert_not_called()


def test_event_input_rejects_temporal_ambiguity_and_unsupported_content() -> None:
    valid = _payload(1)
    assert EventCreate.model_validate(valid).all_day is True
    invalid = (
        {**valid, "timezone_name": "Not/A_Zone"},
        {**valid, "start_at": "2026-09-14T08:00:00Z"},
        {**valid, "recurrence": "weekly"},
        {**valid, "recurrence": "weekly", "repeat_until": "2026-09-13"},
        {**valid, "audience": {"kind": "role"}},
        {**valid, "attachments": []},
        {**valid, "reminders": []},
        {
            **valid,
            "all_day": False,
            "start_date": None,
            "end_date": None,
            "start_at": "2026-09-14T08:00:00",
            "end_at": "2026-09-14T09:00:00Z",
        },
        {
            **valid,
            "all_day": False,
            "start_date": None,
            "end_date": None,
            "start_at": "2026-09-14T16:00:00+08:00",
            "end_at": "2026-09-14T17:00:00+08:00",
        },
    )
    for candidate in invalid:
        with pytest.raises(ValidationError):
            EventCreate.model_validate(candidate)


@pytest.mark.integration
def test_event_audience_prefilters_counts_occurrences_and_id_mutations_for_managers(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "owner")
    manager = _actor(db, "manager")
    viewer = _actor(db, "viewer")
    department_viewer = _actor(db, "department-viewer")
    outsider = _actor(db, "outsider")
    admin_role = db.scalar(select(Role).where(Role.role == "admin"))
    assert admin_role is not None
    admin_id = uuid7()
    admin = User(
        id=admin_id,
        email=f"event-admin-{admin_id.hex}@example.test",
        username=f"event_admin_{admin_id.hex[:12]}",
        status="active",
        role_id=admin_role.id,
        role=admin_role,
    )
    db.add(admin)
    board = _board(db, owner)
    for actor, permission in ((manager, "manage"), (viewer, "view"), (department_viewer, "view")):
        _grant(db, board, actor, permission)
    department = Department(department_name=f"Event audience {uuid7().hex}")
    db.add(department)
    db.flush()
    membership = UserDepartment(user_id=department_viewer.id, department_id=department.id)
    db.add(membership)
    everyone = _series(db, board, owner, "Everyone")
    author = _series(db, board, owner, "Only author", audience="author")
    role = _series(db, board, owner, "Only role", audience="role", role_id=viewer.role_id)
    _series(db, board, owner, "Only user", audience="user", user_id=viewer.id)
    _series(db, board, owner, "Only department", audience="department", department_id=department.id)
    db.commit()
    root = f"/api/boards/{board.id}/events"

    assert _client(db, outsider).get(root).status_code == 404
    manager_client = _client(db, manager)
    manager_page = manager_client.get(f"{root}?limit=1&offset=0")
    assert manager_page.status_code == 200
    assert manager_page.json()["pagination"]["total"] == 1
    assert [item["id"] for item in manager_page.json()["items"]] == [str(everyone.id)]
    assert _client(db, owner).get(root).json()["pagination"]["total"] == 2
    assert _client(db, admin).get(root).json()["pagination"]["total"] == 1
    assert _client(db, viewer).get(root).json()["pagination"]["total"] == 3
    assert _client(db, department_viewer).get(root).json()["pagination"]["total"] == 2

    hidden = f"{root}/{role.id}"
    assert manager_client.get(hidden).status_code == 404
    assert _client(db, admin).get(hidden).status_code == 404
    assert (
        manager_client.patch(
            hidden,
            json={
                "board_revision": board.revision,
                "event_revision": role.revision,
                "title": "Probe",
            },
        ).status_code
        == 404
    )
    assert (
        manager_client.post(
            f"{hidden}/archive",
            json={
                "board_revision": board.revision,
                "event_revision": role.revision,
            },
        ).status_code
        == 404
    )
    assert (
        manager_client.request(
            "DELETE",
            hidden,
            json={
                "board_revision": board.revision,
                "event_revision": role.revision,
            },
        ).status_code
        == 404
    )
    assert manager_client.get(f"{root}/{author.id}").status_code == 404
    assert (
        manager_client.get(
            f"{root}/occurrences?window_start=2026-09-14&window_end=2026-09-14"
        ).json()["pagination"]["total"]
        == 1
    )

    membership.is_deleted = True
    membership.deleted_at = datetime.now(UTC)
    db.commit()
    assert _client(db, department_viewer).get(root).json()["pagination"]["total"] == 1


@pytest.mark.integration
def test_event_revisioned_author_and_manager_lifecycle_with_self_excluding_write(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner, editor, manager, other = (
        _actor(db, label) for label in ("crud-owner", "crud-editor", "crud-manager", "crud-other")
    )
    board = _board(db, owner)
    for actor, permission in ((editor, "edit"), (manager, "manage"), (other, "edit")):
        _grant(db, board, actor, permission)
    db.commit()
    root = f"/api/boards/{board.id}/events"
    editor_client, manager_client = _client(db, editor), _client(db, manager)

    unavailable = editor_client.post(
        root,
        json=_payload(
            1,
            audience={
                "kind": "role",
                "role_id": str(uuid7()),
            },
        ),
    )
    assert unavailable.status_code == 409
    assert unavailable.json()["detail"]["code"] == "audience_unavailable"
    assert _client(db, other).post(root, json=_payload(1)).status_code == 201
    # The other editor's create advances the Board revision and remains visible to managers.
    first = editor_client.post(root, json=_payload(2))
    assert first.status_code == 201
    event_id = first.json()["id"]
    assert first.json() == {"id": event_id, "event_revision": 1, "board_revision": 3}
    assert first.headers["Location"] == f"{root}/{event_id}"
    assert editor_client.get(first.headers["Location"]).status_code == 200
    assert (
        editor_client.patch(
            f"{root}/{event_id}",
            json={
                "board_revision": 2,
                "event_revision": 1,
                "title": "Stale",
            },
        ).json()["detail"]["code"]
        == "stale_board_revision"
    )

    own = editor_client.patch(
        f"{root}/{event_id}",
        json={
            "board_revision": 3,
            "event_revision": 1,
            "title": "Updated by author",
        },
    )
    assert own.status_code == 200
    assert own.json()["event_revision"] == 2
    assert own.json()["board_revision"] == 4
    assert (
        editor_client.patch(
            f"{root}/{event_id}",
            json={
                "board_revision": 4,
                "event_revision": 1,
                "title": "Stale event",
            },
        ).json()["detail"]["code"]
        == "stale_event_revision"
    )
    assert (
        _client(db, other)
        .patch(
            f"{root}/{event_id}",
            json={
                "board_revision": 4,
                "event_revision": 2,
                "title": "Not mine",
            },
        )
        .status_code
        == 403
    )

    managed = manager_client.patch(
        f"{root}/{event_id}",
        json={
            "board_revision": 4,
            "event_revision": 2,
            "title": "Managed",
        },
    )
    assert managed.status_code == 200
    assert managed.json()["board_revision"] == 5
    assert (
        editor_client.post(
            f"{root}/{event_id}/archive",
            json={
                "board_revision": 5,
                "event_revision": 3,
            },
        ).status_code
        == 404
    )
    archived = manager_client.post(
        f"{root}/{event_id}/archive",
        json={
            "board_revision": 5,
            "event_revision": 3,
        },
    )
    assert archived.status_code == 200
    assert archived.json()["event_revision"] == 4
    assert manager_client.get(f"{root}?archived=archived").json()["pagination"]["total"] == 1
    assert (
        editor_client.patch(
            f"{root}/{event_id}",
            json={
                "board_revision": 6,
                "event_revision": 4,
                "title": "No edits",
            },
        ).json()["detail"]["code"]
        == "event_archived"
    )
    restored = manager_client.post(
        f"{root}/{event_id}/restore",
        json={
            "board_revision": 6,
            "event_revision": 4,
        },
    )
    assert restored.status_code == 200
    assert restored.json()["board_revision"] == 7
    assert (
        manager_client.request(
            "DELETE",
            f"{root}/{event_id}",
            json={
                "board_revision": 7,
                "event_revision": 5,
            },
        ).json()["detail"]["code"]
        == "event_not_archived"
    )
    assert (
        manager_client.post(
            f"{root}/{event_id}/archive",
            json={
                "board_revision": 7,
                "event_revision": 5,
            },
        ).status_code
        == 200
    )
    assert (
        manager_client.request(
            "DELETE",
            f"{root}/{event_id}",
            json={
                "board_revision": 8,
                "event_revision": 6,
            },
        ).status_code
        == 204
    )
    assert manager_client.get(f"{root}/{event_id}").status_code == 404

    hidden_create = editor_client.post(
        root,
        json=_payload(
            9,
            audience={
                "kind": "user",
                "user_id": str(manager.id),
            },
        ),
    )
    assert hidden_create.status_code == 201
    assert set(hidden_create.json()) == {"id", "event_revision", "board_revision"}
    hidden_id = hidden_create.json()["id"]
    assert editor_client.get(f"{root}/{hidden_id}").status_code == 200
    regular = editor_client.get(root)
    assert regular.json()["pagination"]["total"] == 1
    assert hidden_id not in [item["id"] for item in regular.json()["items"]]
    mine = editor_client.get(f"{root}/mine?limit=1&offset=0")
    assert mine.status_code == 200
    assert mine.json()["pagination"] == {
        "limit": 1,
        "offset": 0,
        "count": 1,
        "total": 1,
        "has_more": False,
    }
    assert [item["id"] for item in mine.json()["items"]] == [hidden_id]
    other_mine = _client(db, other).get(f"{root}/mine")
    assert other_mine.json()["pagination"]["total"] == 1
    assert hidden_id not in [item["id"] for item in other_mine.json()["items"]]
    assert manager_client.get(f"{root}/{hidden_create.json()['id']}").status_code == 200
    board.status = "archived"
    db.commit()
    assert editor_client.post(root, json=_payload(10)).json()["detail"]["code"] == (
        "board_archived"
    )


@pytest.mark.integration
def test_event_creation_rejects_inactive_audience_targets_without_a_partial_write(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "inactive-target-owner")
    target_user = _actor(db, "inactive-target-user")
    expired_user = _actor(db, "expired-target-user")
    target_role = Role(role=f"inactive-event-role-{uuid7().hex}", permissions={})
    department = Department(department_name=f"Inactive event department {uuid7().hex}")
    board = _board(db, owner)
    db.add_all([target_role, department])
    db.flush()
    target_user.is_deleted = True
    expired_user.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    target_role.is_deleted = True
    department.is_deleted = True
    db.commit()
    client = _client(db, owner)
    root = f"/api/boards/{board.id}/events"

    for audience in (
        {"kind": "role", "role_id": str(target_role.id)},
        {"kind": "user", "user_id": str(target_user.id)},
        {"kind": "user", "user_id": str(expired_user.id)},
        {"kind": "department", "department_id": str(department.id)},
    ):
        response = client.post(root, json=_payload(1, audience=audience))
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "audience_unavailable"
    assert db.scalars(select(BoardEvent.id).where(BoardEvent.board_id == board.id)).all() == []
