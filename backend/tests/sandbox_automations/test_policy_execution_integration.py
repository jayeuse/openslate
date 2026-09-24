"""Workspace-policy enforcement for durable automation execution."""

from __future__ import annotations

from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.access.policy.models import (
    AccessGroup,
    AccessGroupMember,
    AccessPolicyVersion,
    AccessRule,
)
from app.systems.access.users.models import Role, User
from app.systems.access.users.permissions import Capability
from app.systems.sandbox.automations.execution import ClaimedAutomationEvent, claim_due_events
from app.systems.sandbox.automations.models import (
    PublishedAutomationDefinition,
    PublishedAutomationEvent,
    PublishedAutomationRun,
)
from app.systems.sandbox.automations.runner import execute_claim
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.router import create_record, update_record
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from tests.sandbox_automations.support import publish_automation

pytestmark = pytest.mark.integration


def _triggered_automation(
    db: Session,
) -> tuple[User, dict[str, Field], PublishedAutomationDefinition, Record]:
    actor, module, fields, definition = publish_automation(db)
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


def _field_change_claim(db: Session) -> ClaimedAutomationEvent:
    claims = claim_due_events(db)
    for claim in claims:
        event = db.get(PublishedAutomationEvent, claim.id)
        if event is not None and event.event_kind == "field-changed":
            db.commit()
            return claim
    raise AssertionError("Expected a field-changed automation event")


def _role(db: Session, *, writes_records: bool) -> Role:
    role = Role(
        role=f"automation-policy-{uuid7()}",
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


@pytest.mark.parametrize(
    ("subject_kind", "decision", "legacy_write", "should_execute"),
    (
        ("legacy", None, True, True),
        ("everyone", "allow", False, True),
        ("group", "allow", False, True),
        ("user", "allow", False, True),
        ("everyone", "deny", True, False),
        ("group", "deny", True, False),
        ("user", "deny", True, False),
    ),
)
def test_published_automation_uses_legacy_and_workspace_policy_precedence(
    integration_owner_db: Session,
    subject_kind: str,
    decision: str | None,
    legacy_write: bool,
    should_execute: bool,
) -> None:
    actor, fields, definition, record = _triggered_automation(integration_owner_db)
    actor.role_id = _role(integration_owner_db, writes_records=legacy_write).id
    subject_id = None
    if subject_kind == "group":
        group = AccessGroup(name=f"Automation policy {uuid7()}", description="")
        integration_owner_db.add(group)
        integration_owner_db.flush()
        integration_owner_db.add(AccessGroupMember(group_id=group.id, user_id=actor.id))
        subject_id = group.id
    elif subject_kind == "user":
        subject_id = actor.id
    if decision is not None:
        _workspace_rule(
            integration_owner_db,
            subject_kind=subject_kind,
            subject_id=subject_id,
            decision=decision,
        )
    integration_owner_db.commit()

    claim = _field_change_claim(integration_owner_db)
    assert execute_claim(integration_owner_db, claim)
    integration_owner_db.commit()

    integration_owner_db.refresh(record)
    integration_owner_db.refresh(definition)
    run = integration_owner_db.scalar(
        select(PublishedAutomationRun).where(PublishedAutomationRun.automation_id == definition.id)
    )
    assert record.data[str(fields["status"].id)] == (
        "In progress" if should_execute else "Open"
    )
    assert definition.enabled is should_execute
    assert run is not None and run.state == ("succeeded" if should_execute else "suspended")


def test_workspace_deny_does_not_override_an_eligible_internal_administrator(
    integration_owner_db: Session,
) -> None:
    actor, fields, definition, record = _triggered_automation(integration_owner_db)
    _workspace_rule(
        integration_owner_db,
        subject_kind="everyone",
        subject_id=None,
        decision="deny",
    )
    integration_owner_db.commit()

    claim = _field_change_claim(integration_owner_db)
    assert execute_claim(integration_owner_db, claim)
    integration_owner_db.commit()

    integration_owner_db.refresh(record)
    integration_owner_db.refresh(definition)
    assert record.data[str(fields["status"].id)] == "In progress"
    assert definition.enabled


def test_expired_publisher_suspends_automation_before_record_mutation(
    integration_owner_db: Session,
) -> None:
    actor, fields, definition, record = _triggered_automation(integration_owner_db)
    actor.expires_at = utc_now() - timedelta(seconds=1)
    integration_owner_db.commit()

    claim = _field_change_claim(integration_owner_db)
    assert execute_claim(integration_owner_db, claim)
    integration_owner_db.commit()

    integration_owner_db.refresh(record)
    integration_owner_db.refresh(definition)
    assert record.data[str(fields["status"].id)] == "Open"
    assert not definition.enabled
    assert definition.suspension_reason == "Publisher no longer has permission to update records"
