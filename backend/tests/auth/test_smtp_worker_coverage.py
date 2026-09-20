"""Failure and transport boundaries for optional SMTP delivery."""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.config.settings import Settings
from app.systems.access.identity.models import ActionTokenPurpose
from app.systems.access.users.models import UserStatus
from app.systems.platform.notifications.models import IdentityDeliveryOutbox, OutboxState
from app.systems.platform.notifications.outbox import (
    DeliveryPayloadError,
    decrypt_action_token,
    queue_action_delivery,
    smtp_delivery_enabled,
)
from app.systems.platform.notifications.smtp import (
    SMTPDeliveryCommand,
    _connect,
    _delivery_child,
    _send_command,
    send_delivery_bounded,
)
from app.systems.platform.notifications.worker import (
    ClaimedDelivery,
    SmtpOutboxWorker,
    _action_is_deliverable,
)
from tests.config_support import settings_values


def test_outbox_reports_enabled_and_rejects_unavailable_payloads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    disabled = Settings.model_validate(settings_values())
    enabled = _settings()
    db = Mock(spec=Session)
    monkeypatch.setattr("app.systems.platform.notifications.outbox.get_settings", lambda: disabled)
    assert not smtp_delivery_enabled()
    monkeypatch.setattr("app.systems.platform.notifications.outbox.get_settings", lambda: enabled)
    assert smtp_delivery_enabled()

    with pytest.raises(DeliveryPayloadError, match="unavailable"):
        queue_action_delivery(db, uuid7(), ActionTokenPurpose.RECOVERY, "")
    db.get.return_value = None
    db.scalar.return_value = None
    with pytest.raises(DeliveryPayloadError, match="unavailable"):
        queue_action_delivery(db, uuid7(), ActionTokenPurpose.RECOVERY, "opaque")
    db.add.assert_not_called()


def test_outbox_rejects_corrupted_and_disabled_encrypted_payloads() -> None:
    with pytest.raises(DeliveryPayloadError, match="unavailable"):
        decrypt_action_token("not-a-fernet-payload", _settings())
    with pytest.raises(DeliveryPayloadError, match="not enabled"):
        decrypt_action_token("not-a-fernet-payload", Settings.model_validate(settings_values()))


@pytest.mark.parametrize(
    ("transport", "expected_ehlo", "expects_starttls"),
    [("plain", 1, False), ("starttls", 2, True)],
)
def test_smtp_connects_plain_and_starttls_with_expected_handshake(
    monkeypatch: pytest.MonkeyPatch,
    transport: str,
    expected_ehlo: int,
    expects_starttls: bool,
) -> None:
    connection = SimpleNamespace(ehlo=Mock(), starttls=Mock())
    factory = Mock(return_value=connection)
    context = object()
    monkeypatch.setattr(
        "app.systems.platform.notifications.smtp.ssl.create_default_context", lambda: context
    )

    result = _connect(_command(transport), smtp_factory=factory, smtp_ssl_factory=Mock())

    assert result is connection
    factory.assert_called_once_with("smtp.example.test", 587, timeout=10)
    assert connection.ehlo.call_count == expected_ehlo
    if expects_starttls:
        connection.starttls.assert_called_once_with(context=context)
    else:
        connection.starttls.assert_not_called()


def test_smtp_connects_with_implicit_tls() -> None:
    connection = Mock()
    ssl_factory = Mock(return_value=connection)

    result = _connect(_command("implicit_tls"), smtp_factory=Mock(), smtp_ssl_factory=ssl_factory)

    assert result is connection
    assert ssl_factory.call_args.args == ("smtp.example.test", 587)
    assert ssl_factory.call_args.kwargs["timeout"] == 10
    assert ssl_factory.call_args.kwargs["context"] is not None


def test_smtp_sends_authenticated_invitation_and_tolerates_quit_failure() -> None:
    connection = SimpleNamespace(
        ehlo=Mock(), login=Mock(), send_message=Mock(), quit=Mock(side_effect=OSError("closed"))
    )

    _send_command(
        _command("plain", ActionTokenPurpose.INVITATION, username="mailer", password="secret"),
        smtp_factory=Mock(return_value=connection),
        smtp_ssl_factory=Mock(),
    )

    connection.login.assert_called_once_with("mailer", "secret")
    message = connection.send_message.call_args.args[0]
    assert message["Subject"] == "Complete your OpenSlate setup"
    assert "/auth/setup#token=opaque" in message.get_content()
    connection.quit.assert_called_once()


@pytest.mark.parametrize("command", ["invalid", None])
def test_smtp_child_reports_invalid_or_failed_commands_and_closes_pipes(
    monkeypatch: pytest.MonkeyPatch, command: object
) -> None:
    receiver = SimpleNamespace(recv=Mock(return_value=command), close=Mock())
    sender = SimpleNamespace(send=Mock(), close=Mock())
    monkeypatch.setattr("app.systems.platform.notifications.smtp._send_command", Mock())

    _delivery_child(receiver, sender)

    sender.send.assert_called_once_with(False)
    receiver.close.assert_called_once()
    sender.close.assert_called_once()


def test_smtp_child_reports_success_after_transport_send(monkeypatch: pytest.MonkeyPatch) -> None:
    receiver = SimpleNamespace(recv=Mock(return_value=_command("plain")), close=Mock())
    sender = SimpleNamespace(send=Mock(), close=Mock())
    send = Mock()
    monkeypatch.setattr("app.systems.platform.notifications.smtp._send_command", send)

    _delivery_child(receiver, sender)

    send.assert_called_once()
    sender.send.assert_called_once_with(True)
    receiver.close.assert_called_once()
    sender.close.assert_called_once()


@pytest.mark.parametrize(("result", "expected"), [(True, True), (EOFError(), False)])
def test_bounded_smtp_returns_child_result_and_closes_process_resources(
    monkeypatch: pytest.MonkeyPatch, result: object, expected: bool
) -> None:
    command_receiver = SimpleNamespace(close=Mock())
    command_sender = SimpleNamespace(close=Mock(), send=Mock())
    result_receiver = SimpleNamespace(close=Mock(), poll=Mock(return_value=True), recv=Mock())
    if isinstance(result, BaseException):
        result_receiver.recv.side_effect = result
    else:
        result_receiver.recv.return_value = result
    result_sender = SimpleNamespace(close=Mock())
    child = Mock(start=Mock(), is_alive=Mock(return_value=False), join=Mock())
    context = SimpleNamespace(
        Pipe=Mock(
            side_effect=[(command_receiver, command_sender), (result_receiver, result_sender)]
        ),
        Process=Mock(return_value=child),
    )
    monkeypatch.setattr(
        "app.systems.platform.notifications.smtp.multiprocessing.get_context", lambda _name: context
    )

    assert (
        send_delivery_bounded(
            "person@example.test", ActionTokenPurpose.RECOVERY, "opaque", _settings()
        )
        is expected
    )
    command_sender.send.assert_called_once()
    assert isinstance(command_sender.send.call_args.args[0], SMTPDeliveryCommand)
    child.join.assert_called_once_with(timeout=0)
    command_sender.close.assert_called()
    result_receiver.close.assert_called_once()


def test_bounded_smtp_start_failure_stops_child_and_returns_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    command_receiver = SimpleNamespace(close=Mock())
    command_sender = SimpleNamespace(close=Mock(), send=Mock())
    result_receiver = SimpleNamespace(close=Mock(), poll=Mock(), recv=Mock())
    result_sender = SimpleNamespace(close=Mock())
    child = Mock(start=Mock(side_effect=OSError("unavailable")), is_alive=Mock(return_value=False))
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
        "person@example.test", ActionTokenPurpose.RECOVERY, "opaque", _settings()
    )
    command_sender.send.assert_not_called()
    result_receiver.close.assert_called_once()


def test_worker_start_is_idempotent_and_disabled_workers_do_not_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    thread = Mock()
    constructor = Mock(return_value=thread)
    monkeypatch.setattr("app.systems.platform.notifications.worker.threading.Thread", constructor)
    worker = SmtpOutboxWorker(_settings())

    worker.start()
    worker.start()
    worker.stop()

    constructor.assert_called_once()
    thread.start.assert_called_once()
    thread.join.assert_called_once()
    disabled = SmtpOutboxWorker(Settings.model_validate(settings_values()))
    disabled.start()
    assert disabled._thread is None


def test_worker_start_clears_a_previous_stop_request_before_restarting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    threads = [Mock(), Mock()]
    constructor = Mock(side_effect=threads)
    monkeypatch.setattr("app.systems.platform.notifications.worker.threading.Thread", constructor)
    worker = SmtpOutboxWorker(_settings())

    worker.start()
    worker.stop()
    worker.start()

    assert not worker._stop.is_set()
    assert constructor.call_count == 2
    threads[1].start.assert_called_once()


def test_worker_loop_logs_isolated_iteration_failure_and_stops(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = SmtpOutboxWorker(_settings())
    stop = _StopAfterWait()
    worker._stop = stop  # type: ignore[assignment]
    worker.run_once = Mock(side_effect=RuntimeError("database unavailable"))  # type: ignore[method-assign]
    log = Mock()

    monkeypatch.setattr("app.systems.platform.notifications.worker.log_event", log)
    worker._run()

    log.assert_called_once_with(
        "smtp_delivery_failure", level=40, reason_code="worker_failure"
    )
    assert not worker.running


def test_worker_releases_claim_when_stop_arrives_after_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = SmtpOutboxWorker(_settings())
    claim = ClaimedDelivery(uuid7(), uuid7())
    release = Mock()

    def claim_then_stop() -> ClaimedDelivery:
        worker._stop.set()
        return claim

    monkeypatch.setattr(worker, "_claim_due_delivery", claim_then_stop)
    monkeypatch.setattr(worker, "_release_claim", release)
    monkeypatch.setattr(worker, "_deliver_claimed", Mock())

    assert worker.run_once() == 0
    release.assert_called_once_with(claim)


def test_worker_claim_cancels_obsolete_action_before_later_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = SmtpOutboxWorker(_settings())
    delivery = _delivery()
    db = Mock(spec=Session)
    db.scalar.side_effect = [delivery, None]
    db.get.side_effect = [SimpleNamespace(user_id=uuid7()), SimpleNamespace()]
    _patch_worker_session(monkeypatch, db)
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker._action_is_deliverable", lambda *_args: False
    )

    assert worker._claim_due_delivery() is None
    assert delivery.state == OutboxState.CANCELED
    assert delivery.encrypted_token is None
    db.commit.assert_called_once()


def test_worker_claim_retries_missing_payload_and_rolls_back_when_stopped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = SmtpOutboxWorker(_settings())
    retry = _delivery()
    retry.encrypted_token = None
    stopped = _delivery()
    db = Mock(spec=Session)
    db.scalar.side_effect = [retry, None]
    db.get.side_effect = [SimpleNamespace(user_id=uuid7()), SimpleNamespace()]
    _patch_worker_session(monkeypatch, db, db)
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker._action_is_deliverable", lambda *_args: True
    )
    monkeypatch.setattr("app.systems.platform.notifications.worker.log_event", Mock())

    assert worker._claim_due_delivery() is None
    assert retry.state == OutboxState.PENDING
    assert retry.failure_code == "smtp_unavailable"
    assert retry.next_attempt_at > utc_now()
    db.commit.assert_called_once()

    db.scalar.side_effect = [stopped]
    db.get.side_effect = [SimpleNamespace(user_id=uuid7()), SimpleNamespace()]

    def decrypt_then_stop(*_args: object) -> str:
        worker._stop.set()
        return "opaque"

    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.decrypt_action_token", decrypt_then_stop
    )
    assert worker._claim_due_delivery() is None
    db.rollback.assert_called_once()


def test_worker_finalization_retries_when_bounded_smtp_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = SmtpOutboxWorker(_settings())
    claim = ClaimedDelivery(
        uuid7(), uuid7(), "person@example.test", ActionTokenPurpose.RECOVERY, "opaque"
    )
    delivery = _delivery(lease_token=claim.lease_token)
    initial_db = Mock(spec=Session)
    initial_db.get.side_effect = [SimpleNamespace(user_id=uuid7()), SimpleNamespace()]
    final_db = Mock(spec=Session)
    _patch_worker_session(monkeypatch, initial_db, final_db)
    monkeypatch.setattr(worker, "_leased_delivery", Mock(side_effect=[delivery, delivery]))
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker._action_is_deliverable", lambda *_args: True
    )
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker.send_delivery_bounded", Mock(return_value=False)
    )
    monkeypatch.setattr("app.systems.platform.notifications.worker.log_event", Mock())

    worker._deliver_claimed(claim)

    assert delivery.state == OutboxState.PENDING
    assert delivery.failure_code == "smtp_unavailable"
    assert delivery.next_attempt_at > utc_now()
    final_db.commit.assert_called_once()


def test_worker_releases_current_lease_and_action_rules_are_strict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = SmtpOutboxWorker(_settings())
    claim = ClaimedDelivery(uuid7(), uuid7())
    delivery = _delivery(lease_token=claim.lease_token)
    db = Mock(spec=Session)
    _patch_worker_session(monkeypatch, db)
    monkeypatch.setattr(worker, "_leased_delivery", Mock(return_value=delivery))

    worker._release_claim(claim)

    assert delivery.state == OutboxState.PENDING
    assert delivery.lease_token is None and delivery.lease_expires_at is None
    db.commit.assert_called_once()
    now = utc_now()
    valid = SimpleNamespace(
        expires_at=now + timedelta(minutes=1),
        purpose=ActionTokenPurpose.INVITATION,
        consumed_at=None,
    )
    pending = SimpleNamespace(is_deleted=False, status=UserStatus.PENDING.value)
    active = SimpleNamespace(is_deleted=False, status=UserStatus.ACTIVE.value)
    assert _action_is_deliverable(valid, pending, ActionTokenPurpose.INVITATION)
    assert _action_is_deliverable(valid, active, ActionTokenPurpose.INVITATION) is False
    assert _action_is_deliverable(valid, active, ActionTokenPurpose.RECOVERY) is False
    valid.purpose = ActionTokenPurpose.RECOVERY
    assert _action_is_deliverable(valid, active, ActionTokenPurpose.RECOVERY)
    valid.expires_at = now - timedelta(seconds=1)
    assert _action_is_deliverable(valid, active, ActionTokenPurpose.RECOVERY) is False


def _settings(**overrides: object) -> Settings:
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


def _command(
    transport: str,
    purpose: ActionTokenPurpose = ActionTokenPurpose.RECOVERY,
    *,
    username: str | None = None,
    password: str | None = None,
) -> SMTPDeliveryCommand:
    return SMTPDeliveryCommand(
        recipient="person@example.test",
        purpose=purpose,
        raw_token="opaque",
        host="smtp.example.test",
        port=587,
        username=username,
        password=password,
        sender="no-reply@example.test",
        transport=transport,
        socket_timeout_seconds=10,
        public_origin="https://openslate.example.test/app/",
    )


def _delivery(*, lease_token: UUID | None = None) -> IdentityDeliveryOutbox:
    return IdentityDeliveryOutbox(
        id=uuid7(),
        action_token_id=uuid7(),
        recipient="person@example.test",
        purpose=ActionTokenPurpose.RECOVERY,
        encrypted_token="encrypted",
        state=OutboxState.SENDING,
        attempt_count=1,
        lease_token=lease_token,
        lease_expires_at=utc_now() + timedelta(minutes=1),
    )


def _patch_worker_session(monkeypatch: pytest.MonkeyPatch, *sessions: Mock) -> None:
    remaining = list(sessions)

    class FakeAuditSession:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def __enter__(self) -> Mock:
            return remaining.pop(0)

        def __exit__(self, *_args: object) -> None:
            pass

    monkeypatch.setattr("app.systems.platform.notifications.worker.AuditSession", FakeAuditSession)
    monkeypatch.setattr("app.systems.platform.notifications.worker.get_engine", Mock())


class _StopAfterWait:
    def __init__(self) -> None:
        self._stopped = False

    def is_set(self) -> bool:
        return self._stopped

    def wait(self, _timeout: float) -> bool:
        self._stopped = True
        return True
