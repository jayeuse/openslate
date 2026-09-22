"""Deterministic recursion limits for automation child events."""

from unittest.mock import Mock

from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.sandbox.automations.models import (
    AutomationEventState,
    PublishedAutomationEvent,
)
from app.systems.sandbox.automations.outbox import enqueue_child_field_event
from app.systems.sandbox.records.models import Record


def test_child_events_require_a_change_depth_room_and_root_budget() -> None:
    database = Mock(spec=Session)
    module_id = uuid7()
    record = Record(id=uuid7(), module_id=module_id, data={"status": "Complete"})

    assert not enqueue_child_field_event(
        database,
        record=record,
        previous={"status": "Complete"},
        parent=_event(module_id, depth=0),
        action_budget=10,
    )
    assert not enqueue_child_field_event(
        database,
        record=record,
        previous={"status": "Open"},
        parent=_event(module_id, depth=10),
        action_budget=10,
    )
    assert not enqueue_child_field_event(
        database,
        record=record,
        previous={"status": "Open"},
        parent=_event(module_id, depth=1),
        action_budget=0,
    )
    assert enqueue_child_field_event(
        database,
        record=record,
        previous={"status": "Open"},
        parent=_event(module_id, depth=9),
        action_budget=1,
    )
    child = database.add.call_args.args[0]
    assert isinstance(child, PublishedAutomationEvent)
    assert child.depth == 10
    assert child.root_event_id is not None


def _event(module_id, *, depth: int) -> PublishedAutomationEvent:
    return PublishedAutomationEvent(
        id=uuid7(),
        module_id=module_id,
        event_kind="field-changed",
        changed_field_ids=["status"],
        values={"status": "Open"},
        previous_values={"status": "New"},
        depth=depth,
        action_budget=10,
        state=AutomationEventState.RUNNING,
        next_attempt_at=utc_now(),
    )
