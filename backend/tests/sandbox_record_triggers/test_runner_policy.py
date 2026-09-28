"""Record triggers run as the workspace, not as their publisher."""

from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.sandbox.record_triggers.runner as runner
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.sandbox.record_triggers.execution import ClaimedTriggerEvent
from app.systems.sandbox.record_triggers.models import TriggerEventState


def _claimed_event(claim: ClaimedTriggerEvent) -> SimpleNamespace:
    return SimpleNamespace(
        id=claim.id,
        module_id=uuid7(),
        event_kind="record-created",
        root_event_id=None,
        schedule_cursor_record_id=None,
        schedule_matched_count=0,
        schedule_action_count=0,
        action_budget=100,
        state=TriggerEventState.RUNNING,
        lease_token=claim.lease_token,
        lease_expires_at=object(),
    )


def test_trigger_applies_as_the_workspace_without_a_publisher_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.info = {}
    # A publisher lookup would find no eligible publisher for this trigger.
    db.execute.return_value.all.return_value = []
    claim = ClaimedTriggerEvent(id=uuid7(), lease_token=uuid7())
    event = _claimed_event(claim)
    definition = SimpleNamespace(
        id=uuid7(), publisher_id=uuid7(), name="Escalate overdue requests"
    )
    contexts: list[AuditContext] = []
    finished: list[str] = []
    steps: list[str] = []

    def lock_claim(_db: Session, _claim: ClaimedTriggerEvent) -> SimpleNamespace:
        steps.append("claim-lock")
        return event

    def lock_fields(_db: Session, _module_id: UUID) -> dict[UUID, Any]:
        steps.append("field-lock")
        return {}

    def records(_db: Session, _event: object) -> tuple[list[Any], bool]:
        steps.append("record-lock")
        return [], False

    def definitions(*_args: object) -> list[SimpleNamespace]:
        steps.append("definition-lock")
        return [definition]

    def apply(db: Session, *_args: object) -> tuple[int, int]:
        contexts.append(db.info[AUDIT_CONTEXT_KEY])
        return 1, 1

    monkeypatch.setattr(runner, "locked_claim", lock_claim)
    monkeypatch.setattr(runner, "_locked_root", Mock(return_value=event))
    monkeypatch.setattr(runner, "_lock_module_fields", lock_fields)
    monkeypatch.setattr(runner, "_records", records)
    monkeypatch.setattr(runner, "_definitions", definitions)
    monkeypatch.setattr(runner, "_trigger_matches", Mock(return_value=True))
    monkeypatch.setattr(runner, "_apply_definition", apply)
    monkeypatch.setattr(
        runner,
        "_finish_run",
        lambda _db, _event, _definition, state, _details: finished.append(state),
    )

    assert runner.execute_claim(db, claim)

    assert steps == ["claim-lock", "field-lock", "record-lock", "definition-lock"]
    assert finished == ["succeeded"]
    assert event.state == TriggerEventState.SUCCEEDED
    db.rollback.assert_not_called()
    assert len(contexts) == 1
    assert contexts[0].performed_by is None
    assert contexts[0].actor_label == "Trigger: Escalate overdue requests"
    assert contexts[0].request_method == "TRIGGER"
    assert contexts[0].request_path == f"/internal/sandbox/triggers/{definition.id}"


def test_trigger_actor_label_fits_the_audit_column() -> None:
    db = Mock(spec=Session)
    db.info = {}

    runner._set_context(db, uuid7(), "N" * 200)

    context = db.info[AUDIT_CONTEXT_KEY]
    assert context.actor_label == f"Trigger: {'N' * 200}"[:100]
    assert len(context.actor_label) == 100
