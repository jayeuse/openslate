"""Record triggers run as the workspace whatever their publisher can do now."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.record_triggers.execution import (
    ClaimedTriggerEvent,
    claim_due_events,
    mark_claim_failed,
)
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerEvent,
    RecordTriggerRun,
    TriggerEventState,
)
from app.systems.sandbox.record_triggers.runner import execute_claim
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.mutation_validation import RecordValidationError
from app.systems.sandbox.records.router import create_record, update_record
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from tests.rbac.support import add_user, make_group_access
from tests.record_versions import record_version
from tests.sandbox_record_triggers.support import option_id, publish_trigger

pytestmark = pytest.mark.integration


def _triggered_trigger(
    db: Session,
) -> tuple[User, dict[str, Field], RecordTrigger, Record]:
    actor, module, fields, definition = publish_trigger(db)
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): f"REQ-POLICY-{uuid7()}",
                str(fields["priority"].id): option_id(fields["priority"], "Low"),
                str(fields["status"].id): option_id(fields["status"], "Open"),
            },
        ),
        actor,
        db,
    )
    update_record(
        record.id,
        RecordUpdate(
            data={**record.data, str(fields["priority"].id): option_id(fields["priority"], "High")}
        ),
        actor,
        db,
        if_match=record_version(db, record.id),
    )
    return actor, fields, definition, record


def _field_change_claim(db: Session) -> ClaimedTriggerEvent:
    claims = claim_due_events(db)
    for claim in claims:
        event = db.get(RecordTriggerEvent, claim.id)
        if event is not None and event.event_kind == "field-changed":
            db.commit()
            return claim
    raise AssertionError("Expected a field-changed trigger event")


def _remove_publisher_access(db: Session, actor: User, change: str) -> None:
    if change == "disabled":
        actor.status = UserStatus.DISABLED.value
    elif change == "expired":
        actor.expires_at = utc_now() - timedelta(seconds=1)
    elif change == "demoted":
        actor.role = UserRole.MEMBER.value
    else:
        raise AssertionError(change)


@pytest.mark.parametrize("change", ("disabled", "expired", "demoted"))
def test_trigger_keeps_running_after_its_publisher_loses_access(
    integration_owner_db: Session, change: str
) -> None:
    actor, fields, definition, record = _triggered_trigger(integration_owner_db)
    _remove_publisher_access(integration_owner_db, actor, change)
    integration_owner_db.commit()

    claim = _field_change_claim(integration_owner_db)
    assert execute_claim(integration_owner_db, claim)
    integration_owner_db.commit()

    record_row = integration_owner_db.get(Record, record.id)
    assert record_row is not None
    integration_owner_db.refresh(record_row)
    record = record_row
    integration_owner_db.refresh(definition)
    run = integration_owner_db.scalar(
        select(RecordTriggerRun).where(RecordTriggerRun.trigger_id == definition.id)
    )
    assert record.data[str(fields["status"].id)] == option_id(fields["status"], "In progress")
    assert record.performed_by is None
    assert definition.enabled
    assert definition.suspended_at is None
    assert run is not None and run.state == "succeeded"


def test_delayed_person_assignment_rechecks_reader_and_rolls_back_prior_action(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    actor, module, fields, definition = publish_trigger(db)

    assignee = add_user(db, "delayed-assignee", role=UserRole.MEMBER)
    make_group_access(db, [assignee], module.department, module)
    person_field = Field(
        module_id=module.id,
        name="Assignee",
        type="user",
        position=4,
        required=False,
        config={},
    )
    db.add(person_field)
    db.flush()
    db.add(
        RecordTriggerAction(
            trigger_id=definition.id,
            target_field_id=person_field.id,
            position=1,
            kind="set-field",
            value_kind="literal",
            literal_value={"value": str(assignee.id)},
        )
    )
    db.commit()

    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): f"REQ-ASSIGN-{uuid7()}",
                str(fields["priority"].id): option_id(fields["priority"], "Low"),
                str(fields["status"].id): option_id(fields["status"], "Open"),
            },
        ),
        actor,
        db,
    )
    update_record(
        record.id,
        RecordUpdate(
            data={
                **record.data,
                str(fields["priority"].id): option_id(fields["priority"], "High"),
            }
        ),
        actor,
        db,
        if_match=record_version(db, record.id),
    )
    assignee.status = UserStatus.DISABLED.value
    db.commit()

    claim = _field_change_claim(db)
    with pytest.raises(RecordValidationError, match="Record data is invalid") as invalid:
        execute_claim(db, claim)
    assert [(issue.field_id, issue.message) for issue in invalid.value.issues] == [
        (person_field.id, "User must be an active reader of this module")
    ]
    db.rollback()
    assert mark_claim_failed(db, claim) is False
    db.commit()
    record_row = db.get(Record, record.id)
    assert record_row is not None
    db.refresh(record_row)
    record = record_row
    event = db.get(RecordTriggerEvent, claim.id)
    assert event is not None and event.state == TriggerEventState.PENDING
    assert event.attempt_count == 1
    assert record.data[str(fields["status"].id)] == option_id(fields["status"], "Open")
    assert str(person_field.id) not in record.data
