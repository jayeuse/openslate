"""Board portability routes preserve ACL, audience and atomic private creation."""

import json
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.models import Board, BoardGrant, BoardRecordPlacement, BoardWidget
from app.systems.boards.portability_router import router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.rbac.support import capability_actor, grant_capability_actors, make_user


def _actor(db: Session, name: str, *, read: bool = True, write: bool = True) -> User:
    """Map the retired read and write capabilities: write makes a member, read alone a guest."""

    return capability_actor(db, "board", {"records.read": read, "records.write": write})


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _source(db: Session) -> tuple[Department, Module, Field]:
    department = Department(department_name=f"Portability {uuid7().hex[:12]}")
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id,
        module_name="Requests",
    )
    db.add(module)
    db.flush()
    grant_capability_actors(db, department, module)
    field = Field(module_id=module.id, name="Label", type=FieldType.TEXT, position=0)
    db.add(field)
    db.flush()
    return department, module, field


def _bundle(department: Department) -> dict:
    return {
        "kind": "openslate-board",
        "version": 2,
        "configuration": {
            "name": "Imported requests",
            "description": "Reusable structure",
            "department_name": department.department_name,
            "default_section": "overview",
            "widgets": [
                {
                    "name": "Open requests",
                    "widget_type": "records",
                    "source": {
                        "department_name": department.department_name,
                        "module_name": "Requests",
                    },
                    "config": {
                        "fields": [{"name": "Label", "expected_type": "text"}],
                        "filters": [],
                        "logic": "and",
                        "metric": None,
                        "visualization": "bar",
                        "size": "half",
                        "refresh": "manual",
                        "pinned": False,
                    },
                }
            ],
        },
    }


def _upload(client: TestClient, bundle: dict) -> object:
    return client.post(
        "/api/boards/import",
        content=json.dumps(bundle).encode(),
        headers={"Content-Type": "application/octet-stream"},
    )


def test_import_rejects_nonportable_bundle_before_any_database_write() -> None:
    actor = make_user("portability_pure", role="member")
    db = Mock(spec=Session)
    response = _client(db, actor).post(
        "/api/boards/import",
        content=b'{"kind":"openslate-board","version":1}',
        headers={"Content-Type": "application/octet-stream"},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "board_bundle_invalid"
    db.add.assert_not_called()
    db.commit.assert_not_called()


def test_duplicate_and_import_refuse_a_guest_before_board_lookup() -> None:
    actor = make_user("portability_guest", role="guest")
    db = Mock(spec=Session)
    client = _client(db, actor)
    board_id = uuid7()

    assert client.post(f"/api/boards/{board_id}/duplicate").status_code == 403
    assert (
        client.post(
            "/api/boards/import",
            content=b"{}",
            headers={"Content-Type": "application/octet-stream"},
        ).status_code
        == 403
    )
    db.scalar.assert_not_called()
    db.scalars.assert_not_called()


def test_board_manager_can_export_visible_structure() -> None:
    actor = make_user("portability_manager", role="member")
    board = Board(
        id=uuid7(),
        owner_id=uuid7(),
        name="Read-only managed Board",
        description=None,
        department_id=None,
        default_section="overview",
        is_deleted=False,
        deleted_at=None,
    )
    grant = BoardGrant(
        board_id=board.id,
        principal_type="user",
        principal_user_id=actor.id,
        permission="manage",
        effect="allow",
        is_deleted=False,
        deleted_at=None,
    )
    db = Mock(spec=Session)
    db.scalar.return_value = board
    db.scalars.side_effect = [
        SimpleNamespace(all=lambda: [grant]),
        SimpleNamespace(all=lambda: []),
        SimpleNamespace(all=lambda: []),
    ]

    client = _client(db, actor)
    response = client.get(f"/api/boards/{board.id}/configuration")

    assert response.status_code == 200
    assert response.json()["configuration"]["widgets"] == []
    assert db.scalar.call_count == 1
    db.add.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.integration
def test_import_creates_private_board_and_widgets_in_one_audited_transaction(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "owner")
    other = _actor(db, "other")
    department, module, field = _source(db)
    db.commit()
    set_audit_actor(db, owner.id)

    response = _upload(_client(db, owner), _bundle(department))

    assert response.status_code == 201
    board_id = UUID(response.json()["id"])
    assert response.headers["Location"] == f"/api/boards/{board_id}"
    board = db.get(Board, board_id)
    assert board is not None and board.owner_id == owner.id
    assert board.department_id == department.id and board.revision == 1
    widgets = db.scalars(select(BoardWidget).where(BoardWidget.board_id == board_id)).all()
    assert len(widgets) == 1
    assert widgets[0].module_id == module.id
    assert widgets[0].config["fields"] == [{"field_id": str(field.id), "expected_type": "text"}]
    assert widgets[0].creator_id == owner.id and widgets[0].audience_kind == "everyone"
    assert (
        db.scalar(
            select(func.count()).select_from(BoardGrant).where(BoardGrant.board_id == board_id)
        )
        == 0
    )
    assert (
        db.scalar(
            select(func.count())
            .select_from(BoardRecordPlacement)
            .where(BoardRecordPlacement.board_id == board_id)
        )
        == 0
    )
    assert _client(db, other).get(f"/api/boards/{board_id}/configuration").status_code == 404
    audit = db.scalars(
        select(AuditLog).where(AuditLog.entity_id.in_([board_id, widgets[0].id]))
    ).all()
    assert {(row.entity_type, row.action) for row in audit} == {
        ("boards", AuditAction.CREATE),
        ("board_widgets", AuditAction.CREATE),
    }


@pytest.mark.integration
def test_manager_export_and_duplicate_only_actor_visible_widgets(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "source-owner")
    manager = _actor(db, "manager")
    read_only_manager = _actor(db, "read-only-manager", write=False)
    viewer = _actor(db, "viewer")
    outsider = _actor(db, "outsider")
    department, module, field = _source(db)
    board = Board(
        owner_id=owner.id,
        department_id=department.id,
        name="Source",
        description="Private guidance",
    )
    db.add(board)
    db.flush()
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=manager.id,
            permission="manage",
            effect="allow",
        )
    )
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=viewer.id,
            permission="view",
            effect="allow",
        )
    )
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=read_only_manager.id,
            permission="manage",
            effect="allow",
        )
    )
    record = Record(module_id=module.id, data={})
    db.add(record)
    db.flush()
    db.add(BoardRecordPlacement(board_id=board.id, record_id=record.id))
    config = {
        "version": 1,
        "fields": [{"field_id": str(field.id), "expected_type": "text"}],
        "filters": [],
        "logic": "and",
        "metric": None,
        "visualization": "bar",
        "size": "half",
        "refresh": "manual",
        "pinned": False,
    }
    visible = BoardWidget(
        board_id=board.id,
        creator_id=owner.id,
        position=0,
        name="Visible",
        widget_type="records",
        module_id=module.id,
        config=config,
        audience_kind="everyone",
    )
    hidden = BoardWidget(
        board_id=board.id,
        creator_id=owner.id,
        position=1,
        name="Owner secret",
        widget_type="records",
        module_id=module.id,
        config=config,
        audience_kind="private",
    )
    db.add_all([visible, hidden])
    db.commit()
    set_audit_actor(db, manager.id)
    client = _client(db, manager)

    assert _client(db, outsider).get(f"/api/boards/{board.id}/configuration").status_code == 404
    assert _client(db, outsider).post(f"/api/boards/{board.id}/duplicate").status_code == 404
    assert _client(db, viewer).get(f"/api/boards/{board.id}/configuration").status_code == 404
    assert _client(db, viewer).post(f"/api/boards/{board.id}/duplicate").status_code == 404
    read_only = _client(db, read_only_manager)
    read_only_export = read_only.get(f"/api/boards/{board.id}/configuration")
    assert read_only_export.status_code == 200
    assert [item["name"] for item in read_only_export.json()["configuration"]["widgets"]] == [
        "Visible"
    ]
    assert read_only.post(f"/api/boards/{board.id}/duplicate").status_code == 403
    exported = client.get(f"/api/boards/{board.id}/configuration")
    assert exported.status_code == 200
    assert exported.headers["Cache-Control"] == "private, no-store"
    payload = exported.json()
    assert payload["version"] == 2
    assert [widget["name"] for widget in payload["configuration"]["widgets"]] == ["Visible"]
    assert "Owner secret" not in exported.text
    assert str(field.id) not in exported.text
    assert str(module.id) not in exported.text
    assert "audience" not in exported.text and "grants" not in exported.text

    duplicated = client.post(f"/api/boards/{board.id}/duplicate")
    assert duplicated.status_code == 201
    duplicate_id = UUID(duplicated.json()["id"])
    assert duplicate_id != board.id
    assert duplicated.headers["Location"] == f"/api/boards/{duplicate_id}"
    copied_board = db.get(Board, duplicate_id)
    assert copied_board is not None and copied_board.owner_id == manager.id
    assert copied_board.name == "Source (copy)"
    copied = db.scalars(select(BoardWidget).where(BoardWidget.board_id == duplicate_id)).all()
    assert len(copied) == 1 and copied[0].name == "Visible"
    assert copied[0].id not in {visible.id, hidden.id}
    assert copied[0].creator_id == manager.id and copied[0].audience_kind == "everyone"
    assert (
        db.scalar(
            select(func.count()).select_from(BoardGrant).where(BoardGrant.board_id == duplicate_id)
        )
        == 0
    )
    assert (
        db.scalar(
            select(func.count())
            .select_from(BoardRecordPlacement)
            .where(BoardRecordPlacement.board_id == duplicate_id)
        )
        == 0
    )


@pytest.mark.integration
def test_import_and_duplicate_fail_atomically_when_source_changed(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "failure-owner")
    department, module, field = _source(db)
    source_board = Board(owner_id=owner.id, name="Failure source")
    db.add(source_board)
    db.flush()
    db.add(
        BoardWidget(
            board_id=source_board.id,
            creator_id=owner.id,
            position=0,
            name="Invalid source",
            widget_type="records",
            module_id=module.id,
            config={
                "version": 1,
                "fields": [{"field_id": str(field.id), "expected_type": "text"}],
                "filters": [],
            },
            audience_kind="everyone",
        )
    )
    db.commit()
    field.is_deleted = True
    db.commit()
    set_audit_actor(db, owner.id)
    before = db.scalar(select(func.count()).select_from(Board))
    client = _client(db, owner)

    duplicate = client.post(f"/api/boards/{source_board.id}/duplicate")
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "board_source_unavailable"
    assert db.scalar(select(func.count()).select_from(Board)) == before

    imported = _upload(client, _bundle(department))
    assert imported.status_code == 409
    assert imported.json()["detail"]["code"] == "board_source_unavailable"
    assert db.scalar(select(func.count()).select_from(Board)) == before


@pytest.mark.integration
def test_import_rolls_back_board_and_widgets_after_commit_conflict(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    owner = _actor(db, "conflict-owner")
    department, _, _ = _source(db)
    db.commit()
    set_audit_actor(db, owner.id)
    before = db.scalar(select(func.count()).select_from(Board))

    def fail_commit() -> None:
        raise IntegrityError("board insert", {}, ValueError("conflict"))

    with monkeypatch.context() as patch:
        patch.setattr(db, "commit", fail_commit)
        response = _upload(_client(db, owner), _bundle(department))

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "board_import_conflict"
    assert db.scalar(select(func.count()).select_from(Board)) == before


@pytest.mark.integration
def test_import_rejects_nonportable_and_oversized_bundles_without_rows(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "invalid-owner")
    department, _, _ = _source(db)
    db.commit()
    set_audit_actor(db, owner.id)
    client = _client(db, owner)
    before = db.scalar(select(func.count()).select_from(Board))
    bundle = _bundle(department)
    bundle["configuration"]["widgets"][0]["audience"] = {"kind": "everyone"}

    rejected = _upload(client, bundle)
    assert rejected.status_code == 422
    assert rejected.json()["detail"]["code"] == "board_bundle_invalid"
    oversized = client.post(
        "/api/boards/import",
        content=b" " * (1024 * 1024 + 1),
        headers={"Content-Type": "application/octet-stream"},
    )
    assert oversized.status_code == 413
    assert db.scalar(select(func.count()).select_from(Board)) == before
