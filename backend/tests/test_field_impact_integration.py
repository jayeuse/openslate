"""Registered API and query-boundary tests for field-change impact validation."""

import json
import os
from collections.abc import Generator, Iterator
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.core.middleware.request_context import get_request_context
from app.main import create_app
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.fields.models import FieldType
from app.systems.users.models import UserRole
from tests.conftest import _guard_integration_database
from tests.dynamic_field_support import _database_url, _seed_committed_module

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]
pytest_plugins = ("tests.dynamic_field_support",)


def _runtime_url() -> str:
    url = os.getenv("DATABASE_URL")
    if url is None:
        pytest.skip("Set DATABASE_URL to run runtime-role API integration tests")
    _guard_integration_database(url)
    return url


@pytest.fixture
def field_api_client() -> Iterator[TestClient]:
    """Use a fresh default-expiring runtime-role AuditSession for every request."""

    runtime_engine = create_engine(_runtime_url())
    with runtime_engine.connect() as connection:
        current_user = connection.scalar(text("SELECT current_user"))
        actor_id = connection.scalar(
            text(
                "SELECT id FROM public.users "
                "WHERE status = 'active' AND is_deleted = false ORDER BY id LIMIT 1"
            )
        )
        connection.rollback()
    if current_user != "openslate_runtime":
        runtime_engine.dispose()
        raise RuntimeError(f"DATABASE_URL must connect as openslate_runtime, got {current_user!r}")
    if actor_id is None:
        runtime_engine.dispose()
        pytest.skip("An active local user is required for audit-backed API verification")

    actor = SimpleNamespace(id=actor_id, role=SimpleNamespace(role=UserRole.ADMIN.value))
    application = create_app()
    sessions: list[AuditSession] = []

    def override_user() -> Any:
        return actor

    def override_db(request: Request) -> Generator[Session, None, None]:
        context = get_request_context(request)
        with runtime_engine.connect() as connection:
            database = AuditSession(bind=connection)
            database.info[AUDIT_CONTEXT_KEY] = AuditContext(
                performed_by=actor.id,
                request_id=context.request_id,
                request_method=context.method,
                request_path=context.path,
            )
            sessions.append(database)
            try:
                yield database
            finally:
                database.close()

    application.dependency_overrides[get_current_user] = override_user
    application.dependency_overrides[get_db] = override_db
    try:
        with TestClient(application) as client:
            yield client
    finally:
        application.dependency_overrides.clear()
        for session in sessions:
            session.close()
        runtime_engine.dispose()


def _seed_records(
    owned_ids: set[UUID],
    *,
    module_id: UUID,
    field_id: UUID,
    values: list[Any],
) -> None:
    engine = create_engine(_database_url_for_owner())
    try:
        with engine.begin() as connection:
            for value in values:
                record_id = uuid7()
                connection.execute(
                    text(
                        """
                        INSERT INTO public.records (id, module_id, data)
                        VALUES (:record_id, :module_id, CAST(:data AS jsonb))
                        """
                    ),
                    {
                        "record_id": record_id,
                        "module_id": module_id,
                        "data": json.dumps(
                            {str(field_id): value} if value is not MISSING else {}
                        ),
                    },
                )
                owned_ids.add(record_id)
    finally:
        engine.dispose()


def _database_url_for_owner() -> str:
    return _database_url()


class _MissingValue:
    pass


MISSING = _MissingValue()


def _field_state(field_id: UUID) -> dict[str, Any]:
    engine = create_engine(_database_url_for_owner())
    try:
        with engine.connect() as connection:
            row = connection.execute(
                text(
                    "SELECT required, config FROM public.fields WHERE id = :field_id"
                ),
                {"field_id": field_id},
            ).mappings().one()
            connection.rollback()
            return dict(row)
    finally:
        engine.dispose()


def test_registered_api_accepts_valid_field_change_across_1001_records(
    integration_db: Session,
    owned_ids: set[UUID],
    field_api_client: TestClient,
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=True,
        fields=(("Title", FieldType.TEXT, 0, False, {}),),
    )
    field_id = seeded.fields["Title"]
    _seed_records(
        owned_ids,
        module_id=seeded.module_id,
        field_id=field_id,
        values=["ok"] * 1001,
    )

    response = field_api_client.patch(
        f"/api/fields/{field_id}",
        json={"config": {"minLength": 1}},
    )

    assert response.status_code == 200
    assert response.json()["config"] == {"minLength": 1}
    assert _field_state(field_id) == {"required": False, "config": {"minLength": 1}}


def test_registered_api_rejects_invalid_change_and_preserves_field_across_1001_records(
    integration_db: Session,
    owned_ids: set[UUID],
    field_api_client: TestClient,
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=True,
        fields=(("Title", FieldType.TEXT, 0, False, {}),),
    )
    field_id = seeded.fields["Title"]
    _seed_records(
        owned_ids,
        module_id=seeded.module_id,
        field_id=field_id,
        values=["ok"] * 1001,
    )

    response = field_api_client.patch(
        f"/api/fields/{field_id}",
        json={"config": {"minLength": 3}},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "Field change would invalidate active records"
    assert _field_state(field_id) == {"required": False, "config": {}}


@pytest.mark.parametrize("value", [MISSING, None])
def test_registered_api_rejects_required_change_for_missing_or_null_values(
    value: Any,
    integration_db: Session,
    owned_ids: set[UUID],
    field_api_client: TestClient,
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=True,
        fields=(("Title", FieldType.TEXT, 0, False, {}),),
    )
    field_id = seeded.fields["Title"]
    _seed_records(
        owned_ids,
        module_id=seeded.module_id,
        field_id=field_id,
        values=[value] * 1001,
    )

    response = field_api_client.patch(
        f"/api/fields/{field_id}",
        json={"required": True},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "Field change would invalidate active records"
    assert _field_state(field_id) == {"required": False, "config": {}}
