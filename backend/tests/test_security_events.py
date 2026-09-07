import json
from datetime import UTC, datetime
from typing import Any
from unittest.mock import Mock
from uuid import UUID, uuid7

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql

import app.systems.audit.listeners as audit_listeners
import app.systems.audit.models as audit_models
import app.systems.audit.schemas as audit_schemas
import app.systems.audit.service as audit_service
from app.common.dependencies.auth import get_current_user
from app.common.listing import StandardListRequest
from app.core.base_model import BaseModel
from app.core.config import get_settings
from app.core.database import get_db, model_registry
from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.users.models import Role, User, UserRole


def _security_event_model() -> type[Any]:
    model = getattr(audit_models, "SecurityEvent", None)
    assert isinstance(model, type), "SecurityEvent ORM model is not implemented"
    return model


def _security_event_outcome() -> Any:
    outcome = getattr(audit_models, "SecurityEventOutcome", None)
    assert outcome is not None, "SecurityEventOutcome is not implemented"
    return outcome


def _security_event_payload() -> type[Any]:
    payload = getattr(audit_schemas, "SecurityEventIngestRequest", None)
    assert isinstance(payload, type), "SecurityEventIngestRequest is not implemented"
    return payload


def _append_security_event() -> Any:
    writer = getattr(audit_service, "append_security_event", None)
    assert callable(writer), "append_security_event is not implemented"
    return writer


def _list_security_events() -> Any:
    lister = getattr(audit_service, "list_security_events", None)
    assert callable(lister), "list_security_events is not implemented"
    return lister


def test_committed_security_event_uses_an_independent_audit_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    writer = getattr(audit_service, "append_committed_security_event", None)
    assert callable(writer), "append_committed_security_event is not implemented"

    independent_session = Mock()
    monkeypatch.setattr(audit_service, "AuditSession", Mock(return_value=independent_session))
    monkeypatch.setattr(audit_service, "get_engine", Mock(return_value=object()))
    payload = _security_event_payload().model_validate(_payload_values())

    writer(payload)

    independent_session.add.assert_called_once()
    independent_session.commit.assert_called_once()


def _payload_values(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "event_type": "auth.login",
        "outcome": "attempt",
        "source": "supabase.auth",
        "operation_id": str(uuid7()),
        "actor_id": str(uuid7()),
        "subject_id": str(uuid7()),
        "labels": {"provider": "oidc"},
        "fingerprint": "sha256:" + "a" * 64,
        "reason": "invalid credentials",
        "request_id": str(uuid7()),
        "request_method": "POST",
        "request_path": "/api/session",
        "metadata": {"provider": "oidc", "attempt": 1},
    }
    values.update(overrides)
    return values


def _make_event(**overrides: object) -> Any:
    model = _security_event_model()
    values: dict[str, object] = {
        "id": uuid7(),
        "occurred_at": datetime.now(UTC),
        "event_type": "auth.login",
        "outcome": "attempt",
        "source": "supabase.auth",
        "operation_id": uuid7(),
        "actor_id": uuid7(),
        "subject_id": uuid7(),
        "labels": {"provider": "oidc"},
        "fingerprint": "sha256:" + "a" * 64,
        "reason": "invalid credentials",
        "request_id": uuid7(),
        "request_method": "POST",
        "request_path": "/api/session",
        # ``metadata`` is reserved by SQLAlchemy's declarative base. The
        # implementation maps this column to the event_metadata attribute.
        "event_metadata": {"provider": "oidc", "attempt": 1},
    }
    values.update(overrides)
    return model(**values)


def _user(role: UserRole | str) -> User:
    role_id = uuid7()
    role_row = Role(id=role_id, role=role, permissions={})
    return User(
        id=uuid7(),
        email=f"{str(role)}@example.com",
        username=str(role),
        status="active",
        role_id=role_id,
        role=role_row,
    )


class _ListenerSession:
    def __init__(
        self,
        *,
        new: list[object] | None = None,
        dirty: list[object] | None = None,
        deleted: list[object] | None = None,
    ) -> None:
        self.info: dict[str, object] = {
            AUDIT_CONTEXT_KEY: AuditContext(request_id=uuid7(), request_method="POST")
        }
        self.new = [] if new is None else new
        self.dirty = [] if dirty is None else dirty
        self.deleted = [] if deleted is None else deleted
        self.added: list[object] = []

    def add(self, instance: object) -> None:
        self.added.append(instance)


class _ScalarItems:
    def __init__(self, items: list[Any]) -> None:
        self.items = items

    def all(self) -> list[Any]:
        return self.items


class _SecurityEventDatabase:
    def __init__(self, events: list[Any]) -> None:
        self.events = list(events)
        self.info: dict[str, object] = {}
        self.committed = False
        self.items_statement: Any = None

    def add(self, event: Any) -> None:
        self.events.append(event)

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        pass

    def flush(self) -> None:
        pass

    def refresh(self, event: Any) -> None:
        pass

    def scalar(self, statement: Any) -> int:
        return len(self.events)

    def scalars(self, statement: Any) -> _ScalarItems:
        self.items_statement = statement
        return _ScalarItems(self.events)

    def get(self, model: Any, identifier: UUID) -> Any:
        return next((event for event in self.events if event.id == identifier), None)


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    monkeypatch.setenv("SECURITY_EVENT_SERVER_KEY", "configured-server-key")
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


def test_security_event_is_a_separate_append_only_table_contract() -> None:
    model = _security_event_model()
    table = model.__table__

    assert model is not audit_models.AuditLog
    assert not issubclass(model, BaseModel)
    assert getattr(model_registry, "SecurityEvent", None) is model
    assert model.__tablename__ == "security_events"
    assert model.__audit_enabled__ is False
    assert set(table.columns.keys()) == {
        "id",
        "occurred_at",
        "event_type",
        "outcome",
        "source",
        "operation_id",
        "actor_id",
        "subject_id",
        "labels",
        "fingerprint",
        "reason",
        "request_id",
        "request_method",
        "request_path",
        "metadata",
    }
    assert "created_at" not in table.columns
    assert "updated_at" not in table.columns
    assert "deleted_at" not in table.columns

    assert table.c.event_type.type.length == 100
    assert table.c.outcome.type.length == 20
    assert table.c.source.type.length == 100
    assert table.c.fingerprint.type.length == 128
    assert table.c.reason.type.length == 500
    assert table.c.request_method.type.length == 10
    assert table.c.actor_id.nullable is True
    assert table.c.subject_id.nullable is True
    assert table.c.actor_id.type.as_uuid is True
    assert table.c.subject_id.type.as_uuid is True
    assert table.c.occurred_at.nullable is False
    assert table.c.event_type.nullable is False
    assert table.c.outcome.nullable is False
    assert table.c.source.nullable is False
    assert table.c.labels.nullable is False
    assert table.c.metadata.nullable is False

    for column_name in ("actor_id", "subject_id"):
        assert not table.c[column_name].foreign_keys

    checks = [
        str(constraint.sqltext)
        for constraint in table.constraints
        if constraint.__class__.__name__ == "CheckConstraint"
    ]
    assert any(
        all(
            f"'{value}'" in expression
            for value in ("attempt", "success", "denied", "failure", "partial")
        )
        for expression in checks
    )


def test_security_event_outcomes_and_payload_accept_valid_event() -> None:
    outcome = _security_event_outcome()
    assert [member.value for member in outcome] == [
        "attempt",
        "success",
        "denied",
        "failure",
        "partial",
    ]

    payload = _security_event_payload().model_validate(_payload_values())

    assert payload.event_type == "auth.login"
    assert payload.outcome is outcome.ATTEMPT
    assert payload.operation_id == UUID(str(payload.operation_id))
    assert payload.metadata == {"provider": "oidc", "attempt": 1}


@pytest.mark.parametrize("missing", ["event_type", "outcome", "source", "operation_id"])
def test_security_event_payload_rejects_missing_required_fields(missing: str) -> None:
    values = _payload_values()
    del values[missing]

    with pytest.raises(ValidationError):
        _security_event_payload().model_validate(values)


def test_security_event_payload_rejects_invalid_outcome_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        _security_event_payload().model_validate(_payload_values(outcome="queued"))

    with pytest.raises(ValidationError):
        _security_event_payload().model_validate(_payload_values(unexpected="ignored"))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("event_type", "x" * 101),
        ("source", "x" * 101),
        ("fingerprint", "x" * 129),
        ("reason", "x" * 501),
        ("labels", {str(index): "value" for index in range(21)}),
        ("labels", {"x" * 51: "value"}),
        ("labels", {"key": "x" * 101}),
        ("metadata", {str(index): "value" for index in range(21)}),
        ("metadata", {"x" * 51: "value"}),
        ("metadata", {"large": "x" * 4096}),
    ],
)
def test_security_event_payload_enforces_bounds(field: str, value: object) -> None:
    with pytest.raises(ValidationError):
        _security_event_payload().model_validate(_payload_values(**{field: value}))


@pytest.mark.parametrize(
    "sensitive_field",
    ["password", "token", "invite_link", "raw_provider_payload"],
)
def test_security_event_payload_rejects_sensitive_top_level_fields(sensitive_field: str) -> None:
    with pytest.raises(ValidationError):
        _security_event_payload().model_validate(_payload_values(**{sensitive_field: "secret"}))


def test_security_event_payload_rejects_sensitive_metadata() -> None:
    for key in ("password", "token", "invite_link", "raw_provider_payload"):
        with pytest.raises(ValidationError):
            _security_event_payload().model_validate(
                _payload_values(metadata={key: "must not be stored"})
            )


def test_trusted_writer_appends_security_event_without_audit_log_overloading() -> None:
    session = _ListenerSession()
    payload = _security_event_payload().model_validate(_payload_values())

    event = _append_security_event()(session, payload)

    assert isinstance(event, _security_event_model())
    assert session.added == [event]
    assert event.event_type == payload.event_type
    assert event.operation_id == payload.operation_id
    assert event.event_metadata == payload.metadata
    assert not any(isinstance(instance, audit_models.AuditLog) for instance in session.added)

    session.new = [event]
    audit_listeners.capture_changes(session, None, None)


@pytest.mark.parametrize("state", ["new", "dirty", "deleted"])
def test_audit_session_rejects_direct_security_event_mutations(state: str) -> None:
    event = _make_event()
    if state == "new":
        session = AuditSession()
        try:
            session.add(event)
            with pytest.raises(RuntimeError):
                audit_listeners.capture_changes(session, None, None)
        finally:
            session.close()
        return

    session = _ListenerSession(**{state: [event]})  # type: ignore[arg-type]
    with pytest.raises(RuntimeError):
        audit_listeners.capture_changes(session, None, None)


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


@pytest.mark.parametrize("path", [
    "/api/security-events",
    "/api/security-events/export",
    f"/api/security-events/{uuid7()}",
])
def test_non_admin_cannot_list_detail_or_export_security_events(
    api: FastAPI, path: str
) -> None:
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
    [{}, {"X-OpenSlate-Server-Key": "wrong-server-key"}],
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
        headers={"X-OpenSlate-Server-Key": "configured-server-key"},
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
        headers={"X-OpenSlate-Server-Key": "configured-server-key"},
        json=_payload_values(outcome="not-an-outcome", token="secret-token"),
    )

    assert response.status_code == 422
    assert database.events == []
    assert database.committed is False


def test_security_event_operation_id_correlates_attempt_and_outcome_queries() -> None:
    operation_id = uuid7()
    attempt = _make_event(operation_id=operation_id, outcome="attempt")
    success = _make_event(operation_id=operation_id, outcome="success")
    database = _SecurityEventDatabase([attempt, success])

    result = _list_security_events()(
        database,
        StandardListRequest(limit=100),
        operation_id=operation_id,
    )

    assert [event.outcome for event in result.items] == ["attempt", "success"]
    sql = str(database.items_statement.compile(dialect=postgresql.dialect()))
    assert "security_events.operation_id =" in sql
