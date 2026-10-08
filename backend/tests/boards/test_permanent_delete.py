"""Planned Board purge deletes retained children only after exact confirmation."""

from datetime import UTC, date, datetime
from secrets import token_urlsafe
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import Group
from app.systems.access.users.models import User
from app.systems.boards import lifecycle_router
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGroup, BoardWidget
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.exceptions import LifecycleInvalidTarget
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.router import router as sandbox_lifecycle_router
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleOperation,
    LifecycleTargetType,
)
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.boards.provider_accounts import create_password_account

pytestmark = pytest.mark.integration


def _actor(db: Session, *, admin: bool, password: str | None = None) -> User:
    role = "admin" if admin else None
    if role is None:
        role = "member"
        db.flush()
    user_id = uuid7()
    email = f"board-purge-{user_id.hex}@example.test"
    provider_user_id = (
        create_password_account(db, email=email, password=password)
        if password is not None
        else None
    )
    actor = User(
        id=user_id,
        email=email,
        supabase_user_id=provider_user_id,
        username=f"purge_{user_id.hex[:12]}",
        status="active",
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(lifecycle_router.router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _board_graph(
    db: Session, actor: User, *, scope: str = "project"
) -> tuple[Board, dict[str, UUID], Record, Department]:
    """An archived Board with one of each child; only project Boards are purged on their own."""

    board_department = Department(department_name=f"Board purge {uuid7().hex}")
    source_department = Department(department_name=f"Board source {uuid7().hex}")
    db.add_all([board_department, source_department])
    db.flush()
    module = Module(department_id=source_department.id, module_name="Source")
    db.add(module)
    db.flush()
    record = Record(module_id=module.id, data={"name": "keep"})
    board = Board(
        scope=scope,
        department_id=board_department.id if scope == "department" else None,
        name="Archive me",
        status="archived",
    )
    group = Group(name=f"Purge group {uuid7().hex}")
    db.add_all([record, board, group])
    db.flush()
    children = [
        BoardGroup(board_id=board.id, group_id=group.id, level="read"),
        BoardWidget(
            board_id=board.id,
            module_id=module.id,
            name="Source records",
            position=0,
            widget_type="records",
            config={},
        ),
        BoardEvent(
            board_id=board.id,
            author_id=actor.id,
            title="Private event details",
            details="Do not reveal this in the impact response",
            all_day=True,
            start_date=date(2026, 9, 23),
            end_date=date(2026, 9, 23),
            timezone_name="UTC",
        ),
    ]
    db.add_all(children)
    db.flush()
    post = BoardPost(
        board_id=board.id,
        author_id=actor.id,
        title="Soft-deleted post title",
        body="Private post working body",
        status="published",
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add(post)
    db.flush()
    revision = BoardPostRevision(
        post_id=post.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=actor.id,
        title="Published post title",
        body="Private published body",
        published_at=datetime.now(UTC),
    )
    db.add(revision)
    children.extend((post, revision))
    db.commit()
    return board, {child.__tablename__: child.id for child in children}, record, board_department


def _enabled(monkeypatch: pytest.MonkeyPatch, enabled: bool) -> None:
    monkeypatch.setattr(
        lifecycle_router,
        "get_settings",
        lambda: SimpleNamespace(lifecycle_purge_enabled=enabled),
    )


def test_board_purge_preview_requires_admin_toggle_and_closed_board_and_lists_all_children(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    admin = _actor(db, admin=True)
    member = _actor(db, admin=False)
    board, children, _, _ = _board_graph(db, admin)
    archived = BoardPost(
        board_id=board.id,
        author_id=admin.id,
        title="Archived post title",
        body="Private archived body",
        status="archived",
    )
    db.add(archived)
    db.flush()
    archived_revision = BoardPostRevision(
        post_id=archived.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="b" * 64,
        author_id=admin.id,
        title=archived.title,
        body=archived.body,
        published_at=datetime.now(UTC),
    )
    db.add(archived_revision)
    db.commit()
    path = f"/api/boards/{board.id}/purge/preview"

    _enabled(monkeypatch, True)
    assert _client(db, member).post(path).status_code == 403
    _enabled(monkeypatch, False)
    disabled = _client(db, admin).post(path)
    assert disabled.status_code == 403
    assert disabled.json()["detail"]["code"] == "purge_disabled"

    _enabled(monkeypatch, True)
    board.status = "active"
    db.commit()
    open_board = _client(db, admin).post(path)
    assert open_board.status_code == 409
    assert open_board.json()["detail"]["code"] == "purge_requires_closed"

    board.status = "archived"
    db.commit()
    response = _client(db, admin).post(path)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    payload = response.json()
    assert payload["confirmation_name"] == board.name
    assert payload["impact"]["actor_id"] == str(admin.id)
    assert payload["impact"]["target_type"] == "board"
    assert {(row["entity_type"], row["entity_id"]) for row in payload["impact"]["rows"]} == {
        ("boards", str(board.id)),
        *((table, str(row_id)) for table, row_id in children.items()),
        ("board_posts", str(archived.id)),
        ("board_post_revisions", str(archived_revision.id)),
    }
    assert "Private event details" not in response.text
    assert "Private post working body" not in response.text
    assert "Private published body" not in response.text
    assert "Private archived body" not in response.text
    # The authorized administrator receives the typed name, while the impact stays opaque.
    assert "Archive me" not in str(payload["impact"])

    board.status = "active"
    board.is_deleted = True
    board.deleted_at = None
    db.commit()
    inconsistent_delete = _client(db, admin).post(path)
    assert inconsistent_delete.status_code == 409
    assert inconsistent_delete.json()["detail"]["code"] == "purge_requires_closed"

    board.deleted_at = datetime.now(UTC)
    db.commit()
    assert _client(db, admin).post(path).status_code == 200


def test_confirmed_board_purge_deletes_its_children_but_preserves_sources_and_audits(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    password = token_urlsafe(32)
    admin = _actor(db, admin=True, password=password)
    set_audit_actor(db, admin.id)
    board, children, record, department = _board_graph(db, admin)
    untouched = Board(scope="project", name="Keep this Board")
    db.add(untouched)
    db.commit()
    _enabled(monkeypatch, True)
    client = _client(db, admin)
    path = f"/api/boards/{board.id}/purge"
    preview = client.post(f"{path}/preview")
    assert preview.status_code == 200

    result = client.post(
        path,
        json={
            "token": preview.json()["token"],
            "confirmation_name": board.name,
            "password": password,
        },
    )

    assert result.status_code == 200, result.text
    assert result.headers["Cache-Control"] == "no-store"
    assert result.json()["impact"]["impact_digest"] == preview.json()["impact"]["impact_digest"]
    assert db.get(Board, board.id) is None
    for model in (BoardGroup, BoardWidget, BoardEvent, BoardPost, BoardPostRevision):
        assert db.get(model, children[model.__tablename__]) is None
    assert db.get(Record, record.id) is not None
    assert db.get(Department, department.id) is not None
    assert db.get(Board, untouched.id) is not None
    deleted = db.scalars(
        select(AuditLog).where(
            AuditLog.action == "delete",
            AuditLog.entity_id.in_([board.id, *children.values()]),
        )
    ).all()
    assert {row.entity_id for row in deleted} == {board.id, *children.values()}


def test_board_purge_rejects_drift_after_password_without_partial_deletion(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    password = token_urlsafe(32)
    admin = _actor(db, admin=True, password=password)
    board, children, _, _ = _board_graph(db, admin)
    _enabled(monkeypatch, True)
    client = _client(db, admin)
    path = f"/api/boards/{board.id}/purge"
    token = client.post(f"{path}/preview").json()["token"]
    event = db.get(BoardEvent, children["board_events"])
    assert event is not None
    event.details = "Changed after preview"
    db.commit()

    response = client.post(
        path,
        json={"token": token, "confirmation_name": board.name, "password": password},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "impact_changed"
    assert db.get(Board, board.id) is not None
    assert db.get(BoardEvent, event.id) is not None


def test_board_purge_rejects_new_published_revision_after_preview(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    password = token_urlsafe(32)
    admin = _actor(db, admin=True, password=password)
    board, children, _, _ = _board_graph(db, admin)
    _enabled(monkeypatch, True)
    client = _client(db, admin)
    path = f"/api/boards/{board.id}/purge"
    token = client.post(f"{path}/preview").json()["token"]
    revision = BoardPostRevision(
        post_id=children["board_posts"],
        publication_number=2,
        publication_key=uuid7(),
        content_fingerprint="c" * 64,
        author_id=admin.id,
        title="Another published title",
        body="Another private published body",
        published_at=datetime.now(UTC),
    )
    db.add(revision)
    db.commit()

    denied = client.post(
        path,
        json={"token": token, "confirmation_name": board.name, "password": password},
    )

    assert denied.status_code == 409
    assert denied.json()["detail"]["code"] == "impact_changed"
    assert db.get(Board, board.id) is not None
    assert db.get(BoardPostRevision, revision.id) is not None


def test_board_purge_rejects_wrong_confirmation_and_target_bound_token(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    password = token_urlsafe(32)
    admin = _actor(db, admin=True, password=password)
    board, _, _, _ = _board_graph(db, admin)
    other = Board(scope="project", name="Another", status="archived")
    db.add(other)
    db.commit()
    _enabled(monkeypatch, True)
    client = _client(db, admin)
    token = client.post(f"/api/boards/{board.id}/purge/preview").json()["token"]
    wrong_name = client.post(
        f"/api/boards/{board.id}/purge",
        json={"token": token, "confirmation_name": other.name, "password": password},
    )
    assert wrong_name.status_code == 422
    assert wrong_name.json()["detail"]["code"] == "confirmation_name_mismatch"
    wrong_target = client.post(
        f"/api/boards/{other.id}/purge",
        json={"token": token, "confirmation_name": other.name, "password": password},
    )
    assert wrong_target.status_code == 403
    assert wrong_target.json()["detail"]["code"] == "challenge_binding_mismatch"
    another_admin = _actor(db, admin=True)
    db.commit()
    wrong_actor = _client(db, another_admin).post(
        f"/api/boards/{board.id}/purge",
        json={"token": token, "confirmation_name": board.name, "password": password},
    )
    assert wrong_actor.status_code == 403
    assert wrong_actor.json()["detail"]["code"] == "challenge_binding_mismatch"
    assert db.get(Board, board.id) is not None
    assert db.get(Board, other.id) is not None


def test_board_purge_rolls_back_child_deletes_on_commit_failure(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    password = token_urlsafe(32)
    admin = _actor(db, admin=True, password=password)
    board, children, _, _ = _board_graph(db, admin)
    _enabled(monkeypatch, True)
    client = _client(db, admin)
    path = f"/api/boards/{board.id}/purge"
    token = client.post(f"{path}/preview").json()["token"]
    original_verify = lifecycle_router.verify_challenge

    def fail_after_password(*args, **kwargs):
        challenge = original_verify(*args, **kwargs)
        monkeypatch.setattr(
            db,
            "commit",
            lambda: (_ for _ in ()).throw(IntegrityError("commit", {}, Exception("failure"))),
        )
        return challenge

    monkeypatch.setattr(lifecycle_router, "verify_challenge", fail_after_password)
    failed = client.post(
        path,
        json={"token": token, "confirmation_name": board.name, "password": password},
    )
    assert failed.status_code == 409
    assert failed.json()["detail"]["code"] == "board_purge_conflict"
    assert db.get(Board, board.id) is not None
    for model in (BoardGroup, BoardWidget, BoardEvent, BoardPost, BoardPostRevision):
        assert db.get(model, children[model.__tablename__]) is not None


def test_board_purge_rechecks_fresh_admin_after_password_step_up(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    password = token_urlsafe(32)
    admin = _actor(db, admin=True, password=password)
    board, _, _, _ = _board_graph(db, admin)
    _enabled(monkeypatch, True)
    path = f"/api/boards/{board.id}/purge"
    token = _client(db, admin).post(f"{path}/preview").json()["token"]
    actor_id = admin.id
    assert admin.role == "admin"
    db.expunge(admin)
    fresh_actor = db.get(User, actor_id)
    assert fresh_actor is not None
    fresh_actor.role = "member"
    db.commit()

    denied = _client(db, admin).post(
        path,
        json={"token": token, "confirmation_name": board.name, "password": password},
    )

    assert denied.status_code == 403
    assert db.get(Board, board.id) is not None


def test_board_target_stays_out_of_generic_sandbox_lifecycle_planner_and_router(
    integration_owner_db: Session,
) -> None:
    assert not any("boards" in route.path for route in sandbox_lifecycle_router.routes)
    with pytest.raises(LifecycleInvalidTarget):
        plan_lifecycle(
            integration_owner_db,
            LifecycleTargetType.BOARD,
            uuid7(),
            LifecycleOperation.PURGE,
            uuid7(),
        )
