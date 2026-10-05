"""Board portability: managers export, administrators import or duplicate into project Boards."""

import json
from datetime import date
from hashlib import sha256
from unittest.mock import Mock
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.boards.attachment_models import BoardAttachment
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGroup, BoardWidget
from app.systems.boards.portability_router import router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.platform.files.models import File
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.boards.support import admin, client, grant, member, project_board
from tests.rbac.support import add_department, add_module, make_user


def _source(db: Session) -> tuple[Department, Module, Field]:
    department = add_department(db)
    module = add_module(db, department, "Requests")
    field = Field(module_id=module.id, name="Label", type=FieldType.TEXT, position=0)
    db.add(field)
    db.flush()
    return department, module, field


def _config(field: Field) -> dict[str, object]:
    return {
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


def _bundle(department: Department) -> dict[str, object]:
    return {
        "kind": "openslate-board",
        "version": 3,
        "configuration": {
            "name": "Imported requests",
            "description": "Reusable structure",
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


def _upload(api: TestClient, bundle: dict[str, object]) -> object:
    return api.post(
        "/api/boards/import",
        content=json.dumps(bundle).encode(),
        headers={"Content-Type": "application/octet-stream"},
    )


def test_import_rejects_nonportable_bundle_before_any_database_write() -> None:
    actor = make_user("portability_pure")
    db = Mock(spec=Session)
    response = client(db, actor, router).post(
        "/api/boards/import",
        content=b'{"kind":"openslate-board","version":2}',
        headers={"Content-Type": "application/octet-stream"},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "board_bundle_invalid"
    db.add.assert_not_called()
    db.commit.assert_not_called()


def test_import_and_duplicate_are_administrator_only() -> None:
    for role in ("member", "guest"):
        actor = make_user(f"portability_{role}", role=role)
        db = Mock(spec=Session)
        api = client(db, actor, router)
        assert api.post(f"/api/boards/{actor.id}/duplicate").status_code == 403
        assert (
            api.post(
                "/api/boards/import",
                content=b"{}",
                headers={"Content-Type": "application/octet-stream"},
            ).status_code
            == 403
        )
        db.scalar.assert_not_called()


@pytest.mark.integration
def test_import_creates_a_project_board_and_widgets_in_one_audited_transaction(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    administrator, other = admin(db), member(db)
    department, module, field = _source(db)
    db.commit()
    set_audit_actor(db, administrator.id)

    response = _upload(client(db, administrator, router), _bundle(department))

    assert response.status_code == 201, response.text
    board_id = UUID(response.json()["id"])
    assert response.headers["Location"] == f"/api/boards/{board_id}"
    assert response.json()["scope"] == "project"
    board = db.get(Board, board_id)
    assert board is not None and board.scope == "project" and board.department_id is None
    widgets = db.scalars(select(BoardWidget).where(BoardWidget.board_id == board_id)).all()
    assert len(widgets) == 1
    assert widgets[0].module_id == module.id
    assert widgets[0].config["fields"] == [{"field_id": str(field.id), "expected_type": "text"}]
    assert (
        db.scalar(
            select(func.count()).select_from(BoardGroup).where(BoardGroup.board_id == board_id)
        )
        == 0
    )
    assert client(db, other, router).get(f"/api/boards/{board_id}/configuration").status_code == 404
    audit = db.scalars(
        select(AuditLog).where(AuditLog.entity_id.in_([board_id, widgets[0].id]))
    ).all()
    assert {(row.entity_type, row.action) for row in audit} == {
        ("boards", AuditAction.CREATE),
        ("board_widgets", AuditAction.CREATE),
    }


@pytest.mark.integration
def test_managers_export_and_administrators_duplicate_every_widget(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    administrator, manager, writer, outsider = admin(db), member(db), member(db), member(db)
    department, module, field = _source(db)
    option_id = str(uuid7())
    status_field = Field(
        module_id=module.id,
        name="Status",
        type=FieldType.SELECT,
        position=1,
        config={"options": [{"id": option_id, "label": "Open"}]},
    )
    assignee_field = Field(
        module_id=module.id,
        name="Assignee",
        type=FieldType.USER,
        position=2,
        config={},
    )
    db.add_all((status_field, assignee_field))
    db.flush()
    board = project_board(db, "Source", description="Private guidance")
    grant(db, board, [manager], AccessLevel.MANAGE)
    grant(db, board, [writer], AccessLevel.WRITE)
    for position, name in enumerate(("First", "Second")):
        config = _config(field)
        config["fields"].append({"field_id": str(assignee_field.id), "expected_type": "user"})
        config["filters"] = [
            {
                "field_id": str(status_field.id),
                "expected_type": "select",
                "operator": "eq",
                "value": option_id,
            },
            {
                "field_id": str(assignee_field.id),
                "expected_type": "user",
                "operator": "empty",
                "value": None,
            },
        ]
        db.add(
            BoardWidget(
                board_id=board.id,
                position=position,
                name=name,
                widget_type="records",
                module_id=module.id,
                config=config,
            )
        )
    db.commit()

    assert (
        client(db, outsider, router).get(f"/api/boards/{board.id}/configuration").status_code == 404
    )
    assert (
        client(db, writer, router).get(f"/api/boards/{board.id}/configuration").status_code == 403
    )
    assert client(db, manager, router).post(f"/api/boards/{board.id}/duplicate").status_code == 403
    exported = client(db, manager, router).get(f"/api/boards/{board.id}/configuration")
    assert exported.status_code == 200
    assert exported.headers["Cache-Control"] == "private, no-store"
    payload = exported.json()
    assert payload["version"] == 3
    assert set(payload["configuration"]) == {"name", "description", "widgets"}
    assert [widget["name"] for widget in payload["configuration"]["widgets"]] == [
        "First",
        "Second",
    ]
    assert all(
        widget["config"]["filters"][0]["value"] == "Open"
        for widget in payload["configuration"]["widgets"]
    )
    assert all(
        widget["config"]["fields"][1] == {"name": "Assignee", "expected_type": "user"}
        and widget["config"]["filters"][1]["value"] is None
        for widget in payload["configuration"]["widgets"]
    )
    assert option_id not in exported.text
    assert str(field.id) not in exported.text and str(module.id) not in exported.text

    set_audit_actor(db, administrator.id)
    duplicated = client(db, administrator, router).post(f"/api/boards/{board.id}/duplicate")
    assert duplicated.status_code == 201
    duplicate_id = UUID(duplicated.json()["id"])
    copied_board = db.get(Board, duplicate_id)
    assert copied_board is not None and copied_board.name == "Source (copy)"
    assert copied_board.scope == "project"
    copied = db.scalars(select(BoardWidget).where(BoardWidget.board_id == duplicate_id)).all()
    assert sorted(item.name for item in copied) == ["First", "Second"]
    assert all(item.config["filters"][0]["value"] == option_id for item in copied)
    assert all(
        item.config["fields"][1]
        == {
            "field_id": str(assignee_field.id),
            "expected_type": "user",
        }
        and item.config["filters"][1]["value"] is None
        for item in copied
    )
    assert (
        db.scalar(
            select(func.count()).select_from(BoardGroup).where(BoardGroup.board_id == duplicate_id)
        )
        == 0
    )


@pytest.mark.integration
def test_valued_person_filters_fail_board_bundle_export_and_import(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    administrator, manager = admin(db), member(db)
    department, module, label_field = _source(db)
    assignee_field = Field(
        module_id=module.id,
        name="Assignee",
        type=FieldType.USER,
        position=1,
        config={},
    )
    db.add(assignee_field)
    db.flush()
    board = project_board(db, "Person filter source")
    grant(db, board, [manager], AccessLevel.MANAGE)
    widget_config = _config(label_field)
    widget_config["filters"] = [
        {
            "field_id": str(assignee_field.id),
            "expected_type": "user",
            "operator": "eq",
            "value": str(administrator.id),
        }
    ]
    db.add(
        BoardWidget(
            board_id=board.id,
            position=0,
            name="Assigned records",
            widget_type="records",
            module_id=module.id,
            config=widget_config,
        )
    )
    db.commit()
    before_boards = db.scalar(select(func.count()).select_from(Board))

    for response in (
        client(db, manager, router).get(f"/api/boards/{board.id}/configuration"),
        client(db, administrator, router).post(f"/api/boards/{board.id}/duplicate"),
    ):
        assert response.status_code == 422, response.text
        assert response.json()["detail"]["code"] == "board_bundle_invalid"
        assert "Person filter values cannot be transferred" in response.json()["detail"]["message"]

    bundle = _bundle(department)
    widget = bundle["configuration"]["widgets"][0]
    widget["config"]["fields"].append({"name": "Assignee", "expected_type": "user"})
    widget["config"]["filters"] = [
        {
            "name": "Assignee",
            "expected_type": "user",
            "operator": "eq",
            "value": str(administrator.id),
        }
    ]
    imported = _upload(client(db, administrator, router), bundle)
    assert imported.status_code == 422, imported.text
    assert imported.json()["detail"]["code"] == "board_bundle_invalid"
    assert "Person filter values cannot be transferred" in imported.json()["detail"]["message"]
    assert db.scalar(select(func.count()).select_from(Board)) == before_boards


@pytest.mark.integration
def test_import_and_duplicate_fail_atomically_when_source_changed(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    administrator = admin(db)
    department, module, field = _source(db)
    source_board = project_board(db, "Failure source")
    db.add(
        BoardWidget(
            board_id=source_board.id,
            position=0,
            name="Invalid source",
            widget_type="records",
            module_id=module.id,
            config={
                "version": 1,
                "fields": [{"field_id": str(field.id), "expected_type": "text"}],
                "filters": [],
            },
        )
    )
    db.commit()
    field.is_deleted = True
    db.commit()
    set_audit_actor(db, administrator.id)
    before = db.scalar(select(func.count()).select_from(Board))
    api = client(db, administrator, router)

    duplicate = api.post(f"/api/boards/{source_board.id}/duplicate")
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "board_source_unavailable"
    imported = _upload(api, _bundle(department))
    assert imported.status_code == 409
    assert imported.json()["detail"]["code"] == "board_source_unavailable"
    assert db.scalar(select(func.count()).select_from(Board)) == before


@pytest.mark.integration
def test_import_rolls_back_board_and_widgets_after_commit_conflict(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    administrator = admin(db)
    department, _, _ = _source(db)
    db.commit()
    set_audit_actor(db, administrator.id)
    before = db.scalar(select(func.count()).select_from(Board))

    def fail_commit() -> None:
        raise IntegrityError("board insert", {}, ValueError("conflict"))

    with monkeypatch.context() as patch:
        patch.setattr(db, "commit", fail_commit)
        response = _upload(client(db, administrator, router), _bundle(department))

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "board_import_conflict"
    assert db.scalar(select(func.count()).select_from(Board)) == before


@pytest.mark.integration
def test_duplicate_and_import_copy_no_board_files(integration_owner_db: Session) -> None:
    """A copied file would block the copy's purge, which refuses unpurged files."""
    db = integration_owner_db
    administrator = admin(db)
    department, module, field = _source(db)
    board = project_board(db, "Source with files")
    db.add(
        BoardWidget(
            board_id=board.id,
            position=0,
            name="First",
            widget_type="records",
            module_id=module.id,
            config=_config(field),
        )
    )
    event = BoardEvent(
        board_id=board.id,
        author_id=administrator.id,
        title="Inspection",
        all_day=True,
        start_date=date(2026, 9, 24),
        end_date=date(2026, 9, 24),
        timezone_name="Asia/Manila",
    )
    content = b"source board bytes"
    file = File(
        purpose="board_attachment",
        board_id=board.id,
        record_id=None,
        creator_id=administrator.id,
        filename="plan.pdf",
        expected_size=len(content),
        actual_size=len(content),
        digest=sha256(content).hexdigest(),
        object_key=uuid4().hex,
        media_type="application/pdf",
        state="ready",
    )
    db.add_all((event, file))
    db.flush()
    db.add(BoardAttachment(board_id=board.id, file_id=file.id, event_id=event.id))
    db.commit()
    set_audit_actor(db, administrator.id)
    api = client(db, administrator, router)

    duplicated = api.post(f"/api/boards/{board.id}/duplicate")
    exported = api.get(f"/api/boards/{board.id}/configuration")
    imported = _upload(api, exported.json())

    assert duplicated.status_code == 201 and imported.status_code == 201, imported.text
    for copy_id in (UUID(duplicated.json()["id"]), UUID(imported.json()["id"])):
        for model in (File, BoardAttachment, BoardEvent):
            count = select(func.count()).select_from(model).where(model.board_id == copy_id)
            assert db.scalar(count) == 0, model.__name__
        assert (
            db.scalar(
                select(func.count()).select_from(BoardWidget).where(BoardWidget.board_id == copy_id)
            )
            == 1
        )
    assert db.scalar(select(func.count()).select_from(File).where(File.board_id == board.id)) == 1
