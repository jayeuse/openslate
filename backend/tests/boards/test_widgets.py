"""Board widget configuration, audience, and mutation boundaries."""

from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import Role, User
from app.systems.boards.models import Board, BoardGrant, BoardWidget
from app.systems.boards.widget_router import router
from app.systems.boards.widget_schemas import BoardWidgetSpec
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module


def _widget(module_id: UUID, field_id: UUID, *, audience: dict | None = None) -> dict:
    return {
        "name": "Requests",
        "widget_type": "records",
        "module_id": str(module_id),
        "audience": audience or {"kind": "everyone"},
        "config": {
            "fields": [{"field_id": str(field_id), "expected_type": "text"}],
            "filters": [],
            "metric": None,
        },
    }


def test_widget_schema_rejects_untyped_or_unresolved_source_and_audience() -> None:
    module_id, field_id = uuid7(), uuid7()
    invalid = _widget(module_id, field_id)
    invalid["config"]["fields"][0]["field_id"] = "display-name"
    with pytest.raises(ValidationError):
        BoardWidgetSpec.model_validate(invalid)

    unresolved = _widget(module_id, field_id, audience={"kind": "role"})
    with pytest.raises(ValidationError):
        BoardWidgetSpec.model_validate(unresolved)

    repeated = _widget(module_id, field_id)
    repeated["config"]["fields"] *= 2
    with pytest.raises(ValidationError):
        BoardWidgetSpec.model_validate(repeated)


def _actor(db: Session, capabilities: dict[str, bool]) -> User:
    role = Role(role=f"board-widget-{uuid7().hex}", permissions=capabilities)
    db.add(role)
    db.flush()
    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"widget-{user_id.hex}@example.test",
        username=f"widget_{user_id.hex[:12]}",
        status="active",
        role_id=role.id,
        role=role,
    )
    db.add(user)
    db.flush()
    return user


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


@pytest.mark.integration
def test_board_widgets_persist_order_duplicate_delete_with_board_acl_and_audience(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, {"records.read": True, "records.write": True})
    editor = _actor(db, {"records.read": True, "records.write": True})
    viewer = _actor(db, {"records.read": True})
    outsider = _actor(db, {"records.read": True, "records.write": True})
    department = Department(department_name=f"Widget test {uuid7()}")
    db.add(department)
    db.flush()
    module = Module(department_id=department.id, module_name="Requests", is_schema_accepted=True)
    board = Board(owner_id=owner.id, name="Operations")
    db.add_all([module, board])
    db.flush()
    field = Field(module_id=module.id, name="Label", type=FieldType.TEXT, position=0)
    db.add(field)
    for actor, permission in ((editor, "manage"), (viewer, "view")):
        db.add(
            BoardGrant(
                board_id=board.id,
                principal_type="user",
                principal_user_id=actor.id,
                permission=permission,
                effect="allow",
            )
        )
    db.commit()
    set_audit_actor(db, owner.id)
    root = f"/api/boards/{board.id}/widgets"
    owners = _client(db, owner)
    editors = _client(db, editor)
    viewers = _client(db, viewer)
    outsiders = _client(db, outsider)

    assert outsiders.get(root).status_code == 404
    assert (
        outsiders.post(
            root, json={"revision": 1, "widget": _widget(module.id, field.id)}
        ).status_code
        == 404
    )
    assert (
        viewers.post(root, json={"revision": 1, "widget": _widget(module.id, field.id)}).status_code
        == 403
    )

    private = owners.post(
        root,
        json={"revision": 1, "widget": _widget(module.id, field.id, audience={"kind": "private"})},
    )
    assert private.status_code == 201
    private_id = private.json()["widget"]["id"]
    assert private.json()["board_revision"] == 2
    assert private.headers["Location"] == f"{root}/{private_id}"
    owner_list = owners.get(f"{root}?limit=1&offset=0").json()
    assert [item["id"] for item in owner_list["items"]] == [private_id]
    assert owner_list["pagination"]["total"] == 1
    editor_list = editors.get(f"{root}?limit=1&offset=0").json()
    assert editor_list["items"] == []
    assert editor_list["pagination"]["total"] == 0
    viewer_list = viewers.get(f"{root}?limit=1&offset=0").json()
    assert viewer_list["items"] == []
    assert viewer_list["pagination"]["total"] == 0
    assert (
        editors.patch(
            f"{root}/{private_id}",
            json={"revision": 2, "widget": _widget(module.id, field.id)},
        ).status_code
        == 404
    )

    public = editors.post(root, json={"revision": 2, "widget": _widget(module.id, field.id)})
    assert public.status_code == 201
    public_id = public.json()["widget"]["id"]
    assert [item["id"] for item in viewers.get(root).json()["items"]] == [public_id]
    changed_spec = _widget(module.id, field.id)
    changed_spec["name"] = "Updated requests"
    changed_spec["config"]["pinned"] = True
    changed = editors.patch(
        f"{root}/{public_id}", json={"revision": 3, "widget": changed_spec}
    )
    assert changed.status_code == 200
    assert changed.json()["widget"]["name"] == "Updated requests"
    assert changed.json()["widget"]["config"]["pinned"] is True
    assert viewers.get(root).json()["items"][0]["name"] == "Updated requests"
    stale = editors.post(root, json={"revision": 2, "widget": _widget(module.id, field.id)})
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "stale_revision"

    copied = editors.post(f"{root}/{public_id}/duplicate", json={"revision": 4})
    assert copied.status_code == 201
    copy_id = copied.json()["widget"]["id"]
    assert copy_id != public_id
    assert copied.json()["widget"]["position"] == 2
    ordered = editors.put(f"{root}/order", json={"revision": 5, "widget_ids": [copy_id, public_id]})
    assert ordered.status_code == 200
    assert [(item["id"], item["position"]) for item in ordered.json()["items"]] == [
        (copy_id, 1),
        (public_id, 2),
    ]
    assert owners.get(root).json()["board_revision"] == 6
    deleted = editors.delete(f"{root}/{copy_id}?revision=6")
    assert deleted.status_code == 204
    assert db.get(BoardWidget, UUID(copy_id)) is None
    assert db.get(Board, board.id).revision == 7
    audit = db.scalars(
        select(AuditLog).where(
            AuditLog.entity_type == "board_widgets",
            AuditLog.entity_id == UUID(copy_id),
        )
    ).all()
    assert {row.action for row in audit} == {
        AuditAction.CREATE,
        AuditAction.UPDATE,
        AuditAction.DELETE,
    }


@pytest.mark.integration
def test_board_widgets_reject_invalid_sources_audiences_archives_and_limit(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, {"records.read": True, "records.write": True})
    department = Department(department_name=f"Widget invalid {uuid7()}")
    db.add(department)
    db.flush()
    module = Module(department_id=department.id, module_name="Source", is_schema_accepted=True)
    other = Module(department_id=department.id, module_name="Other", is_schema_accepted=True)
    board = Board(owner_id=owner.id, name="Source validation")
    db.add_all([module, other, board])
    db.flush()
    field = Field(module_id=module.id, name="Label", type=FieldType.TEXT, position=0)
    db.add(field)
    db.commit()
    set_audit_actor(db, owner.id)
    client = _client(db, owner)
    root = f"/api/boards/{board.id}/widgets"

    wrong_module = client.post(root, json={"revision": 1, "widget": _widget(other.id, field.id)})
    assert wrong_module.status_code == 409
    assert wrong_module.json()["detail"]["code"] == "widget_invalid"
    assert db.get(Board, board.id).revision == 1
    unavailable = client.post(
        root,
        json={
            "revision": 1,
            "widget": _widget(
                module.id, field.id, audience={"kind": "user", "user_id": str(uuid7())}
            ),
        },
    )
    assert unavailable.status_code == 409
    assert unavailable.json()["detail"]["code"] == "audience_invalid"
    field.is_deleted = True
    db.commit()
    removed_field = client.post(root, json={"revision": 1, "widget": _widget(module.id, field.id)})
    assert removed_field.status_code == 409
    field.is_deleted = False
    db.commit()
    module.is_schema_accepted = False
    db.commit()
    unaccepted = client.post(root, json={"revision": 1, "widget": _widget(module.id, field.id)})
    assert unaccepted.status_code == 409
    module.is_schema_accepted = True
    db.commit()

    for revision in range(1, 13):
        created = client.post(
            root, json={"revision": revision, "widget": _widget(module.id, field.id)}
        )
        assert created.status_code == 201
    full = client.post(root, json={"revision": 13, "widget": _widget(module.id, field.id)})
    assert full.status_code == 409
    assert full.json()["detail"]["code"] == "widget_limit"
    assert db.get(Board, board.id).revision == 13
    board.status = "archived"
    db.commit()
    archived = client.delete(f"{root}/{client.get(root).json()['items'][0]['id']}?revision=13")
    assert archived.status_code == 409
    assert archived.json()["detail"]["code"] == "board_archived"
