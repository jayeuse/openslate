"""Registered export API evidence against the guarded disposable PostgreSQL stack."""

import os
import re
from collections.abc import Generator
from dataclasses import dataclass
from urllib.parse import urlsplit
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.core.database.session import AuditSession, dispose_database_resources
from app.main import create_app
from app.systems.access.users.models import User
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records import export as export_service
from app.systems.sandbox.records.models import Record
from tests.api_integration_support import create_owned_admin, delete_owned_admin
from tests.conftest import guarded_create_engine as create_engine

pytestmark = pytest.mark.integration


def _disposable_urls() -> tuple[str, str]:
    runtime_url = os.getenv("DATABASE_URL")
    owner_url = os.getenv("MIGRATION_DATABASE_URL")
    run_id = os.getenv("OPENSLATE_FULLSTACK_RUN_ID", "")
    if runtime_url is None or owner_url is None:
        pytest.skip("Disposable runtime and migration database URLs are required")
    if os.getenv("E2E_ALLOW_MUTATIONS") != "true" or re.fullmatch(r"[a-f0-9]{32}", run_id) is None:
        pytest.skip("Explicit disposable mutation authorization is required")
    for database_url in (runtime_url, owner_url):
        target = urlsplit(database_url)
        if (
            target.hostname != "127.0.0.1"
            or target.port != 55322
            or target.path.rstrip("/") != "/postgres"
            or not target.username
            or not target.password
        ):
            raise RuntimeError("Export integration tests require the owned disposable database")
    return runtime_url, owner_url


@dataclass
class _ExportFixture:
    runtime_url: str
    owner_url: str
    actor: User
    department_id: UUID
    module_id: UUID
    field_id: UUID
    record_id: UUID

    @classmethod
    def create(cls) -> "_ExportFixture":
        runtime_url, owner_url = _disposable_urls()
        actor = create_owned_admin(runtime_url, owner_url, "export_event_failure")
        engine = create_engine(owner_url)
        try:
            with AuditSession(engine) as database:
                department = Department(department_name=f"export-event-{uuid7()}")
                database.add(department)
                database.flush()
                module = Module(
                    department_id=department.id,
                    module_name=f"Export event {uuid7()}",
                    is_schema_accepted=True,
                )
                database.add(module)
                database.flush()
                field = Field(
                    module_id=module.id,
                    name="Value",
                    type=FieldType.TEXT,
                    position=0,
                    required=False,
                    config={},
                )
                database.add(field)
                database.flush()
                record = Record(module_id=module.id, data={str(field.id): "exported"})
                database.add(record)
                database.commit()
                return cls(
                    runtime_url,
                    owner_url,
                    actor,
                    department.id,
                    module.id,
                    field.id,
                    record.id,
                )
        except BaseException:
            delete_owned_admin(owner_url, actor.id)
            raise
        finally:
            engine.dispose()

    def payload(self) -> dict[str, object]:
        return {
            "module_id": str(self.module_id),
            "definition": {
                "columns": [{"field_id": str(self.field_id), "expected_type": "text"}]
            },
        }

    def cleanup(self) -> None:
        engine = create_engine(self.owner_url)
        try:
            with engine.begin() as connection:
                for entity_id in (
                    self.record_id,
                    self.field_id,
                    self.module_id,
                    self.department_id,
                ):
                    connection.execute(
                        text("DELETE FROM public.audit_logs WHERE entity_id = :id"),
                        {"id": entity_id},
                    )
                connection.execute(
                    text(
                        "DELETE FROM public.security_events "
                        "WHERE actor_id = :actor_id OR subject_id = :module_id"
                    ),
                    {"actor_id": self.actor.id, "module_id": self.module_id},
                )
                connection.execute(
                    text("DELETE FROM public.records WHERE id = :id"), {"id": self.record_id}
                )
                connection.execute(
                    text("DELETE FROM public.fields WHERE id = :id"), {"id": self.field_id}
                )
                connection.execute(
                    text("DELETE FROM public.modules WHERE id = :id"), {"id": self.module_id}
                )
                connection.execute(
                    text("DELETE FROM public.departments WHERE id = :id"),
                    {"id": self.department_id},
                )
        finally:
            engine.dispose()
            delete_owned_admin(self.owner_url, self.actor.id)


@pytest.fixture
def export_fixture() -> Generator[_ExportFixture, None, None]:
    fixture = _ExportFixture.create()
    try:
        yield fixture
    finally:
        fixture.cleanup()
        dispose_database_resources()


def test_registered_export_fails_closed_when_event_persistence_is_unavailable(
    export_fixture: _ExportFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    application: FastAPI = create_app()
    application.dependency_overrides[get_current_user] = lambda: export_fixture.actor

    def unavailable_event_writer(*_args: object, **_kwargs: object) -> object:
        raise OperationalError("security event unavailable", {}, RuntimeError("unavailable"))

    monkeypatch.setattr(export_service, "append_security_event", unavailable_event_writer)
    try:
        with TestClient(application) as client:
            response = client.post("/api/records/export", json=export_fixture.payload())
    finally:
        application.dependency_overrides.clear()

    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["detail"] == "Unable to record export authorization"
    assert b"Record ID" not in response.content
