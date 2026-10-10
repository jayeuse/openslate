import logging
from secrets import token_urlsafe

import pytest
from sqlalchemy.exc import OperationalError
from uuid6 import uuid7

from app.core.observability import LOGGER_NAME
from app.systems.manage.audit import listeners, service
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.platform.events.models import InvalidationEvent

SQL_CANARY = token_urlsafe(32)
PASSWORD_CANARY = token_urlsafe(32)


@pytest.fixture(autouse=True)
def capture_application_logs(caplog):
    logger = logging.getLogger(LOGGER_NAME)
    logger.addHandler(caplog.handler)
    try:
        yield
    finally:
        logger.removeHandler(caplog.handler)


def test_persistence_failure_is_logged_without_payload(monkeypatch, caplog) -> None:
    class FailedSession:
        def __init__(self, **kwargs):
            pass

        def add(self, event):
            pass

        def commit(self):
            raise OperationalError(SQL_CANARY, {}, Exception(PASSWORD_CANARY))

        def rollback(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(service, "AuditSession", FailedSession)
    monkeypatch.setattr(service, "get_engine", lambda: None)
    payload = SecurityEventIngestRequest(
        event_type="user.invitation",
        outcome="attempt",
        source="fastapi",
        operation_id=uuid7(),
        metadata={"value": "private business data"},
    )
    with caplog.at_level(logging.WARNING), pytest.raises(service.SecurityEventPersistenceError):
        service.append_committed_security_event(payload)
    assert "security_event_ingestion_failed" in caplog.text
    assert SQL_CANARY not in caplog.text
    assert PASSWORD_CANARY not in caplog.text
    assert "private business data" not in caplog.text


def test_realtime_failure_remains_best_effort_and_is_visible(monkeypatch, caplog) -> None:
    class CommittedSession:
        info = {listeners.REALTIME_INVALIDATION_KEY: [InvalidationEvent(entity="records")]}

        def in_nested_transaction(self) -> bool:
            # A top-level commit: the only commit that publishes invalidations.
            return False

    def unavailable(events):
        raise RuntimeError("private event transport response")

    monkeypatch.setattr(listeners, "publish_invalidations", unavailable)
    with caplog.at_level(logging.WARNING):
        listeners.broadcast_committed_changes(CommittedSession())
    assert "realtime_invalidation_failure" in caplog.text
    assert "private provider response" not in caplog.text
