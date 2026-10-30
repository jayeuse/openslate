"""A failed Comms poll names each failed operation and its cause, never a message."""

from datetime import UTC, datetime

import pytest
from uuid6 import uuid7

from app.core.observability import failure_cause
from app.systems.comms.jobs import worker as comms_worker


def test_each_failed_comms_operation_is_named_with_its_cause_and_others_run(monkeypatch) -> None:
    # Live seven-pack run: comms_scheduling_poll_failed dropped the exception group unlogged.
    organization = uuid7()
    ran = []

    def fail_exports(*_args, **_kwargs):
        raise TimeoutError("private detail")

    monkeypatch.setattr(comms_worker, "current_worker_organization", lambda: organization)
    monkeypatch.setattr(comms_worker, "execute_due_schedules", lambda *a, **k: ran.append("s"))
    monkeypatch.setattr(comms_worker, "execute_due_exports", fail_exports)
    monkeypatch.setattr(comms_worker, "run_retention_batch", lambda *a, **k: {"failed": True})
    monkeypatch.setattr(comms_worker, "execute_due_previews", lambda *a, **k: ran.append("p"))

    with pytest.raises(ExceptionGroup) as raised:
        comms_worker.poll_comms(object(), publish=lambda _: None, now=datetime.now(UTC))

    assert ran == ["s", "p"]
    assert failure_cause(raised.value) == (
        "exports:TimeoutError,retention:retention_storage_unavailable"
    )
