from unittest.mock import Mock
from uuid import UUID

import pytest
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql
from uuid6 import uuid7

import app.systems.audit.listeners as audit_listeners
import app.systems.audit.models as audit_models
import app.systems.audit.service as audit_service
from app.common.listing import StandardListRequest
from app.core.base_model import BaseModel
from app.core.database import model_registry
from app.core.database.session import AuditSession

from .support import (
    _append_security_event,
    _list_security_events,
    _ListenerSession,
    _make_event,
    _payload_values,
    _security_event_model,
    _security_event_outcome,
    _security_event_payload,
    _SecurityEventDatabase,
)


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
