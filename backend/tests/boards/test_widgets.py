"""Board tiles: every reader sees them; only managers add, change, order and remove them."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.boards.models import Board, BoardWidget
from app.systems.boards.widget_router import router
from app.systems.boards.widget_schemas import BoardWidgetSpec
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.boards.support import grant, member, project_board
from tests.charts.widget_reference_support import client
from tests.rbac.support import add_department, add_module, make_group_access


def _widget(module_id: UUID, field_id: UUID) -> dict[str, object]:
    return {
        "name": "Requests",
        "widget_type": "records",
        "module_id": str(module_id),
        "config": {
            "fields": [{"field_id": str(field_id), "expected_type": "text"}],
            "filters": [],
            "metric": None,
        },
    }


def test_widget_schema_rejects_untyped_sources_audiences_and_repeated_fields() -> None:
    module_id, field_id = uuid7(), uuid7()
    invalid = _widget(module_id, field_id)
    invalid["config"]["fields"][0]["field_id"] = "display-name"  # type: ignore[index]
    with pytest.raises(ValidationError):
        BoardWidgetSpec.model_validate(invalid)
    with pytest.raises(ValidationError):
        BoardWidgetSpec.model_validate({**_widget(module_id, field_id), "audience": {}})
    repeated = _widget(module_id, field_id)
    repeated["config"]["fields"] *= 2  # type: ignore[index]
    with pytest.raises(ValidationError):
        BoardWidgetSpec.model_validate(repeated)


def _source(db: Session, *readers) -> tuple[Module, Field]:
    department = add_department(db)
    module = add_module(db, department, "Requests")
    make_group_access(db, readers, department)
    field = Field(module_id=module.id, name="Label", type=FieldType.TEXT, position=0)
    db.add(field)
    db.flush()
    return module, field


@pytest.mark.integration
def test_managers_change_tiles_that_every_reader_sees(integration_owner_db: Session) -> None:
    db = integration_owner_db
    manager, writer, reader, outsider = member(db), member(db), member(db), member(db)
    board = project_board(db)
    grant(db, board, [manager], AccessLevel.MANAGE)
    grant(db, board, [writer], AccessLevel.WRITE)
    grant(db, board, [reader], AccessLevel.READ)
    module, field = _source(db, manager, writer, reader)
    db.commit()
    set_audit_actor(db, manager.id)
    root = f"/api/boards/{board.id}/widgets"
    managers, writers, readers = (
        client(db, manager, router),
        client(db, writer, router),
        client(db, reader, router),
    )

    assert client(db, outsider, router).get(root).status_code == 404
    body = {"revision": 1, "widget": _widget(module.id, field.id)}
    assert writers.post(root, json=body).status_code == 403
    assert readers.post(root, json=body).status_code == 403
    created = managers.post(root, json=body)
    assert created.status_code == 201
    widget_id = created.json()["widget"]["id"]
    assert created.json()["board_revision"] == 2
    assert created.headers["Location"] == f"{root}/{widget_id}"
    assert "audience" not in created.json()["widget"]
    assert [item["id"] for item in readers.get(root).json()["items"]] == [widget_id]

    changed_spec = _widget(module.id, field.id)
    changed_spec["name"] = "Updated requests"
    changed_spec["pinned"] = True
    assert (
        writers.patch(
            f"{root}/{widget_id}", json={"revision": 2, "widget": changed_spec}
        ).status_code
        == 403
    )
    changed = managers.patch(f"{root}/{widget_id}", json={"revision": 2, "widget": changed_spec})
    assert changed.status_code == 200
    assert readers.get(root).json()["items"][0]["name"] == "Updated requests"
    stale = managers.post(root, json={"revision": 2, "widget": _widget(module.id, field.id)})
    assert stale.json()["detail"]["code"] == "stale_revision"

    copied = managers.post(f"{root}/{widget_id}/duplicate", json={"revision": 3})
    assert copied.status_code == 201
    copy_id = copied.json()["widget"]["id"]
    assert copied.json()["widget"]["position"] == 1
    ordered = managers.put(
        f"{root}/order", json={"revision": 4, "widget_ids": [copy_id, widget_id]}
    )
    assert ordered.status_code == 200
    assert [item["id"] for item in ordered.json()["items"]] == [copy_id, widget_id]
    assert writers.delete(f"{root}/{copy_id}?revision=5").status_code == 403
    deleted = managers.delete(f"{root}/{copy_id}?revision=5")
    assert deleted.status_code == 204
    assert db.get(BoardWidget, UUID(copy_id)) is None
    assert db.get(Board, board.id).revision == 6
    audit = db.scalars(
        select(AuditLog).where(
            AuditLog.entity_type == "board_widgets", AuditLog.entity_id == UUID(copy_id)
        )
    ).all()
    assert {row.action for row in audit} == {
        AuditAction.CREATE,
        AuditAction.UPDATE,
        AuditAction.DELETE,
    }


@pytest.mark.integration
@pytest.mark.parametrize("operation", ("create", "update", "duplicate"))
def test_widget_writes_omit_refresh_and_preserve_the_live_response(
    integration_owner_db: Session, operation: str
) -> None:
    db = integration_owner_db
    manager = member(db)
    board = project_board(db)
    grant(db, board, [manager], AccessLevel.MANAGE)
    module, field = _source(db, manager)
    legacy_config = {
        **_widget(module.id, field.id)["config"],
        "refresh": "five-minutes",
    }
    source = BoardWidget(
        board_id=board.id,
        position=0,
        name="Legacy requests",
        widget_type="records",
        module_id=module.id,
        config=legacy_config,
    )
    db.add(source)
    db.commit()
    source_id = source.id
    set_audit_actor(db, manager.id)
    api = client(db, manager, router)
    root = f"/api/boards/{board.id}/widgets"
    payload = {"revision": board.revision, "widget": _widget(module.id, field.id)}
    if operation == "create":
        response = api.post(root, json=payload)
    elif operation == "update":
        payload["widget"]["config"]["refresh"] = "one-minute"
        response = api.patch(f"{root}/{source_id}", json=payload)
    else:
        response = api.post(f"{root}/{source_id}/duplicate", json={"revision": board.revision})
    assert response.status_code == (200 if operation == "update" else 201), response.text
    returned = response.json()["widget"]
    stored = db.get(BoardWidget, UUID(returned["id"]))
    assert stored is not None
    db.refresh(stored)
    assert "refresh" not in stored.config
    assert stored.config["fields"] == [{"field_id": str(field.id), "expected_type": "text"}]
    assert returned["config"]["refresh"] == "manual"
    if operation != "update":
        db.refresh(source)
        assert source.config == legacy_config
    shown = api.get(root)
    assert shown.status_code == 200
    assert (
        next(item for item in shown.json()["items"] if item["id"] == returned["id"])["config"][
            "refresh"
        ]
        == "manual"
    )


@pytest.mark.integration
def test_board_widgets_reject_invalid_sources_archives_and_limit(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager = member(db)
    board = project_board(db)
    grant(db, board, [manager], AccessLevel.MANAGE)
    module, field = _source(db, manager)
    department = db.get(Department, module.department_id)
    assert department is not None
    other = add_module(db, department, "Other")
    db.commit()
    set_audit_actor(db, manager.id)
    api = client(db, manager, router)
    root = f"/api/boards/{board.id}/widgets"

    wrong_module = api.post(root, json={"revision": 1, "widget": _widget(other.id, field.id)})
    assert wrong_module.status_code == 409
    assert wrong_module.json()["detail"]["code"] == "widget_invalid"
    assert db.get(Board, board.id).revision == 1
    field.is_deleted = True
    db.commit()
    removed_field = api.post(root, json={"revision": 1, "widget": _widget(module.id, field.id)})
    assert removed_field.status_code == 409
    field.is_deleted = False
    db.commit()
    module.is_deleted = True
    module.deleted_at = datetime.now(UTC)
    db.commit()
    closed_module = api.post(root, json={"revision": 1, "widget": _widget(module.id, field.id)})
    assert closed_module.status_code == 409
    module.is_deleted = False
    module.deleted_at = None
    db.commit()

    for revision in range(1, 13):
        created = api.post(
            root, json={"revision": revision, "widget": _widget(module.id, field.id)}
        )
        assert created.status_code == 201
    full = api.post(root, json={"revision": 13, "widget": _widget(module.id, field.id)})
    assert full.status_code == 409
    assert full.json()["detail"]["code"] == "widget_limit"
    board.status = "archived"
    db.commit()
    archived = api.delete(f"{root}/{api.get(root).json()['items'][0]['id']}?revision=13")
    assert archived.status_code == 409
    assert archived.json()["detail"]["code"] == "board_archived"
