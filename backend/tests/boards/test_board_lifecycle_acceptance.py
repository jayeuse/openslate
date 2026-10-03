"""Board archive, restore and purge contracts that the Boards page calls."""

from uuid import UUID

import pytest
from httpx import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards import lifecycle_router
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import router as event_router
from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.post_models import BoardPost
from app.systems.boards.post_router import router as post_router
from app.systems.boards.router import router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.boards.support import (
    admin,
    board_group,
    client,
    company_board,
    department_board,
    member,
    project_board,
)
from tests.boards.test_permanent_delete import _enabled

pytestmark = pytest.mark.integration


def _managed_board(db: Session) -> tuple[Board, User]:
    """A project Board and a member who manages it, committed so routes see both."""

    manager = member(db)
    board = project_board(db)
    board_group(db, board, [manager], AccessLevel.MANAGE)
    # Production sets the actor in get_current_identity; the test client bypasses it.
    set_audit_actor(db, manager.id)
    db.commit()
    return board, manager


def _state(db: Session, board_id: UUID) -> tuple[str, int]:
    db.expire_all()
    board = db.get(Board, board_id)
    assert board is not None
    return board.status, board.revision


def _code(response: Response) -> str:
    detail = response.json()["detail"]
    assert isinstance(detail, dict)
    return str(detail["code"])


def test_a_manager_archives_then_restores_a_project_board_as_the_audited_actor(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, manager = _managed_board(db)
    api = client(db, manager, router)

    archived = api.post(f"/api/boards/{board.id}/archive", json={"revision": 1})
    assert archived.status_code == 200
    assert (archived.json()["status"], archived.json()["revision"]) == ("archived", 2)
    restored = api.post(f"/api/boards/{board.id}/restore", json={"revision": 2})
    assert restored.status_code == 200
    assert (restored.json()["status"], restored.json()["revision"]) == ("active", 3)
    assert _state(db, board.id) == (BoardStatus.ACTIVE, 3)

    changes = db.scalars(
        select(AuditLog)
        .where(
            AuditLog.entity_type == "boards",
            AuditLog.entity_id == board.id,
            AuditLog.action == AuditAction.UPDATE,
        )
        .order_by(AuditLog.created_at, AuditLog.id)
    ).all()
    assert [row.after for row in changes] == [
        {"status": "archived", "revision": 2},
        {"status": "active", "revision": 3},
    ]
    assert [row.performed_by for row in changes] == [manager.id, manager.id]


def test_archive_and_restore_refuse_the_wrong_state_and_a_stale_revision(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, manager = _managed_board(db)
    api = client(db, manager, router)
    path = f"/api/boards/{board.id}"

    active_restore = api.post(f"{path}/restore", json={"revision": 1})
    assert active_restore.status_code == 409
    assert _code(active_restore) == "board_not_archived"
    stale_archive = api.post(f"{path}/archive", json={"revision": 7})
    assert stale_archive.status_code == 409
    assert _code(stale_archive) == "stale_revision"
    assert stale_archive.json()["detail"]["current_revision"] == 1
    assert _state(db, board.id) == (BoardStatus.ACTIVE, 1)

    assert api.post(f"{path}/archive", json={"revision": 1}).status_code == 200
    archived_again = api.post(f"{path}/archive", json={"revision": 2})
    assert archived_again.status_code == 409
    assert _code(archived_again) == "board_archived"
    stale_restore = api.post(f"{path}/restore", json={"revision": 1})
    assert stale_restore.status_code == 409
    assert _code(stale_restore) == "stale_revision"
    assert stale_restore.json()["detail"]["current_revision"] == 2
    assert _state(db, board.id) == (BoardStatus.ARCHIVED, 2)


def test_a_reader_is_forbidden_and_an_outsider_cannot_find_the_board_to_archive(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    reader, outsider = member(db), member(db)
    board = project_board(db)
    board_group(db, board, [reader], AccessLevel.READ)
    db.commit()
    path = f"/api/boards/{board.id}/archive"

    # The Board router's 403 and 404 carry a plain detail string, not a code object.
    forbidden = client(db, reader, router).post(path, json={"revision": 1})
    assert forbidden.status_code == 403
    assert forbidden.json() == {"detail": "Forbidden"}
    hidden = client(db, outsider, router).post(path, json={"revision": 1})
    assert hidden.status_code == 404
    assert hidden.json() == {"detail": "Board not found"}
    assert _state(db, board.id) == (BoardStatus.ACTIVE, 1)


def test_company_and_department_boards_cannot_be_restored(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    administrator = admin(db)
    company = company_board(db)
    department = department_board(db)
    # An archived department Board shows the refusal is by scope, not by status.
    department.status = BoardStatus.ARCHIVED
    db.commit()
    company_state = _state(db, company.id)
    api = client(db, administrator, router)

    for board in (company, department):
        refused = api.post(
            f"/api/boards/{board.id}/restore", json={"revision": _state(db, board.id)[1]}
        )
        assert refused.status_code == 409
        assert _code(refused) == "board_scope_fixed"
    assert _state(db, company.id) == company_state
    assert _state(db, department.id)[0] == BoardStatus.ARCHIVED


def test_archive_then_restore_keeps_posts_and_events_and_blocks_new_posts_meanwhile(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, manager = _managed_board(db)
    api = client(db, manager, router, post_router, event_router)
    posts = f"/api/boards/{board.id}/posts"

    published = api.post(posts, json={"board_revision": 1, "title": "Open", "body": "Open."})
    assert published.status_code == 201
    publish = api.post(
        f"{posts}/{published.json()['id']}/publish",
        json={
            "board_revision": _state(db, board.id)[1],
            "post_revision": 1,
            "publication_key": str(uuid7()),
        },
    )
    assert publish.status_code == 200
    draft = api.post(
        posts,
        json={"board_revision": _state(db, board.id)[1], "title": "Draft", "body": "Later."},
    )
    assert draft.status_code == 201
    event = api.post(
        f"/api/boards/{board.id}/events",
        json={
            "board_revision": _state(db, board.id)[1],
            "title": "Planning",
            "all_day": True,
            "start_date": "2026-09-14",
            "end_date": "2026-09-14",
            "timezone_name": "UTC",
        },
    )
    assert event.status_code == 201

    def children() -> dict[UUID, tuple[object, ...]]:
        db.expire_all()
        post_rows = db.scalars(select(BoardPost).where(BoardPost.board_id == board.id)).all()
        event_rows = db.scalars(select(BoardEvent).where(BoardEvent.board_id == board.id)).all()
        return {
            **{row.id: (row.status, row.revision, row.is_deleted) for row in post_rows},
            **{row.id: (row.archived, row.revision, row.is_deleted) for row in event_rows},
        }

    before = children()
    assert set(before) == {
        UUID(published.json()["id"]),
        UUID(draft.json()["id"]),
        UUID(event.json()["id"]),
    }
    assert before[UUID(published.json()["id"])][0] == "published"

    revision = _state(db, board.id)[1]
    assert api.post(f"/api/boards/{board.id}/archive", json={"revision": revision}).status_code == (
        200
    )
    blocked = api.post(
        posts, json={"board_revision": revision + 1, "title": "Late", "body": "Refused."}
    )
    assert blocked.status_code == 409
    assert _code(blocked) == "board_archived"
    assert children() == before
    restored = api.post(f"/api/boards/{board.id}/restore", json={"revision": revision + 1})
    assert restored.status_code == 200

    assert children() == before
    count = db.scalar(select(func.count(BoardPost.id)).where(BoardPost.board_id == board.id))
    assert count == 2


def test_board_purge_post_is_refused_when_disabled_and_for_a_non_admin_manager(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    administrator = admin(db)
    board, manager = _managed_board(db)
    board.status = BoardStatus.ARCHIVED
    db.commit()
    path = f"/api/boards/{board.id}/purge"
    body = {"token": uuid7().hex, "confirmation_name": str(board.id), "password": uuid7().hex}

    _enabled(monkeypatch, False)
    disabled = client(db, administrator, lifecycle_router.router).post(path, json=body)
    assert disabled.status_code == 403
    assert _code(disabled) == "purge_disabled"

    _enabled(monkeypatch, True)
    # require_admin refuses before the purge handler runs, with a plain detail string.
    not_admin = client(db, manager, lifecycle_router.router).post(path, json=body)
    assert not_admin.status_code == 403
    assert not_admin.json() == {"detail": "Forbidden"}
    assert _state(db, board.id) == (BoardStatus.ARCHIVED, 1)
