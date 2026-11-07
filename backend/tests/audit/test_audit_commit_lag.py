"""The commit lag log that sets the seal delay (contract question 5, S12)."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import Group
from app.systems.manage.audit import listeners
from tests.rbac.support import organization

pytestmark = pytest.mark.integration


def test_a_long_audited_transaction_logs_its_lag_and_a_short_or_rolled_back_one_does_not(
    integration_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = SimpleNamespace(now=datetime(2026, 11, 7, 12, tzinfo=UTC))
    monkeypatch.setattr(listeners, "utc_now", lambda: clock.now)
    logger = Mock()
    monkeypatch.setattr(listeners, "log_event", logger)
    org_id = organization(integration_db).id

    def audited_change(held: timedelta, *, commit: bool = True) -> list[tuple[str, str, int]]:
        logger.reset_mock()
        integration_db.add(Group(org_id=org_id, name=f"Lag {uuid7().hex}"))
        integration_db.flush()
        clock.now += held
        if commit:
            integration_db.commit()
        else:
            integration_db.rollback()
        return [
            (call.args[0], call.kwargs["reason_code"], call.kwargs["age_ms"])
            for call in logger.call_args_list
        ]

    assert audited_change(timedelta(seconds=15)) == [
        ("worker_metrics", "audit_commit_lag", 15_000)
    ]
    assert audited_change(timedelta(seconds=1)) == []
    assert audited_change(timedelta(seconds=30), commit=False) == []
    # The rolled-back transaction's start does not carry over to the next one.
    assert audited_change(timedelta(0)) == []
    assert audited_change(timedelta(hours=2)) == [
        ("worker_metrics", "audit_commit_lag", 7_200_000),
        ("operational_attention", "audit_commit_after_seal_delay", 7_200_000),
    ]
