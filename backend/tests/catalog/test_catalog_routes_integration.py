"""Registered record routes retain state on rejected changes."""

from collections.abc import Iterator
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from uuid6 import uuid7

from app.core.database import get_db
from app.core.database.session import AuditSession
from app.systems.sandbox.fields.models import Field, FieldType
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
    app.include_router(records_router, prefix="/api")
    override_catalog_authorization(app, integration_db)
    app.dependency_overrides[get_db] = lambda: integration_db
    _set_request(integration_db, uuid7(), "/api/catalog-contract")
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def test_record_delete_restore_and_invalid_restore_preserve_stored_state(
    catalog_client: TestClient, integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(
        owned_ids, fields=(("Title", FieldType.TEXT, 0, True, {}),)
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
    field = integration_db.get(Field, field_id)
    assert field is not None
    field.config = {"minLength": 10}
    integration_db.commit()
    rejected = catalog_client.post(f"{path}/restore")
    assert rejected.status_code == 422, rejected.text
    integration_db.expire_all()
    record = integration_db.get(Record, record_id)
    assert record is not None and record.is_deleted and record.data == {str(field_id): "kept"}
