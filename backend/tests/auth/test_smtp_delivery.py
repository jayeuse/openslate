"""Focused contracts for optional local SMTP action-token delivery."""

import threading
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy.orm import Session
from starlette.requests import Request
from uuid6 import uuid7

import app.systems.access.auth.router as auth_router
from app.core.base_model import utc_now
from app.core.config.settings import Settings
from app.systems.access.identity.models import ActionTokenPurpose
from app.systems.platform.notifications.models import IdentityDeliveryOutbox, OutboxState
from app.systems.platform.notifications.outbox import (
    DeliveryStatus,
    decrypt_action_token,
    delivery_status,
    queue_action_delivery,
)
from app.systems.platform.notifications.smtp import send_delivery, send_delivery_bounded
from app.systems.platform.notifications.worker import ClaimedDelivery, SmtpOutboxWorker
from tests.config_support import settings_values


def test_smtp_is_disabled_by_default_and_email_queueing_is_a_safe_noop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings.model_validate(settings_values())
    db = Mock(spec=Session)
    monkeypatch.setattr("app.systems.platform.notifications.outbox.get_settings", lambda: settings)

    assert not queue_action_delivery(db, uuid7(), ActionTokenPurpose.RECOVERY, "opaque-token")
    db.add.assert_not_called()


def test_smtp_requires_an_authenticated_encryption_key_and_complete_transport() -> None:
    with pytest.raises(ValidationError):
        Settings.model_validate(settings_values(smtp_enabled=True))
    with pytest.raises(ValidationError):
        Settings.model_validate(
            settings_values(
                smtp_enabled=True,
                smtp_host="smtp.example.test",
                smtp_port=587,
                smtp_from="OpenSlate <no-reply@example.test>",
                smtp_transport="plain",
                smtp_delivery_encryption_key="not-a-fernet-key",
            )
        )


def test_outbox_encrypts_raw_action_token_before_it_is_added(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings.model_validate(
        settings_values(
            smtp_enabled=True,
            smtp_host="smtp.example.test",
            smtp_port=587,
            smtp_from="no-reply@example.test",
            smtp_transport="starttls",
            smtp_delivery_encryption_key="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        )
    )
    db = Mock(spec=Session)
    action = Mock(id=uuid7(), user_id=uuid7())
    db.scalar.return_value = action
    monkeypatch.setattr("app.systems.platform.notifications.outbox.get_settings", lambda: settings)

    assert queue_action_delivery(db, action.user_id, ActionTokenPurpose.INVITATION, "opaque-token")
    queued = db.add.call_args.args[0]
    assert queued.encrypted_token != "opaque-token"
    assert decrypt_action_token(queued.encrypted_token, settings) == "opaque-token"


def test_smtp_message_uses_a_fragment_action_link(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _smtp_settings()
    sent: list[object] = []
    delivery = _delivery(ActionTokenPurpose.RECOVERY, "encrypted")
    smtp = SimpleNamespace(
        ehlo=lambda: None,
        starttls=lambda **_kwargs: None,
        login=lambda *_args: None,
        send_message=sent.append,
        quit=lambda: None,
    )
    monkeypatch.setattr(
        "app.systems.platform.notifications.smtp._connect",
        lambda *_args, **_kwargs: smtp,
    )
    send_delivery(delivery.recipient, delivery.purpose, "opaque-token", settings)
    message = sent[0]
    assert "#token=opaque-token" in message.get_content()
    assert "?token=" not in message.get_content()
    assert "opaque-token" not in str(message.items())


def test_terminal_delivery_failure_erases_the_encrypted_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _smtp_settings(smtp_delivery_max_attempts=1)
    delivery = _delivery(ActionTokenPurpose.INVITATION, "encrypted")
    worker = SmtpOutboxWorker(settings)
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.log_event", lambda *_args, **_kwargs: None
    )
    worker._record_failure(delivery)

    assert delivery.state == OutboxState.FAILED
    assert delivery.encrypted_token is None
    assert delivery.failure_code == "smtp_unavailable"


def test_expired_max_attempt_lease_is_terminalized_before_a_later_delivery_is_claimed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _smtp_settings(smtp_delivery_max_attempts=2)
    exhausted = _delivery(ActionTokenPurpose.RECOVERY, "encrypted-exhausted")
    exhausted.attempt_count = settings.smtp_delivery_max_attempts
    later = _delivery(ActionTokenPurpose.INVITATION, "encrypted-later")
    later.state = OutboxState.PENDING
    later.attempt_count = 0
    db = Mock(spec=Session)
    db.scalar.side_effect = [exhausted, later]
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.AuditSession", _audit_session_factory(db)
    )
    monkeypatch.setattr("app.systems.platform.notifications.worker.get_engine", lambda: Mock())
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker._action_is_deliverable", lambda *_args: True
    )
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.decrypt_action_token", lambda *_args: "raw-token"
    )
    worker = SmtpOutboxWorker(settings)

    claim = worker._claim_due_delivery()

    assert claim is not None and claim.id == later.id
    assert exhausted.state == OutboxState.FAILED
    assert exhausted.encrypted_token is None
    assert exhausted.lease_token is None
    assert exhausted.failure_code == "attempts_exhausted"
    assert later.attempt_count == 1
    assert db.commit.call_count == 2


def test_claim_terminalization_is_bounded_and_checks_stop_between_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _smtp_settings(smtp_delivery_batch_size=1, smtp_delivery_max_attempts=1)
    exhausted = _delivery(ActionTokenPurpose.RECOVERY, "encrypted")
    later = _delivery(ActionTokenPurpose.INVITATION, "encrypted")
    later.state = OutboxState.PENDING
    db = Mock(spec=Session)
    db.scalar.side_effect = [exhausted, later]
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.AuditSession", _audit_session_factory(db)
    )
    monkeypatch.setattr("app.systems.platform.notifications.worker.get_engine", lambda: Mock())

    assert SmtpOutboxWorker(settings)._claim_due_delivery() is None
    assert exhausted.state == OutboxState.FAILED
    assert db.scalar.call_count == 1
    assert later.state == OutboxState.PENDING


def test_slow_load_uses_a_fresh_lease_and_a_reclaimed_owner_cannot_send(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _smtp_settings()
    delivery = _delivery(ActionTokenPurpose.RECOVERY, "encrypted")
    db = Mock(spec=Session)
    first, after_load = utc_now(), utc_now() + timedelta(minutes=5)
    worker = SmtpOutboxWorker(settings)
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.AuditSession",
        _audit_session_factory(db, Mock(spec=Session)),
    )
    monkeypatch.setattr("app.systems.platform.notifications.worker.get_engine", lambda: Mock())
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.utc_now", Mock(side_effect=[first, after_load])
    )
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker._action_is_deliverable", lambda *_: True
    )
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.decrypt_action_token", lambda *_: "raw"
    )
    db.scalar.return_value = delivery

    claim = worker._claim_due_delivery()

    assert claim is not None
    assert delivery.lease_expires_at == after_load + worker._lease_duration
    send = Mock()
    monkeypatch.setattr(worker, "_leased_delivery", Mock(return_value=None))
    monkeypatch.setattr("app.systems.platform.notifications.worker.send_delivery_bounded", send)
    worker._deliver_claimed(claim)
    send.assert_not_called()


@pytest.mark.parametrize(("terminate_stops", "expected_kills"), [(True, 0), (False, 1)])
def test_bounded_delivery_timeout_stops_or_kills_the_child_and_keeps_secrets_off_arguments(
    monkeypatch: pytest.MonkeyPatch, terminate_stops: bool, expected_kills: int
) -> None:
    settings = _smtp_settings(smtp_delivery_operation_timeout_seconds=10)
    sent: list[object] = []
    command_receiver = SimpleNamespace(close=Mock())
    command_sender = SimpleNamespace(close=Mock(), send=sent.append)
    result_receiver = SimpleNamespace(close=Mock(), poll=Mock(return_value=False), recv=Mock())
    result_sender = SimpleNamespace(close=Mock())
    alive = True
    joins: list[float | None] = []
    child = Mock(start=Mock())
    child.is_alive.side_effect = lambda: alive

    def join(*, timeout: float) -> None:
        joins.append(timeout)

    child.join.side_effect = join

    def terminate() -> None:
        nonlocal alive
        alive = not terminate_stops

    def kill() -> None:
        nonlocal alive
        alive = False

    child.terminate.side_effect = terminate
    child.kill.side_effect = kill
    context = SimpleNamespace(
        Pipe=Mock(
            side_effect=[(command_receiver, command_sender), (result_receiver, result_sender)]
        ),
        Process=Mock(return_value=child),
    )
    monkeypatch.setattr(
        "app.systems.platform.notifications.smtp.multiprocessing.get_context", lambda _name: context
    )

    assert not send_delivery_bounded(
        "person@example.test", ActionTokenPurpose.RECOVERY, "raw-secret", settings
    )
    result_receiver.poll.assert_called_once_with(settings.smtp_delivery_operation_timeout_seconds)
    assert child.terminate.call_count == 1 and child.kill.call_count == expected_kills
    assert joins == ([1, 0] if terminate_stops else [1, 1, 0])
    assert all("raw-secret" not in repr(value) for value in context.Process.call_args_list)
    assert sent[0].raw_token == "raw-secret"


def test_claimed_delivery_sends_after_loading_and_finalizes_only_its_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _smtp_settings()
    delivery = _delivery(ActionTokenPurpose.INVITATION, "encrypted")
    lease = uuid7()
    delivery.lease_token = lease
    delivery.lease_expires_at = utc_now() + timedelta(minutes=1)
    FakeAuditSession = _audit_session_factory(Mock(spec=Session), Mock(spec=Session))

    sent: list[tuple[object, ...]] = []
    monkeypatch.setattr("app.systems.platform.notifications.worker.AuditSession", FakeAuditSession)
    monkeypatch.setattr("app.systems.platform.notifications.worker.get_engine", lambda: Mock())
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.decrypt_action_token", lambda *_args: "raw-token"
    )
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker._action_is_deliverable", lambda *_args: True
    )
    worker = SmtpOutboxWorker(settings)
    monkeypatch.setattr(worker, "_leased_delivery", Mock(side_effect=[delivery, delivery]))
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.send_delivery_bounded",
        lambda *args: sent.append(args) or True,
    )

    worker._deliver_claimed(
        ClaimedDelivery(
            delivery.id, lease, delivery.recipient, ActionTokenPurpose.INVITATION, "raw-token"
        )
    )

    assert sent == [(delivery.recipient, ActionTokenPurpose.INVITATION, "raw-token", settings)]
    assert delivery.state == OutboxState.DELIVERED
    assert delivery.encrypted_token is None
    assert delivery.lease_token is None


def test_worker_claims_one_delivery_at_a_time_and_stops_between_items(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = SmtpOutboxWorker(_smtp_settings(smtp_delivery_batch_size=2))
    first = ClaimedDelivery(uuid7(), uuid7())
    second = ClaimedDelivery(uuid7(), uuid7())
    claimed = Mock(side_effect=[first, second])
    delivered: list[ClaimedDelivery] = []
    monkeypatch.setattr(worker, "_claim_due_delivery", claimed)

    def deliver(claim: ClaimedDelivery) -> None:
        delivered.append(claim)
        worker._stop.set()

    monkeypatch.setattr(worker, "_deliver_claimed", deliver)

    assert worker.run_once() == 1
    assert delivered == [first]
    claimed.assert_called_once()


def test_delivery_lease_covers_payload_load_send_and_finalization_budgets() -> None:
    settings = _smtp_settings(
        smtp_delivery_operation_timeout_seconds=30,
        database_pool_timeout_seconds=5,
        database_statement_timeout_ms=15_000,
    )

    database_operation = (
        settings.database_pool_timeout_seconds + settings.database_statement_timeout_ms / 1000
    )
    assert SmtpOutboxWorker(settings)._lease_duration.total_seconds() == (
        settings.smtp_delivery_operation_timeout_seconds + 2 + 2 * database_operation + 5
    )


def test_worker_stop_waits_for_an_active_bounded_delivery_to_drain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = SmtpOutboxWorker(_smtp_settings())
    entered_delivery = threading.Event()
    release_delivery = threading.Event()
    stopped = threading.Event()
    claim = ClaimedDelivery(uuid7(), uuid7())
    monkeypatch.setattr(worker, "_claim_due_delivery", Mock(return_value=claim))

    def deliver(_claim: ClaimedDelivery) -> None:
        entered_delivery.set()
        assert release_delivery.wait(timeout=1)

    monkeypatch.setattr(worker, "_deliver_claimed", deliver)
    worker.start()
    assert entered_delivery.wait(timeout=1)

    def stop_worker() -> None:
        worker.stop()
        stopped.set()

    stopping = threading.Thread(target=stop_worker)
    stopping.start()
    assert not stopped.wait(timeout=0.05)
    release_delivery.set()
    stopping.join(timeout=1)

    assert stopped.is_set()
    assert worker._thread is None
    assert not worker.running


def test_stop_after_payload_load_releases_the_lease_without_sending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _smtp_settings()
    delivery = _delivery(ActionTokenPurpose.INVITATION, "encrypted")
    lease = uuid7()
    delivery.lease_token = lease
    delivery.lease_expires_at = utc_now() + timedelta(minutes=1)
    db = Mock(spec=Session)
    action = Mock(user_id=uuid7())
    db.get.side_effect = [action, Mock()]

    worker = SmtpOutboxWorker(settings)
    worker._stop.set()
    release = Mock()
    send = Mock()
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.AuditSession", _audit_session_factory(db)
    )
    monkeypatch.setattr(worker, "_leased_delivery", Mock(return_value=delivery))
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker._action_is_deliverable", lambda *_args: True
    )
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.decrypt_action_token", lambda *_args: "raw-token"
    )
    monkeypatch.setattr(worker, "_release_claim", release)
    monkeypatch.setattr("app.systems.platform.notifications.worker.send_delivery_bounded", send)

    claim = ClaimedDelivery(
        delivery.id, lease, delivery.recipient, ActionTokenPurpose.INVITATION, "raw-token"
    )
    worker._deliver_claimed(claim)

    release.assert_called_once_with(claim)
    send.assert_not_called()


def test_obsolete_action_delivery_is_canceled_without_starting_smtp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _smtp_settings()
    delivery = _delivery(ActionTokenPurpose.RECOVERY, "encrypted")
    lease = uuid7()
    delivery.lease_token = lease
    FakeAuditSession = _audit_session_factory(Mock(spec=Session), Mock(spec=Session))

    worker = SmtpOutboxWorker(settings)
    send = Mock(return_value=True)
    monkeypatch.setattr("app.systems.platform.notifications.worker.AuditSession", FakeAuditSession)
    monkeypatch.setattr(worker, "_leased_delivery", Mock(side_effect=[delivery, delivery]))
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker._action_is_deliverable", lambda *_args: False
    )
    monkeypatch.setattr("app.systems.platform.notifications.worker.send_delivery_bounded", send)

    worker._deliver_claimed(ClaimedDelivery(delivery.id, lease))

    send.assert_not_called()
    assert delivery.state == OutboxState.CANCELED
    assert delivery.encrypted_token is None
    assert delivery.failure_code == "action_unavailable"


def test_delivery_status_contains_only_enabled_and_state_counts() -> None:
    db = Mock(spec=Session)
    db.execute.return_value.all.return_value = [(OutboxState.PENDING, 2)]

    status = delivery_status(db, _smtp_settings())

    assert status.enabled is True
    assert status.state_counts == {"pending": 2}
    assert "recipient" not in repr(status)


def test_authenticated_admin_delivery_status_exposes_only_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    monkeypatch.setattr(
        auth_router,
        "delivery_status",
        lambda _db: DeliveryStatus(enabled=True, state_counts={"pending": 2}),
    )

    app = FastAPI()
    app.state.smtp_outbox_worker = SimpleNamespace(running=True)
    request = Request({"type": "http", "app": app, "headers": [], "method": "GET", "path": "/"})
    response = auth_router.smtp_delivery_status(Mock(), request, db)

    assert response == {"enabled": True, "running": True, "state_counts": {"pending": 2}}
    assert "recipient" not in response


def _smtp_settings(**overrides: object) -> Settings:
    return Settings.model_validate(
        settings_values(
            smtp_enabled=True,
            smtp_host="smtp.example.test",
            smtp_port=587,
            smtp_from="no-reply@example.test",
            smtp_transport="starttls",
            smtp_delivery_encryption_key="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            **overrides,
        )
    )


def _delivery(purpose: ActionTokenPurpose, encrypted_token: str) -> IdentityDeliveryOutbox:
    return IdentityDeliveryOutbox(
        id=uuid7(),
        action_token_id=uuid7(),
        recipient="person@example.test",
        purpose=purpose,
        encrypted_token=encrypted_token,
        state=OutboxState.SENDING,
        attempt_count=1,
    )


def _audit_session_factory(*sessions: Mock) -> type[object]:
    remaining = list(sessions)

    class FakeAuditSession:
        def __init__(self, **_kwargs: object) -> None:
            self._session = remaining.pop(0)

        def __enter__(self) -> Mock:
            return self._session

        def __exit__(self, *_args: object) -> None:
            pass

    return FakeAuditSession
