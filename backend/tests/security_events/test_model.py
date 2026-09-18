from unittest.mock import Mock

import pytest
from pydantic import ValidationError

import app.systems.manage.audit.listeners as audit_listeners
import app.systems.manage.audit.models as audit_models
import app.systems.manage.audit.service as audit_service
from app.core.database.session import AuditSession

from .support import (
    _append_security_event,
    _ListenerSession,
    _make_event,
    _payload_values,
    _security_event_model,
    _security_event_payload,
)


def test_security_event_payload_accepts_exact_validation_boundaries() -> None:
    labels = {f"label-{index}": "x" * 100 for index in range(20)}
    metadata = {"note": "x" * 4085}

    payload = _security_event_payload().model_validate(
        _payload_values(labels=labels, metadata=metadata)
    )

    assert payload.labels == labels
    assert payload.metadata == metadata


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"labels": {"": "valid"}}, "Keys must be between 1 and 50 characters"),
        (
            {"labels": {f"label-{index}": "valid" for index in range(21)}},
            "Labels may contain at most 20 keys",
        ),
        ({"labels": {"label": "x" * 101}}, "Label values must be at most 100 characters"),
    ],
)
def test_security_event_payload_rejects_invalid_labels(
    overrides: dict[str, object], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        _security_event_payload().model_validate(_payload_values(**overrides))


@pytest.mark.parametrize(
    ("metadata", "message"),
    [
        (
            {f"key-{index}": index for index in range(21)},
            "Metadata may contain at most 20 keys",
        ),
        (
            {"nested": {f"key-{index}": index for index in range(21)}},
            "Metadata objects may contain at most 20 keys",
        ),
        ({"items": list(range(21))}, "Metadata arrays may contain at most 20 items"),
        ({"nested": {"private_key": "secret"}}, "Sensitive keys are not permitted"),
        (
            {"one": {"two": {"three": {"four": {"five": "value"}}}}},
            "Metadata nesting is too deep",
        ),
        ({"note": "x" * 4086}, "Metadata must be at most 4096 bytes"),
    ],
)
def test_security_event_payload_rejects_invalid_metadata(
    metadata: dict[str, object], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        _security_event_payload().model_validate(_payload_values(metadata=metadata))


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
