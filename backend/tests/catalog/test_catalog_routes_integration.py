"""Registered catalog routes retain state on rejected changes."""

from collections.abc import Iterator
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from uuid6 import uuid7

from app.core.database import get_db
from app.core.database.session import AuditSession
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.departments.router import router as departments_router
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.router import module_fields_router
from app.systems.sandbox.fields.router import router as fields_router
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.modules.router import router as modules_router
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.router import router as records_router
from tests.catalog.auth_support import override_catalog_authorization
from tests.catalog.dynamic_field_support import (
    _seed_committed_module,
    _seed_committed_record,
    _set_request,
)

pytestmark = pytest.mark.integration
pytest_plugins = ("tests.catalog.dynamic_field_support",)


@pytest.fixture
def catalog_client(integration_db: AuditSession) -> Iterator[TestClient]:
    app = FastAPI()
    for router in (
        departments_router,
        modules_router,
        fields_router,
        module_fields_router,
        records_router,
    ):
        app.include_router(router, prefix="/api")
    override_catalog_authorization(app)
    app.dependency_overrides[get_db] = lambda: integration_db
    _set_request(integration_db, uuid7(), "/api/catalog-contract")
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def test_catalog_rename_persists_and_duplicate_names_leave_originals(
    catalog_client: TestClient, integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(owned_ids, accepted=False)
    duplicate = _seed_committed_module(owned_ids, accepted=False)
    department = integration_db.get(Department, duplicate.department_id)
    assert department is not None
    for path, key, value in (
        (f"departments/{seeded.department_id}", "department_name", f"Renamed {uuid7()}"),
        (f"modules/{seeded.module_id}", "module_name", "Renamed module"),
    ):
        response = catalog_client.patch(f"/api/{path}", json={key: value})
        assert response.status_code == 200, response.text
        assert catalog_client.get(f"/api/{path}").json()[key] == value
    before = catalog_client.get(f"/api/departments/{seeded.department_id}").json()
    rejected = catalog_client.patch(
        f"/api/departments/{seeded.department_id}",
        json={"department_name": department.department_name},
    )
    assert rejected.status_code == 409
    assert rejected.json()["detail"] == "Department name unavailable"
    assert catalog_client.get(f"/api/departments/{seeded.department_id}").json() == before
    moved = catalog_client.patch(
        f"/api/modules/{seeded.module_id}", json={"department_id": str(duplicate.department_id)}
    )
    assert moved.status_code == 409
    assert moved.json()["detail"] == "Module department cannot be changed"
    integration_db.expire_all()
    assert integration_db.get(Module, seeded.module_id).department_id == seeded.department_id


def test_field_edits_invalidate_schema_and_rejections_preserve_persisted_definition(
    catalog_client: TestClient, integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=True,
        fields=(("Title", FieldType.TEXT, 0, False, {}), ("Other", FieldType.TEXT, 1, False, {})),
    )
    field_id = seeded.fields["Title"]
    path = f"/api/fields/{field_id}"
    for payload, expected_status, detail in (
        ({"name": "Other"}, 409, "Field name unavailable"),
        ({"position": 1}, 409, "Field position unavailable"),
        (
            {"relationship_multiple_targets": True},
            409,
            "Primitive fields cannot have relationship metadata",
        ),
        ({"config": {"minLength": 4, "maxLength": 2}}, 422, "minLength cannot exceed maxLength"),
    ):
        response = catalog_client.patch(path, json=payload)
        assert response.status_code == expected_status, response.text
        assert detail in str(response.json()["detail"])
        integration_db.expire_all()
        field = integration_db.get(Field, field_id)
        assert field is not None and field.name == "Title" and field.position == 0
        assert field.config == {}
        assert integration_db.get(Module, seeded.module_id).is_schema_accepted is True
    edited = catalog_client.patch(
        path, json={"name": "Summary", "required": True, "config": {"maxLength": 20}}
    )
    assert edited.status_code == 200, edited.text
    integration_db.expire_all()
    field = integration_db.get(Field, field_id)
    assert field is not None and field.name == "Summary" and field.required is True
    assert field.config == {"maxLength": 20}
    assert integration_db.get(Module, seeded.module_id).is_schema_accepted is False
    reorder = catalog_client.post(
        f"/api/modules/{seeded.module_id}/fields/reorder", json={"field_ids": [str(field_id)]}
    )
    assert reorder.status_code == 409
    assert reorder.json()["detail"] == "Reorder must include every active module field exactly once"
    assert catalog_client.get(path).json()["position"] == 0


def test_record_delete_restore_and_invalid_restore_preserve_stored_state(
    catalog_client: TestClient, integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(
        owned_ids, accepted=True, fields=(("Title", FieldType.TEXT, 0, True, {}),)
    )
    field_id = seeded.fields["Title"]
    record_id = _seed_committed_record(owned_ids, seeded.module_id, {str(field_id): "kept"})
    path = f"/api/records/{record_id}"
    deleted = catalog_client.delete(path)
    assert deleted.status_code == 204 and deleted.content == b""
    integration_db.expire_all()
    record = integration_db.get(Record, record_id)
    assert record is not None and record.is_deleted and record.deleted_at is not None
    assert catalog_client.delete(path).json()["detail"] == "Record is already deleted"
    assert catalog_client.patch(path, json={"data": {}}).json()["detail"] == "Record is deleted"
    restored = catalog_client.post(f"{path}/restore")
    assert restored.status_code == 200, restored.text
    assert restored.json()["data"] == {str(field_id): "kept"}
    assert restored.json()["is_deleted"] is False and restored.json()["deleted_at"] is None
    repeated = catalog_client.post(f"{path}/restore")
    assert repeated.status_code == 409 and repeated.json()["detail"] == "Record is not deleted"
    assert catalog_client.delete(path).status_code == 204
    # A schema tightened while this record is closed must prevent unsafe restoration.
    assert (
        catalog_client.patch(
            f"/api/fields/{field_id}", json={"config": {"minLength": 10}}
        ).status_code
        == 200
    )
    rejected = catalog_client.post(f"{path}/restore")
    assert rejected.status_code == 422, rejected.text
    integration_db.expire_all()
    record = integration_db.get(Record, record_id)
    assert record is not None and record.is_deleted and record.data == {str(field_id): "kept"}


def test_field_required_change_rejects_existing_record_without_partial_schema_write(
    catalog_client: TestClient, integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(
        owned_ids, accepted=True, fields=(("Title", FieldType.TEXT, 0, False, {}),)
    )
    _seed_committed_record(owned_ids, seeded.module_id, {})
    response = catalog_client.patch(
        f"/api/fields/{seeded.fields['Title']}", json={"required": True, "name": "Required title"}
    )
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "Field change would invalidate active records"
    integration_db.expire_all()
    field = integration_db.get(Field, seeded.fields["Title"])
    assert field is not None and field.required is False and field.name == "Title"
    assert integration_db.get(Module, seeded.module_id).is_schema_accepted is True
    assert (
        integration_db.scalar(select(Record).where(Record.module_id == seeded.module_id)).data == {}
    )
