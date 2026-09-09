import json
import os
from collections.abc import Mapping
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import bindparam, create_engine, select, text
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.audit.models import AuditLog
from scripts import seed_sample_data as seed
from tests.api_integration_support import create_owned_admin, delete_owned_admin
from tests.conftest import _assert_alembic_head, _guard_integration_database

pytestmark = pytest.mark.integration


class AppApiClient:
    """Run each seed request through create_app with a fresh expiring session."""

    def __init__(self, database_url: str, actor) -> None:
        self.engine = create_engine(database_url)
        self.app = create_app()
        self.client = TestClient(self.app)
        self.actor = actor
        self.request_ids: set[UUID] = set()
        self.calls: list[dict[str, Any]] = []
        self.accepted_module_ids: set[UUID] = set()
        self.created: dict[str, set[UUID]] = {
            "roles": set(),
            "departments": set(),
            "modules": set(),
            "fields": set(),
            "records": set(),
        }

    def close(self) -> None:
        self.client.close()
        self.engine.dispose()

    def request(
        self,
        method: str,
        path: str,
        payload: Mapping[str, Any] | None = None,
        query: Mapping[str, str | int] | None = None,
    ) -> dict[str, Any] | None:
        database = AuditSession(bind=self.engine)
        request_id = uuid7()
        self.request_ids.add(request_id)
        database.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=self.actor.id,
            request_id=request_id,
            request_method=method,
            request_path=path,
        )
        self.app.dependency_overrides[get_db] = lambda: database
        self.app.dependency_overrides[get_current_user] = lambda: self.actor
        try:
            response = self.client.request(
                method,
                path,
                json=dict(payload) if payload is not None else None,
                params=dict(query) if query is not None else None,
            )
            self.calls.append({"method": method, "path": path, "payload": payload})
            if response.status_code >= 400:
                raise AssertionError(f"{method} {path}: {response.status_code} {response.text}")
            body = response.json() if response.content else None
            if body and path.startswith("/api/"):
                collection = path.split("/")[2]
                if method == "POST" and path.endswith("/schema/accept"):
                    self.accepted_module_ids.add(UUID(path.split("/")[-3]))
                if method == "POST" and collection in self.created and "id" in body:
                    self.created[collection].add(UUID(str(body["id"])))
            return body
        finally:
            database.close()


def _restore_admin_role(
    owner_url: str,
    role_id: UUID,
    permissions: dict[str, Any],
    updated_at,
    performed_by: UUID | None,
) -> None:
    engine = create_engine(owner_url)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE public.roles SET permissions = CAST(:permissions AS jsonb), "
                    "updated_at = :updated_at, performed_by = :performed_by "
                    "WHERE id = :id"
                ),
                {
                    "permissions": json.dumps(permissions),
                    "updated_at": updated_at,
                    "performed_by": performed_by,
                    "id": role_id,
                },
            )
            restored = connection.execute(
                text(
                    "SELECT permissions, updated_at, performed_by FROM public.roles WHERE id = :id"
                ),
                {"id": role_id},
            ).one()
            assert tuple(restored) == (permissions, updated_at, performed_by)
    finally:
        engine.dispose()


def _cleanup_seed_rows(
    owner_url: str,
    created: dict[str, set[UUID]],
    request_ids: set[UUID],
) -> None:
    engine = create_engine(owner_url)
    try:
        with engine.begin() as connection:
            entity_ids = set().union(*created.values())
            if entity_ids or request_ids:
                predicates = []
                params: dict[str, object] = {"entity_ids": [], "request_ids": []}
                if entity_ids:
                    predicates.append("entity_id IN :entity_ids")
                    params["entity_ids"] = list(entity_ids)
                if request_ids:
                    predicates.append("request_id IN :request_ids")
                    params["request_ids"] = list(request_ids)
                connection.execute(
                    text(
                        "DELETE FROM public.audit_logs WHERE " + " OR ".join(predicates)
                    ).bindparams(
                        bindparam("entity_ids", expanding=True),
                        bindparam("request_ids", expanding=True),
                    ),
                    params,
                )
            for table in ("records", "fields", "modules", "departments", "roles"):
                ids = created[table]
                if ids:
                    connection.execute(
                        text(f"DELETE FROM public.{table} WHERE id IN :ids").bindparams(
                            bindparam("ids", expanding=True)
                        ),
                        {"ids": list(ids)},
                    )
    finally:
        engine.dispose()


def test_seed_main_runs_registered_api_with_real_transactions_and_cleanup(monkeypatch) -> None:
    database_url = os.getenv("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("Set TEST_DATABASE_URL to run PostgreSQL integration tests")
    owner_url = os.getenv("MIGRATION_DATABASE_URL")
    if not owner_url:
        pytest.skip("MIGRATION_DATABASE_URL is required for API seed cleanup")
    _guard_integration_database(database_url)
    _guard_integration_database(owner_url)
    readiness_engine = create_engine(database_url)
    try:
        with readiness_engine.connect() as connection:
            _assert_alembic_head(connection)
            assert connection.scalar(text("SELECT current_user")) == "openslate_runtime"
    finally:
        readiness_engine.dispose()
    actor = create_owned_admin(database_url, owner_url, "seed-api")
    client: AppApiClient | None = None
    original_admin_permissions = dict(actor.role.permissions)
    original_role_updated_at = actor.role.updated_at
    original_role_performed_by = actor.role.performed_by
    try:
        client = AppApiClient(database_url, actor)
        assert client is not None
        namespace = uuid7().hex
        monkeypatch.setattr(
            seed,
            "DEPARTMENT_SPECS",
            {key: f"{namespace} {name}" for key, name in seed.DEPARTMENT_SPECS.items()},
        )
        monkeypatch.setattr(seed, "ApiClient", lambda _base_url, token: client)
        seed.main(["--access-token", "test-token"])

        assert not any(call["path"] == "/api/users" for call in client.calls)
        assert client.created["departments"]
        assert client.created["modules"]
        assert client.created["fields"]
        assert client.created["records"]

        with client.engine.connect() as connection:
            persisted_records = (
                connection.execute(
                    text(
                        "SELECT id, data FROM public.records WHERE id IN :ids ORDER BY id"
                    ).bindparams(bindparam("ids", expanding=True)),
                    {"ids": list(client.created["records"])},
                )
                .mappings()
                .all()
            )
            assert len(persisted_records) == len(client.created["records"])
            module_states = connection.execute(
                text(
                    "SELECT id, is_schema_accepted FROM public.modules WHERE id IN :ids"
                ).bindparams(bindparam("ids", expanding=True)),
                {"ids": list(client.created["modules"])},
            ).all()
            assert len(module_states) == len(client.created["modules"])
            assert {
                module_id for module_id, accepted in module_states if accepted
            } == client.accepted_module_ids
            audit_count = connection.scalar(
                select(AuditLog.id)
                .where(AuditLog.entity_id.in_(client.created["records"]))
                .limit(1)
            )
            assert audit_count is not None
    finally:
        if client is None:
            delete_owned_admin(owner_url, actor.id)
        else:
            try:
                _restore_admin_role(
                    owner_url,
                    actor.role.id,
                    original_admin_permissions,
                    original_role_updated_at,
                    original_role_performed_by,
                )
            finally:
                try:
                    client.close()
                finally:
                    try:
                        _cleanup_seed_rows(owner_url, client.created, client.request_ids)
                    finally:
                        delete_owned_admin(owner_url, actor.id)
