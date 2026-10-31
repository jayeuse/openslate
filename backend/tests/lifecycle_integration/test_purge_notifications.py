"""A purge removes the notifications about the records it deletes for good (DBI-6)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.platform.scheduling.models import InAppNotification, NotificationKind
from app.systems.sandbox.lifecycle.planner import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleTargetType
from app.systems.sandbox.lifecycle.service import purge_lifecycle
from app.systems.sandbox.records.models import Record
from tests.conftest import create_member
from tests.lifecycle_integration.lifecycle_integration_support import (
    LifecycleGraph,
    close_rows,
)
from tests.rbac.support import organization

pytestmark = pytest.mark.integration


def _assigned(db: Session, record: Record, recipient_id) -> InAppNotification:
    notification = InAppNotification(
        org_id=record.org_id,
        recipient_id=recipient_id,
        kind=NotificationKind.RECORD_ASSIGNED,
        subject_type="record",
        subject_id=record.id,
    )
    db.add(notification)
    return notification


def _close_target(graph: LifecycleGraph, target: LifecycleTargetType):
    module_rows = (
        graph.field_same, graph.field_external, graph.source, graph.same_target,
        graph.deleted_target,
    )
    if target is LifecycleTargetType.RECORD:
        close_rows(graph.source)
        return graph.source.id
    if target is LifecycleTargetType.MODULE:
        close_rows(graph.module_x, *module_rows)
        return graph.module_x.id
    close_rows(graph.department_x, graph.module_x, *module_rows)
    graph.external_edge.is_deleted = True
    graph.external_edge.deleted_at = datetime.now(UTC)
    return graph.department_x.id


@pytest.mark.parametrize(
    "target",
    [LifecycleTargetType.RECORD, LifecycleTargetType.MODULE, LifecycleTargetType.DEPARTMENT],
)
def test_purge_removes_notifications_about_the_purged_records_only(
    integration_db: Session, lifecycle_graph: LifecycleGraph, target: LifecycleTargetType
) -> None:
    # Development data on 2026-10-31: 23 record-assigned notifications pointed at records
    # that a purge had removed, because the purge removed only scheduled-work notices.
    db = integration_db
    recipient, _ = create_member(db, organization(db))
    purged = _assigned(db, lifecycle_graph.source, recipient.id)
    kept = _assigned(db, lifecycle_graph.external_target, recipient.id)
    target_id = _close_target(lifecycle_graph, target)
    # Committing expires the rows, so the plan reads the timestamps the database set.
    db.commit()

    plan = plan_lifecycle(db, target, target_id, "purge", None)
    planned = {(row.entity_type, row.entity_id) for row in plan.rows}
    assert ("in_app_notifications", purged.id) in planned
    assert ("in_app_notifications", kept.id) not in planned

    purge_lifecycle(db, target, target_id, None, plan=plan)

    assert db.get(InAppNotification, purged.id) is None
    assert db.get(InAppNotification, kept.id) is not None
    assert db.scalar(
        select(AuditLog.id).where(
            AuditLog.entity_type == "in_app_notifications",
            AuditLog.entity_id == purged.id,
            AuditLog.action == AuditAction.DELETE,
        )
    ) is not None
