import os
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import bindparam, create_engine, text
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.lifecycle.exceptions import LifecyclePasswordServiceUnavailable
from tests.api_integration_support import create_owned_admin, delete_owned_admin
from tests.conftest import _assert_alembic_head, _guard_integration_database

pytestmark = pytest.mark.integration


class LifecycleApiClient:
    def __init__(self, database_url: str, actor) -> None:
        self.engine = create_engine(database_url)
        self.app = create_app()
        self.client = TestClient(self.app)
        self.actor = actor
        self.active_database: AuditSession | None = None
        self.request_count = 0
        self.request_ids: set[UUID] = set()
        self.created_department_ids: set[UUID] = set()
        self.created_module_ids: set[UUID] = set()

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None):
        database = AuditSession(bind=self.engine)
        self.request_count += 1
        request_id = uuid7()
        self.request_ids.add(request_id)
        database.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=self.actor.id,
            request_id=request_id,
            request_method=method,
            request_path=path,
        )
        self.active_database = database
        self.app.dependency_overrides[get_current_user] = lambda: self.actor
        self.app.dependency_overrides[get_db] = lambda: database
        try:
            response = self.client.request(method, path, json=payload)
            if response.status_code == 201 and payload is not None:
                body = response.json()
                if path == "/api/departments":
                    self.created_department_ids.add(UUID(body["id"]))
                if path == "/api/modules":
                    self.created_module_ids.add(UUID(body["id"]))
            return response
        finally:
            self.active_database = None
            database.close()

    def close(self) -> None:
        self.client.close()
        self.engine.dispose()


def _cleanup(client: LifecycleApiClient) -> None:
    owner_url = os.getenv("MIGRATION_DATABASE_URL")
    if owner_url is None:
        raise RuntimeError("MIGRATION_DATABASE_URL is required for lifecycle API cleanup")
    _guard_integration_database(owner_url)
    engine = create_engine(owner_url)
    try:
        with engine.begin() as connection:
            entity_ids = client.created_department_ids | client.created_module_ids
            if entity_ids or client.request_ids:
                predicates = []
                params: dict[str, object] = {
                    "entity_ids": list(entity_ids),
                    "request_ids": list(client.request_ids),
                }
                if entity_ids:
                    predicates.append("entity_id IN :entity_ids")
                if client.request_ids:
                    predicates.append("request_id IN :request_ids")
                connection.execute(
                    text(
                        "DELETE FROM public.audit_logs WHERE " + " OR ".join(predicates)
                    ).bindparams(
                        bindparam("entity_ids", expanding=True),
                        bindparam("request_ids", expanding=True),
                    ),
                    params,
                )
            connection.execute(
                text("DELETE FROM public.lifecycle_rate_limit_failures WHERE actor_id = :id"),
                {"id": client.actor.id},
            )
            connection.execute(
                text("DELETE FROM public.lifecycle_confirmation_challenges WHERE actor_id = :id"),
                {"id": client.actor.id},
            )
            connection.execute(
                text("DELETE FROM public.lifecycle_rate_limit_buckets WHERE actor_id = :id"),
                {"id": client.actor.id},
            )
            if client.created_module_ids:
                connection.execute(
                    text("DELETE FROM public.modules WHERE id IN :ids").bindparams(
                        bindparam("ids", expanding=True)
                    ),
                    {"ids": list(client.created_module_ids)},
                )
            if client.created_department_ids:
                connection.execute(
                    text("DELETE FROM public.departments WHERE id IN :ids").bindparams(
                        bindparam("ids", expanding=True)
                    ),
                    {"ids": list(client.created_department_ids)},
                )
    finally:
        engine.dispose()
        delete_owned_admin(owner_url, client.actor.id)


@pytest.fixture
def lifecycle_api_client() -> Callable[[], LifecycleApiClient]:
    database_url = os.getenv("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("Set TEST_DATABASE_URL to run PostgreSQL integration tests")
    owner_url = os.getenv("MIGRATION_DATABASE_URL")
    if not owner_url:
        pytest.skip("MIGRATION_DATABASE_URL is required for lifecycle API cleanup")
    _guard_integration_database(database_url)
    _guard_integration_database(owner_url)
    readiness_engine = create_engine(database_url)
    try:
        with readiness_engine.connect() as connection:
            _assert_alembic_head(connection)
            assert connection.scalar(text("SELECT current_user")) == "openslate_runtime"
    finally:
        readiness_engine.dispose()
    actor = create_owned_admin(database_url, owner_url, "lifecycle-api")
    try:
        client = LifecycleApiClient(database_url, actor)
    except BaseException:
        delete_owned_admin(owner_url, actor.id)
        raise
    try:
        yield lambda: client
    finally:
        try:
            _cleanup(client)
        finally:
            client.close()


def test_registered_close_password_callback_starts_without_request_transaction(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
) -> None:
    client = lifecycle_api_client()
    department = client.request("POST", "/api/departments", {"department_name": "API lifecycle"})
    assert department.status_code == 201
    module = client.request(
        "POST",
        "/api/modules",
        {"department_id": department.json()["id"], "module_name": "Assets"},
    )
    assert module.status_code == 201
    module_id = module.json()["id"]
    preview = client.request("POST", f"/api/modules/{module_id}/close/preview")
    assert preview.status_code == 200
    token = preview.json()["token"]
    observations: list[bool] = []

    class PasswordClient:
        def verify_password(self, _email: str, _password: str) -> UUID:
            assert client.active_database is not None
            observations.append(client.active_database.in_transaction())
            return client.actor.id

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "app.systems.lifecycle.challenge_verification.SupabasePasswordGrantClient",
            PasswordClient,
        )
        closed = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {"token": token, "confirmation_name": "Assets", "password": "secret"},
        )

    assert closed.status_code == 200
    assert observations == [False]


def test_registered_close_rejects_invalid_confirmation_without_provider_call(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
) -> None:
    client = lifecycle_api_client()
    department = client.request("POST", "/api/departments", {"department_name": "API invalid"})
    module = client.request(
        "POST",
        "/api/modules",
        {"department_id": department.json()["id"], "module_name": "Assets"},
    )
    module_id = module.json()["id"]
    preview = client.request("POST", f"/api/modules/{module_id}/close/preview")
    calls: list[str] = []

    class PasswordClient:
        def verify_password(self, _email: str, _password: str) -> UUID:
            calls.append("called")
            return client.actor.id

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "app.systems.lifecycle.challenge_verification.SupabasePasswordGrantClient",
            PasswordClient,
        )
        response = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {
                "token": preview.json()["token"],
                "confirmation_name": "Wrong",
                "password": "secret",
            },
        )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "confirmation_name_mismatch"
    assert calls == []


def test_registered_close_maps_provider_failure_and_consumed_token_replay(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
) -> None:
    client = lifecycle_api_client()
    department = client.request("POST", "/api/departments", {"department_name": "API provider"})
    module = client.request(
        "POST",
        "/api/modules",
        {"department_id": department.json()["id"], "module_name": "Assets"},
    )
    module_id = module.json()["id"]
    preview = client.request("POST", f"/api/modules/{module_id}/close/preview")
    token = preview.json()["token"]

    observations: list[bool] = []

    class FailingPasswordClient:
        def verify_password(self, _email: str, _password: str) -> UUID:
            assert client.active_database is not None
            observations.append(client.active_database.in_transaction())
            raise LifecyclePasswordServiceUnavailable("provider unavailable")

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "app.systems.lifecycle.challenge_verification.SupabasePasswordGrantClient",
            FailingPasswordClient,
        )
        failed = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {"token": token, "confirmation_name": "Assets", "password": "secret"},
        )

    assert failed.status_code == 503
    assert failed.json()["detail"]["code"] == "password_upstream_unavailable"
    assert observations == [False]

    class PasswordClient:
        def verify_password(self, _email: str, _password: str) -> UUID:
            return client.actor.id

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "app.systems.lifecycle.challenge_verification.SupabasePasswordGrantClient",
            PasswordClient,
        )
        closed = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {"token": token, "confirmation_name": "Assets", "password": "secret"},
        )
    assert closed.status_code == 200

    with client.engine.begin() as connection:
        connection.execute(
            text("UPDATE public.modules SET is_deleted = false, deleted_at = NULL WHERE id = :id"),
            {"id": module_id},
        )
    replay = client.request(
        "POST",
        f"/api/modules/{module_id}/close",
        {"token": token, "confirmation_name": "Assets", "password": "secret"},
    )
    assert replay.status_code == 404
    assert replay.json()["detail"]["code"] == "challenge_not_found"


def test_registered_close_rejects_plan_drift_after_provider_success(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
) -> None:
    client = lifecycle_api_client()
    department = client.request("POST", "/api/departments", {"department_name": "API drift"})
    module = client.request(
        "POST",
        "/api/modules",
        {"department_id": department.json()["id"], "module_name": "Assets"},
    )
    module_id = module.json()["id"]
    preview = client.request("POST", f"/api/modules/{module_id}/close/preview")
    token = preview.json()["token"]

    class PasswordClient:
        def verify_password(self, _email: str, _password: str) -> UUID:
            with client.engine.begin() as connection:
                connection.execute(
                    text("UPDATE public.modules SET module_name = :name WHERE id = :id"),
                    {"name": "Assets changed", "id": module_id},
                )
            return client.actor.id

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "app.systems.lifecycle.challenge_verification.SupabasePasswordGrantClient",
            PasswordClient,
        )
        response = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {"token": token, "confirmation_name": "Assets", "password": "secret"},
        )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "impact_changed"
    with client.engine.connect() as connection:
        state = connection.execute(
            text("SELECT is_deleted, module_name FROM public.modules WHERE id = :id"),
            {"id": module_id},
        ).one()
    assert tuple(state) == (False, "Assets changed")


def test_registered_module_purge_succeeds_when_enabled(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
) -> None:
    client = lifecycle_api_client()
    department = client.request("POST", "/api/departments", {"department_name": "API purge"})
    module = client.request(
        "POST",
        "/api/modules",
        {"department_id": department.json()["id"], "module_name": "Assets"},
    )
    module_id = module.json()["id"]
    close_preview = client.request("POST", f"/api/modules/{module_id}/close/preview")
    observations: list[bool] = []

    class PasswordClient:
        def verify_password(self, _email: str, _password: str) -> UUID:
            assert client.active_database is not None
            observations.append(client.active_database.in_transaction())
            return client.actor.id

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "app.systems.lifecycle.router.get_settings",
            lambda: SimpleNamespace(lifecycle_purge_enabled=True),
        )
        monkeypatch.setattr(
            "app.systems.lifecycle.challenge_verification.SupabasePasswordGrantClient",
            PasswordClient,
        )
        closed = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {
                "token": close_preview.json()["token"],
                "confirmation_name": "Assets",
                "password": "secret",
            },
        )
        purge_preview = client.request("POST", f"/api/modules/{module_id}/purge/preview")
        purged = client.request(
            "POST",
            f"/api/modules/{module_id}/purge",
            {
                "token": purge_preview.json()["token"],
                "confirmation_name": "Assets",
                "password": "secret",
            },
        )

    assert closed.status_code == 200
    assert purge_preview.status_code == 200
    assert purged.status_code == 200
    assert observations == [False, False]
    with client.engine.connect() as connection:
        assert (
            connection.scalar(
                text("SELECT id FROM public.modules WHERE id = :id"), {"id": module_id}
            )
            is None
        )


def test_registered_purge_refuses_when_disabled_before_provider(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
) -> None:
    client = lifecycle_api_client()
    department = client.request("POST", "/api/departments", {"department_name": "API purge off"})
    module = client.request(
        "POST",
        "/api/modules",
        {"department_id": department.json()["id"], "module_name": "Assets"},
    )
    calls: list[str] = []

    class PasswordClient:
        def verify_password(self, _email: str, _password: str) -> UUID:
            calls.append("called")
            return client.actor.id

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "app.systems.lifecycle.router.get_settings",
            lambda: SimpleNamespace(lifecycle_purge_enabled=False),
        )
        monkeypatch.setattr(
            "app.systems.lifecycle.challenge_verification.SupabasePasswordGrantClient",
            PasswordClient,
        )
        response = client.request("POST", f"/api/modules/{module.json()['id']}/purge/preview")

    assert response.status_code == 403, response.text
    assert response.json()["detail"]["code"] == "purge_disabled"
    assert calls == []
