import json
from secrets import token_urlsafe

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.config import get_settings
from app.core.database import get_db
from app.main import create_app
from app.systems.access.users.models import User, UserRole

from .support import _make_event, _payload_values, _SecurityEventDatabase, _user

SERVER_KEY = token_urlsafe(32)
WRONG_SERVER_KEY = token_urlsafe(32)
REJECTED_TOKEN = token_urlsafe(32)


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    monkeypatch.setenv("OPENSLATE_ENV_SOURCE", "process")
    monkeypatch.setenv("SECURITY_EVENT_SERVER_KEY", SERVER_KEY)
    get_settings.cache_clear()
    application = create_app()
    yield application
    application.dependency_overrides.clear()
    get_settings.cache_clear()


def _configure_api(
    application: FastAPI,
    *,
    user: User | None = None,
    database: _SecurityEventDatabase | None = None,
) -> TestClient:
    if user is not None:
        application.dependency_overrides[get_current_user] = lambda: user
    if database is not None:
        application.dependency_overrides[get_db] = lambda: database
    return TestClient(application)


def test_exact_admin_can_list_detail_and_bounded_export(api: FastAPI) -> None:
    event = _make_event()
    database = _SecurityEventDatabase([event])
    client = _configure_api(api, user=_user(UserRole.ADMIN), database=database)

    listing = client.get("/api/security-events")
    detail = client.get(f"/api/security-events/{event.id}")
    export = client.get("/api/security-events/export?limit=100")

    assert listing.status_code == 200
    assert listing.json()["items"][0]["event_type"] == event.event_type
    assert detail.status_code == 200
    assert detail.json()["operation_id"] == str(event.operation_id)
    assert export.status_code == 200
    assert len(export.json()) <= 100
    assert "password" not in json.dumps(export.json()).lower()


@pytest.mark.parametrize(
    "path",
    [
        "/api/security-events",
        "/api/security-events/export",
        f"/api/security-events/{uuid7()}",
    ],
)
def test_non_admin_cannot_list_detail_or_export_security_events(api: FastAPI, path: str) -> None:
    client = _configure_api(
        api,
        user=_user("operator"),
        database=_SecurityEventDatabase([]),
    )

    response = client.get(path)

    assert response.status_code == 403


def test_security_event_export_rejects_unbounded_limit_for_admin(api: FastAPI) -> None:
    client = _configure_api(
        api,
        user=_user(UserRole.ADMIN),
        database=_SecurityEventDatabase([]),
    )

    response = client.get("/api/security-events/export?limit=101")

    assert response.status_code == 422


@pytest.mark.parametrize(
    "headers",
    [{}, {"X-OpenSlate-Server-Key": WRONG_SERVER_KEY}],
    ids=["missing-key", "wrong-key"],
)
def test_internal_security_event_ingestion_rejects_missing_or_wrong_server_key(
    api: FastAPI, headers: dict[str, str]
) -> None:
    database = _SecurityEventDatabase([])
    client = _configure_api(api, database=database)

    response = client.post(
        "/api/internal/security-events",
        headers=headers,
        json=_payload_values(),
    )

    assert response.status_code == 401
    assert database.events == []


def test_internal_security_event_ingestion_accepts_configured_key_and_valid_payload(
    api: FastAPI,
) -> None:
    database = _SecurityEventDatabase([])
    client = _configure_api(api, database=database)

    response = client.post(
        "/api/internal/security-events",
        headers={"X-OpenSlate-Server-Key": SERVER_KEY},
        json=_payload_values(),
    )

    assert response.status_code == 201
    assert len(database.events) == 1
    assert database.committed is True
    assert response.json()["event_type"] == "auth.login"
    assert "password" not in json.dumps(response.json()).lower()


def test_internal_security_event_ingestion_validates_before_persisting(api: FastAPI) -> None:
    database = _SecurityEventDatabase([])
    client = _configure_api(api, database=database)

    response = client.post(
        "/api/internal/security-events",
        headers={"X-OpenSlate-Server-Key": SERVER_KEY},
        json=_payload_values(outcome="not-an-outcome", token=REJECTED_TOKEN),
    )

    assert response.status_code == 422
    assert database.events == []
    assert database.committed is False
