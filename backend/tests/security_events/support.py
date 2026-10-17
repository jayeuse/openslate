from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from uuid6 import uuid7

import app.systems.manage.audit.models as audit_models
import app.systems.manage.audit.schemas as audit_schemas
import app.systems.manage.audit.service as audit_service
from app.systems.access.users.models import Membership, PlatformOperator, User, UserRole
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member


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


def _payload_values(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "event_type": "auth.login",
        "outcome": "attempt",
        "source": "local.identity",
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
        "source": "local.identity",
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


def _user(role: UserRole | str) -> tuple[User, Membership]:
    return create_member(None, WorkspaceProfile(id=uuid7()), str(role),
        id=uuid7(),
        email=f"{str(role)}@example.com",
        username=str(role),
        status="active",
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
        self.dirty = set()
        self.membership: Membership | None = None

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

    def scalar(self, statement: Any) -> Any:
        entity = statement.column_descriptions[0]["entity"]
        if entity is _security_event_model():
            identifiers = statement.compile().params.values()
            return next((event for event in self.events if event.id in identifiers), None)
        if entity is PlatformOperator:
            return None
        assert entity is None, "Unexpected scalar query"
        return len(self.events)

    def scalars(self, statement: Any) -> _ScalarItems:
        if statement.column_descriptions[0]["entity"] is Membership:
            return _ScalarItems([] if self.membership is None else [self.membership])
        self.items_statement = statement
        return _ScalarItems(self.events)

    def get(self, model: Any, identifier: UUID) -> Any:
        return next((event for event in self.events if event.id == identifier), None)
