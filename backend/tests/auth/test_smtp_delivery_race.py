"""Lease-ownership race coverage for local SMTP delivery."""

from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.config.settings import Settings
from app.systems.access.identity.models import ActionTokenPurpose
from app.systems.platform.notifications.models import IdentityDeliveryOutbox, OutboxState
from app.systems.platform.notifications.worker import ClaimedDelivery, SmtpOutboxWorker
from tests.config_support import settings_values


def test_obsolete_action_cannot_cancel_a_lease_reclaimed_during_validation(
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
    old_lease, new_lease = uuid7(), uuid7()
    delivery = IdentityDeliveryOutbox(
        id=uuid7(),
        action_token_id=uuid7(),
        recipient="person@example.test",
        purpose=ActionTokenPurpose.RECOVERY,
        encrypted_token="encrypted",
        state=OutboxState.SENDING,
        lease_token=old_lease,
        attempt_count=1,
    )
    db = Mock(spec=Session)
    db.get.return_value = Mock(user_id=uuid7())

    class FakeAuditSession:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def __enter__(self) -> Mock:
            return db

        def __exit__(self, *_args: object) -> None:
            pass

    worker = SmtpOutboxWorker(settings)
    send = Mock()

    def leased(_db: Session, _claim: ClaimedDelivery, *, lock: bool = False):
        if lock:
            delivery.lease_token = new_lease
            return None
        return delivery

    monkeypatch.setattr("app.systems.platform.notifications.worker.AuditSession", FakeAuditSession)
    monkeypatch.setattr(worker, "_leased_delivery", leased)
    monkeypatch.setattr(
        "app.systems.platform.notifications.worker._action_is_deliverable", lambda *_args: False
    )
    monkeypatch.setattr("app.systems.platform.notifications.worker.send_delivery_bounded", send)

    worker._deliver_claimed(ClaimedDelivery(delivery.id, old_lease))

    assert delivery.state == OutboxState.SENDING
    assert delivery.lease_token == new_lease
    db.commit.assert_not_called()
    send.assert_not_called()
