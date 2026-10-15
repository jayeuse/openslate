"""Published identity projection through the real Sandbox read route and PostgreSQL."""

import pytest
from fastapi import FastAPI
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.sandbox.designs.router import router
from app.systems.sandbox.designs.schemas import ModuleDocument, SetFieldAction
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.publications.models import SandboxBinding
from tests.rbac.support import _client, add_user, organization
from tests.sandbox_designs.fixtures import create_document, sample_document
from tests.sandbox_publications.support import binding, bound_field, publish_structure

pytestmark = pytest.mark.integration


def test_bindings_project_current_design_ids_and_actual_live_state(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    create_document(db, organization(db))
    reader = add_user(db, role="admin")
    db.commit()
    application = FastAPI()
    application.include_router(router, prefix="/api")
    client = _client(application, reader, db)
    initial = client.get("/api/sandbox/bindings")
    assert initial.status_code == 200
    assert initial.json() == {"document_revision": read_document(db).revision, "items": []}

    document = sample_document()
    document.triggers[0].actions = [
        SetFieldAction.model_validate(
            {
                "id": "set-priority",
                "kind": "set-field",
                "target": {
                    "moduleId": "sample-requests",
                    "fieldId": "sample-field-requests-priority",
                },
                "value": {"kind": "literal", "value": "Normal"},
            }
        )
    ]
    long_module_id, repeated_field_id = "module-" + "m" * 600, "field-" + "f" * 600
    for module_id in (long_module_id, "second-module"):
        field = (
            document.design.modules[0]
            .fields[0]
            .model_copy(update={"id": repeated_field_id, "required": False}, deep=True)
        )
        document.design.modules.append(
            ModuleDocument(
                id=module_id,
                departmentId=document.design.departments[0].id,
                name="Identity projection " + ("one" if module_id == long_module_id else "two"),
                fields=[field],
            )
        )
        document.design.layout[module_id] = document.design.layout["sample-requests"].model_copy(
            deep=True
        )
    publisher, _ = publish_structure(db, document)
    first_binding = binding(db, "field", f"{long_module_id}:{repeated_field_id}")
    assert first_binding.sandbox_id.startswith("field:hash:")
    first_field = bound_field(db, "field", f"{long_module_id}:{repeated_field_id}")
    second_field = bound_field(db, "field", f"second-module:{repeated_field_id}")
    first_field.is_deleted = True
    first_field.deleted_at = utc_now()
    db.commit()

    response = client.get("/api/sandbox/bindings")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["document_revision"] == read_document(db).revision
    assert {item["kind"] for item in body["items"]} == {
        "department",
        "module",
        "field",
        "relationship",
        "trigger",
    }
    repeated = [item for item in body["items"] if item["sandbox_id"] == repeated_field_id]
    assert {
        item["parent_sandbox_id"]: (item["live_id"], item["is_deleted"]) for item in repeated
    } == {
        long_module_id: (str(first_field.id), True),
        "second-module": (str(second_field.id), False),
    }
    assert all(
        item["parent_sandbox_id"] is None for item in body["items"] if item["kind"] != "field"
    )
    order = [
        (item["kind"], item["parent_sandbox_id"] or "", item["sandbox_id"])
        for item in body["items"]
    ]
    assert order == sorted(order)

    # Publication still recognizes active older keys for this same design.
    legacy = binding(db, "field", f"second-module:{repeated_field_id}")
    canonical_second_key = legacy.sandbox_id
    legacy.sandbox_id = f"second-module:{repeated_field_id}"
    db.commit()
    older = client.get("/api/sandbox/bindings")
    assert older.status_code == 200
    assert {
        item["parent_sandbox_id"]: item["live_id"]
        for item in older.json()["items"]
        if item["sandbox_id"] == repeated_field_id
    } == {long_module_id: str(first_field.id), "second-module": str(second_field.id)}

    # The designer must not see historical bindings as still published draft entries.
    current = read_document(db)
    current.document.design.modules = [
        item for item in current.document.design.modules if item.id != long_module_id
    ]
    current.document.design.layout.pop(long_module_id)
    replace_document(
        db, actor_id=publisher.id, expected_revision=current.revision, document=current.document
    )
    inactive = binding(db, "field", f"second-module:{repeated_field_id}")
    inactive.is_deleted = True
    inactive.deleted_at = utc_now()
    db.commit()
    latest = client.get("/api/sandbox/bindings")
    assert latest.status_code == 200
    assert latest.json()["document_revision"] == current.revision + 1
    assert not any(
        item["sandbox_id"] in {long_module_id, repeated_field_id} for item in latest.json()["items"]
    )
    assert db.get(type(first_field), first_field.id) is not None

    # Two stored identities for the same document field must never be guessed.
    inactive.is_deleted = False
    inactive.deleted_at = None
    conflicting = Field(
        org_id=second_field.org_id,
        module_id=second_field.module_id,
        name="Conflicting binding target",
        type=second_field.type,
        required=False,
        position=100,
        config=second_field.config,
    )
    db.add(conflicting)
    db.flush()
    db.add(SandboxBinding(org_id=second_field.org_id, kind="field",
                         sandbox_id=canonical_second_key, field_id=conflicting.id))
    db.commit()
    conflict = client.get("/api/sandbox/bindings")
    assert conflict.status_code == 503
    assert conflict.json()["detail"]["code"] == "bindings_unavailable"
    application.dependency_overrides.clear()
