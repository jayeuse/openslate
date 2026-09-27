"""Board template API authorization, audience, capacity, and rollback contracts."""

import json
import os
import threading
from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event, func, insert, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.systems.access.users.models import User
from app.systems.boards.models import Board, BoardGrant, BoardWidget
from app.systems.boards.portability import parse_portable_board
from app.systems.boards.template_models import BoardTemplate
from app.systems.boards.template_router import TEMPLATE_COUNT_LOCK, router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.conftest import guarded_create_engine
from tests.rbac.support import capability_actor, grant_capability_actors, make_user


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _engine_client(engine: Engine, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")

    def request_db():
        with AuditSession(bind=engine) as db:
            yield db

    app.dependency_overrides[get_db] = request_db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _actor(db: Session, name: str, *, read: bool = True, write: bool = True) -> User:
    """Map the retired read and write capabilities: write makes a member, read alone a guest."""

    return capability_actor(db, "board", {"records.read": read, "records.write": write})


def _source_board(db: Session, owner: User) -> tuple[Board, Module, Field]:
    department = Department(department_name=f"Template source {uuid7().hex}")
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id,
        module_name="Requests",
    )
    board = Board(
        owner_id=owner.id,
        department_id=department.id,
        name="Operations",
        description="Current board",
        status="active",
        default_section="overview",
    )
    db.add_all([module, board])
    db.flush()
    grant_capability_actors(db, department, module)
    field = Field(module_id=module.id, name="Reference", type=FieldType.TEXT, position=0)
    db.add(field)
    db.flush()
    return board, module, field


def _widget(
    board: Board,
    module: Module,
    field: Field,
    *,
    creator: User,
    position: int,
    name: str,
    filter_value: str,
    audience_kind: str = "everyone",
    audience_user_id=None,
) -> BoardWidget:
    return BoardWidget(
        board_id=board.id,
        module_id=module.id,
        creator_id=creator.id,
        name=name,
        position=position,
        widget_type="records",
        config={
            "version": 1,
            "fields": [{"field_id": str(field.id), "expected_type": "text"}],
            "filters": [
                {
                    "field_id": str(field.id),
                    "expected_type": "text",
                    "operator": "eq",
                    "value": filter_value,
                }
            ],
            "logic": "and",
            "metric": None,
            "visualization": "bar",
            "size": "half",
            "refresh": "manual",
            "pinned": False,
        },
        audience_kind=audience_kind,
        audience_user_id=audience_user_id,
    )


def _empty_bundle() -> dict[str, object]:
    return {
        "kind": "openslate-board",
        "version": 2,
        "configuration": {
            "name": "Operations",
            "description": None,
            "department_name": None,
            "default_section": "overview",
            "widgets": [],
        },
    }


def test_template_routes_refuse_a_guest_before_database_work() -> None:
    guest = make_user("template_guest", role="guest")
    db = Mock(spec=Session)
    board_id, template_id = uuid7(), uuid7()
    client = _client(db, guest)

    assert client.get("/api/board-templates").status_code == 403
    assert client.get(f"/api/board-templates/{template_id}").status_code == 403
    assert client.delete(f"/api/board-templates/{template_id}").status_code == 403
    assert (
        client.post(
            "/api/board-templates", json={"board_id": str(board_id), "name": "Starter"}
        ).status_code
        == 403
    )
    assert client.post(f"/api/board-templates/{template_id}/boards").status_code == 403
    db.scalar.assert_not_called()
    db.scalars.assert_not_called()
    db.add.assert_not_called()


def test_template_name_validation_rejects_blank_and_oversize_before_database_work() -> None:
    manager = make_user("template_manager", role="member")
    db = Mock(spec=Session)
    client = _client(db, manager)
    board_id = uuid7()

    for name in ("   ", "x" * 81):
        assert (
            client.post(
                "/api/board-templates", json={"board_id": str(board_id), "name": name}
            ).status_code
            == 422
        )
    db.scalar.assert_not_called()
    db.add.assert_not_called()


@pytest.mark.integration
def test_template_save_filters_audience_and_use_creates_private_structure_only_board(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "owner")
    manager = _actor(db, "manager")
    outsider = _actor(db, "outsider")
    write_only = _actor(db, "write-only", read=False)
    board, module, field = _source_board(db, owner)
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=manager.id,
            permission="manage",
            effect="allow",
        )
    )
    db.add_all(
        [
            _widget(
                board,
                module,
                field,
                creator=owner,
                position=0,
                name="Open requests",
                filter_value="visible-filter",
            ),
            _widget(
                board,
                module,
                field,
                creator=owner,
                position=1,
                name="Restricted",
                filter_value="hidden-filter",
                audience_kind="user",
                audience_user_id=outsider.id,
            ),
        ]
    )
    db.commit()
    set_audit_actor(db, manager.id)
    manager_client = _client(db, manager)
    outsider_client = _client(db, outsider)

    denied = outsider_client.post(
        "/api/board-templates", json={"board_id": str(board.id), "name": "Starter"}
    )
    assert denied.status_code == 404
    assert db.scalar(select(func.count(BoardTemplate.id))) == 0

    saved = manager_client.post(
        "/api/board-templates", json={"board_id": str(board.id), "name": "Starter"}
    )
    assert saved.status_code == 201
    template_id = saved.json()["id"]
    assert saved.json()["name"] == "Starter"
    assert saved.json()["widget_count"] == 1
    assert "bundle" not in saved.json()
    assert saved.headers["Location"] == f"/api/board-templates/{template_id}"
    detail = manager_client.get(saved.headers["Location"])
    assert detail.status_code == 200
    assert detail.json()["id"] == template_id
    assert "bundle" not in detail.json()
    template = db.get(BoardTemplate, template_id)
    assert template is not None
    bundle = parse_portable_board(json.dumps(template.bundle).encode())
    assert bundle.version == 2
    assert [widget.name for widget in bundle.configuration.widgets] == ["Open requests"]
    assert "hidden-filter" not in json.dumps(template.bundle)
    assert "audience" not in json.dumps(template.bundle)
    created_log = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "board_templates",
            AuditLog.entity_id == template.id,
            AuditLog.action == AuditAction.CREATE,
        )
    )
    assert created_log is not None and created_log.after is not None
    assert created_log.after["bundle"] == "[REDACTED]"

    listed = outsider_client.get("/api/board-templates?limit=1&offset=0")
    assert listed.status_code == 200
    assert listed.json()["pagination"]["total"] == 1
    assert listed.json()["items"][0]["id"] == template_id
    assert "bundle" not in listed.json()["items"][0]

    used = manager_client.post(f"/api/board-templates/{template_id}/boards")
    assert used.status_code == 201
    new_board_id = used.json()["id"]
    assert used.json()["owner_id"] == str(manager.id)
    assert used.json()["status"] == "active"
    assert used.headers["Location"] == f"/api/boards/{new_board_id}"
    new_widgets = db.scalars(select(BoardWidget).where(BoardWidget.board_id == new_board_id)).all()
    assert len(new_widgets) == 1
    assert new_widgets[0].audience_kind == "everyone"
    assert new_widgets[0].config["filters"][0]["value"] == "visible-filter"
    assert (
        db.scalar(select(func.count(BoardGrant.id)).where(BoardGrant.board_id == new_board_id)) == 0
    )

    deleted = _client(db, write_only).delete(f"/api/board-templates/{template_id}")
    assert deleted.status_code == 204
    assert deleted.content == b""
    db.refresh(template)
    assert template.is_deleted is True and template.deleted_at is not None
    assert manager_client.get("/api/board-templates").json()["items"] == []
    assert manager_client.get(f"/api/board-templates/{template_id}").status_code == 404
    assert manager_client.post(f"/api/board-templates/{template_id}/boards").status_code == 404
    assert (
        db.scalar(
            select(func.count(AuditLog.id)).where(
                AuditLog.entity_type == "board_templates",
                AuditLog.entity_id == template.id,
                AuditLog.action == AuditAction.DELETE,
            )
        )
        == 1
    )


@pytest.mark.integration
def test_template_cap_counts_only_active_rows_and_soft_delete_releases_a_slot(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "capacity-owner")
    board, _, _ = _source_board(db, owner)
    templates = [
        BoardTemplate(name=f"Starter {index:02d}", bundle=_empty_bundle()) for index in range(50)
    ]
    db.add_all(templates)
    db.commit()
    client = _client(db, owner)
    payload = {"board_id": str(board.id), "name": "Fifty-first"}

    full = client.post("/api/board-templates", json=payload)
    assert full.status_code == 409
    assert full.json()["detail"]["code"] == "template_limit_reached"
    assert (
        db.scalar(select(func.count(BoardTemplate.id)).where(BoardTemplate.is_deleted.is_(False)))
        == 50
    )

    assert client.delete(f"/api/board-templates/{templates[0].id}").status_code == 204
    saved = client.post("/api/board-templates", json=payload)
    assert saved.status_code == 201
    assert (
        db.scalar(select(func.count(BoardTemplate.id)).where(BoardTemplate.is_deleted.is_(False)))
        == 50
    )


@pytest.mark.integration
def test_template_instantiation_revalidates_sources_and_corrupt_bundle_without_partial_board(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "source-owner")
    board, module, field = _source_board(db, owner)
    db.add(
        _widget(
            board,
            module,
            field,
            creator=owner,
            position=0,
            name="Requests",
            filter_value="ready",
        )
    )
    db.commit()
    client = _client(db, owner)
    saved = client.post("/api/board-templates", json={"board_id": str(board.id), "name": "Starter"})
    assert saved.status_code == 201
    template_id = saved.json()["id"]
    before = db.scalar(select(func.count(Board.id)))

    module.is_deleted = True
    module.deleted_at = datetime.now(UTC)
    db.commit()
    missing_source = client.post(f"/api/board-templates/{template_id}/boards")
    assert missing_source.status_code == 409
    assert missing_source.json()["detail"]["code"] == "board_source_unavailable"
    assert db.scalar(select(func.count(Board.id))) == before

    template = db.get(BoardTemplate, template_id)
    assert template is not None
    template.bundle = {"kind": "openslate-board", "version": 1}
    db.commit()
    malformed = client.post(f"/api/board-templates/{template_id}/boards")
    assert malformed.status_code == 409
    assert malformed.json()["detail"]["code"] == "template_invalid"
    assert db.scalar(select(func.count(Board.id))) == before

    board.status = "archived"
    db.commit()
    archived = client.post(
        "/api/board-templates", json={"board_id": str(board.id), "name": "Archived copy"}
    )
    assert archived.status_code == 409
    assert archived.json()["detail"]["code"] == "board_archived"
    assert db.scalar(select(func.count(BoardTemplate.id))) == 1


@pytest.mark.integration
def test_template_cap_serializes_a_racing_save_against_the_fiftieth_insert() -> None:
    owner_url = os.getenv("MIGRATION_DATABASE_URL")
    runtime_url = os.getenv("TEST_DATABASE_URL")
    if owner_url is None or runtime_url is None:
        pytest.skip("Template concurrency requires the disposable PostgreSQL runner")
    owner_engine = guarded_create_engine(owner_url)
    runtime_engine = guarded_create_engine(runtime_url)
    token = uuid7().hex[:12]
    prefix = f"race-{token}-"
    with AuditSession(bind=owner_engine, expire_on_commit=False) as setup:
        actor = _actor(setup, f"race-{token}")
        board = Board(owner_id=actor.id, name=f"race-{token}", status="active")
        setup.add(board)
        setup.add_all(
            BoardTemplate(name=f"{prefix}{index:02d}", bundle=_empty_bundle())
            for index in range(49)
        )
        setup.commit()
        board_id, actor_id = board.id, actor.id

    attempted = threading.Event()
    results = []
    thread = None

    def detect_lock_attempt(connection, cursor, statement, parameters, context, many):
        if "pg_advisory_xact_lock" in statement:
            attempted.set()

    holder = owner_engine.connect()
    transaction = holder.begin()
    listener_installed = False
    try:
        holder.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": TEMPLATE_COUNT_LOCK})

        event.listen(runtime_engine, "before_cursor_execute", detect_lock_attempt)
        listener_installed = True

        def save() -> None:
            client = _engine_client(runtime_engine, actor)
            try:
                results.append(
                    client.post(
                        "/api/board-templates",
                        json={"board_id": str(board_id), "name": f"{prefix}new"},
                    )
                )
            finally:
                client.close()

        thread = threading.Thread(target=save, daemon=True)
        thread.start()
        assert attempted.wait(timeout=10), "save never reached the capacity lock"
        assert results == []
        holder.execute(
            insert(BoardTemplate).values(
                id=uuid7(), name=f"{prefix}fiftieth", bundle=_empty_bundle()
            )
        )
        transaction.commit()
        thread.join(timeout=10)
        assert not thread.is_alive()
        assert len(results) == 1
        assert results[0].status_code == 409
        assert results[0].json()["detail"]["code"] == "template_limit_reached"
        with owner_engine.connect() as check:
            count = check.scalar(
                select(func.count(BoardTemplate.id)).where(BoardTemplate.name.like(f"{prefix}%"))
            )
            assert count == 50
    finally:
        if transaction.is_active:
            transaction.rollback()
        holder.close()
        if thread is not None:
            thread.join(timeout=10)
        if listener_installed:
            event.remove(runtime_engine, "before_cursor_execute", detect_lock_attempt)
        with owner_engine.begin() as cleanup:
            cleanup.execute(
                text("DELETE FROM public.board_templates WHERE name LIKE :prefix"),
                {"prefix": f"{prefix}%"},
            )
            cleanup.execute(text("DELETE FROM public.boards WHERE id = :id"), {"id": board_id})
            cleanup.execute(text("DELETE FROM public.users WHERE id = :id"), {"id": actor_id})
        runtime_engine.dispose()
        owner_engine.dispose()
