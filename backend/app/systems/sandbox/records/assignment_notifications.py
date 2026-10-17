"""Final net-new USER-field assignments for the three actual record writers."""

from collections.abc import Iterable, Mapping
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.scope import module_reader_statement
from app.systems.access.users.models import User
from app.systems.platform.scheduling.models import InAppNotification, NotificationKind
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record


def _assignees(data: Mapping[str, object], fields: tuple[Field, ...]) -> set[UUID]:
    assigned = set()
    for field in fields:
        if field.is_deleted or FieldType(field.type) != FieldType.USER:
            continue
        value = data.get(str(field.id))
        if isinstance(value, str):
            try:
                assigned.add(UUID(value))
            except ValueError:
                continue
    return assigned


def notify_record_assignments(
    db: Session,
    record: Record,
    *,
    previous: Mapping[str, object] | None,
    fields: Iterable[Field],
) -> None:
    active_fields = tuple(fields)
    newly_assigned = _assignees(record.data, active_fields) - _assignees(
        previous or {}, active_fields
    )
    if not newly_assigned:
        return
    module = select(Module.id).where(Module.id == record.module_id)
    recipients = (
        module_reader_statement(module).where(User.id.in_(newly_assigned)).order_by(User.id)
    )
    for recipient_id in db.scalars(recipients):
        db.add(
            InAppNotification(
                org_id=record.org_id,
                recipient_id=recipient_id,
                kind=NotificationKind.RECORD_ASSIGNED,
                subject_type="record",
                subject_id=record.id,
            )
        )
