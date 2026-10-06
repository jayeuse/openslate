"""Trigger assignments emit only the transaction's final net change."""

import pytest
from sqlalchemy import select

from app.systems.access.users.models import UserRole
from app.systems.platform.scheduling.models import InAppNotification
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.record_triggers.execution import claim_due_events
from app.systems.sandbox.record_triggers.models import RecordTriggerAction, RecordTriggerEvent
from app.systems.sandbox.record_triggers.runner import execute_claim
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.router import create_record
from app.systems.sandbox.records.schemas import RecordCreate
from tests.rbac.support import add_user, make_group_access
from tests.sandbox_record_triggers.support import option_id, publish_trigger

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("final", ["new", "removed", "unchanged", "budget"])
@pytest.mark.parametrize("rollback", [False, True])
def test_trigger_assignment_uses_final_set_even_when_child_budget_is_exhausted(
    integration_owner_db, final, rollback
):
    db = integration_owner_db
    actor, module, fields, definition = publish_trigger(db)
    assignee = Field(
        module_id=module.id, name="Assignee", type="user", position=4, required=False, config={}
    )
    db.add(assignee)
    first, last = add_user(db, role=UserRole.MEMBER), add_user(db, role=UserRole.MEMBER)
    make_group_access(db, [first, last], db.get(Department, module.department_id), module)
    # Reuse a published definition and execute its actual durable actions.
    definition.event_kind = "record-created"
    existing = list(
        db.scalars(
            select(RecordTriggerAction).where(RecordTriggerAction.trigger_id == definition.id)
        )
    )
    for action in existing:
        db.delete(action)
    db.flush()
    db.add(
        RecordTriggerAction(
            trigger_id=definition.id,
            target_field_id=assignee.id,
            position=0,
            value_kind="literal",
            literal_value={"value": str(first.id)},
        )
    )
    db.add(
        RecordTriggerAction(
            trigger_id=definition.id,
            target_field_id=assignee.id,
            position=1,
            value_kind="literal",
            literal_value={"value": None if final == "removed" else str(last.id)},
        )
    )
    db.commit()
    data = {
        str(fields["request-number"].id): "ASSIGN-1",
        str(fields["priority"].id): option_id(fields["priority"], "High"),
        str(fields["status"].id): option_id(fields["status"], "Open"),
    }
    if final == "unchanged":
        data[str(assignee.id)] = str(last.id)
    record = create_record(RecordCreate(module_id=module.id, data=data), actor, db)
    db.commit()
    before_ids = set(
        db.scalars(
            select(InAppNotification.id).where(
                InAppNotification.kind == "record-assigned",
                InAppNotification.subject_id == record.id,
            )
        )
    )
    before = len(before_ids)
    claim = claim_due_events(db)[0]
    if final == "budget":
        db.get(RecordTriggerEvent, claim.id).action_budget = 1
    db.commit()
    assert execute_claim(db, claim)
    db.flush()
    observed = db.get(Record, record.id)
    db.refresh(observed)
    expected_value = None if final == "removed" else str(first.id if final == "budget" else last.id)
    assert observed.data[str(assignee.id)] == expected_value
    created = list(
        db.scalars(
            select(InAppNotification).where(
                InAppNotification.kind == "record-assigned",
                InAppNotification.subject_id == record.id,
            )
        )
    )
    expected = (
        [] if final in {"removed", "unchanged"} else [first.id if final == "budget" else last.id]
    )
    assert len(created) - before == len(expected)
    assert {n.recipient_id for n in created if n.id not in before_ids} == set(expected)
    if rollback:
        db.rollback()
        assert (
            len(
                list(
                    db.scalars(
                        select(InAppNotification).where(
                            InAppNotification.kind == "record-assigned",
                            InAppNotification.subject_id == record.id,
                        )
                    )
                )
            )
            == before
        )
    else:
        db.commit()
        assert not execute_claim(db, claim)
        assert len(
            list(
                db.scalars(
                    select(InAppNotification).where(
                        InAppNotification.kind == "record-assigned",
                        InAppNotification.subject_id == record.id,
                    )
                )
            )
        ) == len(created)
