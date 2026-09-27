"""Record triggers run as the workspace whatever their publisher can do now."""

from __future__ import annotations

from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.access.policy.models import (
    AccessPolicyVersion,
    AccessRule,
)
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.access.users.permissions import Capability
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.record_triggers.execution import ClaimedTriggerEvent, claim_due_events
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerEvent,
    RecordTriggerRun,
)
from app.systems.sandbox.record_triggers.runner import execute_claim
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.router import create_record, update_record
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from tests.sandbox_record_triggers.support import publish_trigger

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
                str(fields["priority"].id): "Low",
                str(fields["status"].id): "Open",
            },
        ),
        actor,
        db,
    )
    update_record(
        record.id,
        RecordUpdate(data={**record.data, str(fields["priority"].id): "High"}),
        actor,
        db,
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


def _role(db: Session, *, writes_records: bool) -> Role:
    role = Role(
        role=f"trigger-policy-{uuid7()}",
        permissions={Capability.RECORDS_WRITE.value: writes_records} if writes_records else {},
    )
    db.add(role)
    db.flush()
    return role


def _workspace_rule(
    db: Session,
    *,
    subject_kind: str,
    subject_id: UUID | None,
    decision: str,
) -> None:
    version = db.scalar(
        select(AccessPolicyVersion).where(AccessPolicyVersion.singleton_key == "workspace")
    )
    assert version is not None
    db.add(
        AccessRule(
            subject_kind=subject_kind,
            subject_id=subject_id,
            scope_kind="workspace",
            scope_id=None,
            permission_id=Capability.RECORDS_WRITE.value,
            decision=decision,
            starts_at=None,
            ends_at=None,
            locked=False,
            policy_version=version.revision,
        )
    )


def _remove_publisher_access(db: Session, actor: User, change: str) -> None:
    if change == "disabled":
        actor.status = UserStatus.DISABLED.value
    elif change == "expired":
        actor.expires_at = utc_now() - timedelta(seconds=1)
    elif change == "role-without-record-write":
        actor.role_id = _role(db, writes_records=False).id
    elif change == "workspace-deny":
        actor.role_id = _role(db, writes_records=True).id
        _workspace_rule(db, subject_kind="user", subject_id=actor.id, decision="deny")
    else:
        raise AssertionError(change)


@pytest.mark.parametrize(
    "change", ("disabled", "expired", "role-without-record-write", "workspace-deny")
)
def test_trigger_keeps_running_after_its_publisher_loses_access(
    integration_owner_db: Session, change: str
) -> None:
    actor, fields, definition, record = _triggered_trigger(integration_owner_db)
    _remove_publisher_access(integration_owner_db, actor, change)
    integration_owner_db.commit()

    claim = _field_change_claim(integration_owner_db)
    assert execute_claim(integration_owner_db, claim)
    integration_owner_db.commit()

    integration_owner_db.refresh(record)
    integration_owner_db.refresh(definition)
    run = integration_owner_db.scalar(
        select(RecordTriggerRun).where(RecordTriggerRun.trigger_id == definition.id)
    )
    assert record.data[str(fields["status"].id)] == "In progress"
    assert record.performed_by is None
    assert definition.enabled
    assert definition.suspended_at is None
    assert run is not None and run.state == "succeeded"
