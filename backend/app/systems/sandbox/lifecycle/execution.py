"""Locked lifecycle mutation execution."""

from typing import Any
from uuid import UUID

from sqlalchemy import Select, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.access.policy.models import GroupAccess
from app.systems.boards.attachment_models import BoardAttachment, BoardPostRevisionAttachment
from app.systems.boards.department_boards import sync_department_board
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGroup, BoardWidget
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.record_link_models import BoardPostRevisionRecordLink, BoardRecordLink
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.manage.audit.context import get_audit_context, set_audit_actor
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.openview.reports.models import Report, ReportRun, ReportRunRow
from app.systems.openview.views.models import SavedView
from app.systems.platform.files.models import File
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.lifecycle.design_sync import document_row, synchronize_design
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleError,
    LifecyclePlanDriftError,
    LifecyclePreflightError,
    LifecycleUnavailable,
    LifecycleUnsupportedOperation,
)
from app.systems.sandbox.lifecycle.planner import LifecyclePlan, plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleImpactResponse,
    LifecycleOperation,
    LifecycleTargetType,
)
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerCondition,
    RecordTriggerEvent,
    RecordTriggerRun,
)
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge

_LOCK_MODELS: tuple[tuple[str, type[Any]], ...] = (
    ("departments", Department),
    ("group_access", GroupAccess),
    ("boards", Board),
    ("board_groups", BoardGroup),
    ("board_widgets", BoardWidget),
    ("board_events", BoardEvent),
    ("board_event_reminders", BoardEventReminder),
    ("board_posts", BoardPost),
    ("board_attachments", BoardAttachment),
    ("board_record_links", BoardRecordLink),
    ("board_files", File),
    ("scheduled_work", ScheduledWork),
    ("in_app_notifications", InAppNotification),
    ("board_post_revisions", BoardPostRevision),
    ("board_post_revision_attachments", BoardPostRevisionAttachment),
    ("board_post_revision_record_links", BoardPostRevisionRecordLink),
    ("dashboards", Dashboard),
    ("dashboard_widgets", DashboardWidget),
    ("reports", Report),
    ("modules", Module),
    ("report_runs", ReportRun),
    ("fields", Field),
    ("records", Record),
    ("report_run_rows", ReportRunRow),
    ("relationship_edges", RelationshipEdge),
    ("files", File),
    ("saved_views", SavedView),
    ("record_triggers", RecordTrigger),
    ("record_trigger_conditions", RecordTriggerCondition),
    ("record_trigger_actions", RecordTriggerAction),
    ("record_trigger_events", RecordTriggerEvent),
    ("record_trigger_runs", RecordTriggerRun),
    ("sandbox_bindings", SandboxBinding),
)


def _lock_collection(db: Session, model: type[Any], ids: tuple[UUID, ...]) -> None:
    if not ids:
        return
    statement: Select[Any] = (
        select(model)
        .where(model.id.in_(ids))
        .order_by(model.id)
        .with_for_update(nowait=True)
        .execution_options(populate_existing=True)
    )
    try:
        locked = list(db.scalars(statement).all())
    except OperationalError as error:
        db.rollback()
        raise LifecycleUnavailable(
            "Lifecycle operation is temporarily unavailable while locking its scope"
        ) from error
    if len(locked) != len(ids):
        raise LifecycleUnavailable("Lifecycle operation scope is no longer available")


def _lock_plan_scope(db: Session, plan: LifecyclePlan) -> None:
    """Acquire the complete scope in the single canonical lock order."""

    for key, model in _LOCK_MODELS:
        _lock_collection(db, model, plan.scope_ids.get(key, ()))


def _current_plan(db: Session, plan: LifecyclePlan) -> LifecyclePlan:
    return plan_lifecycle(
        db,
        plan.target_type,
        plan.target_id,
        plan.operation,
        plan.actor_id,
    )


def _transition_instances(db: Session, plan: LifecyclePlan) -> list[Any]:
    instances: list[Any] = []
    model_by_table = {
        "departments": Department,
        "modules": Module,
        "fields": Field,
        "records": Record,
    }
    for row in plan.rows:
        model = model_by_table[row.entity_type]
        instance = db.get(model, row.entity_id)
        if instance is None:
            raise LifecycleUnavailable("Lifecycle operation row is no longer available")
        instances.append(instance)
    return instances


def _delete_department_board_children(db: Session, plan: LifecyclePlan) -> None:
    """Remove every inventoried child of a Department Board before its sources."""

    if plan.target_type is not LifecycleTargetType.DEPARTMENT:
        return

    child_models: tuple[tuple[str, type[Any]], ...] = (
        ("in_app_notifications", InAppNotification),
        ("scheduled_work", ScheduledWork),
        ("board_post_revision_attachments", BoardPostRevisionAttachment),
        ("board_post_revision_record_links", BoardPostRevisionRecordLink),
        ("board_attachments", BoardAttachment),
        ("board_record_links", BoardRecordLink),
        ("board_post_revisions", BoardPostRevision),
        ("board_groups", BoardGroup),
        ("board_widgets", BoardWidget),
        ("board_event_reminders", BoardEventReminder),
        ("board_events", BoardEvent),
        ("board_posts", BoardPost),
    )
    rows_by_type: dict[str, list[UUID]] = {}
    for row in plan.rows:
        rows_by_type.setdefault(row.entity_type, []).append(row.entity_id)

    for entity_type, model in child_models:
        for entity_id in rows_by_type.get(entity_type, ()):
            instance = db.get(model, entity_id)
            if instance is None:
                raise LifecycleUnavailable("Lifecycle operation row is no longer available")
            db.delete(instance)
        db.flush()


def _delete_record_trigger_history(db: Session, plan: LifecyclePlan) -> None:
    """Delete only validated owned completed history, in RESTRICT-FK order."""

    for run_id in plan.scope_ids.get("record_trigger_runs", ()):
        run = db.get(RecordTriggerRun, run_id)
        if run is None:
            raise LifecycleUnavailable("Lifecycle operation row is no longer available")
        db.delete(run)
    db.flush()
    events: list[RecordTriggerEvent] = []
    for event_id in plan.scope_ids.get("record_trigger_events", ()):
        event = db.get(RecordTriggerEvent, event_id)
        if event is None:
            raise LifecycleUnavailable("Lifecycle operation row is no longer available")
        events.append(event)
    for child in sorted(
        (event for event in events if event.root_event_id is not None),
        key=lambda event: (-event.depth, event.id),
    ):
        db.delete(child)
        db.flush()
    for root in (event for event in events if event.root_event_id is None):
        db.delete(root)
    db.flush()


def _record_purge_security_event(db: Session, plan: LifecyclePlan) -> None:
    context = get_audit_context(db)
    event_count = len(plan.scope_ids.get("record_trigger_events", ()))
    run_count = len(plan.scope_ids.get("record_trigger_runs", ()))
    append_security_event(
        db,
        SecurityEventIngestRequest(
            event_type="lifecycle.record_purge",
            outcome=SecurityEventOutcome.SUCCESS,
            source="lifecycle",
            actor_id=plan.actor_id,
            subject_id=plan.target_id,
            operation_id=context.request_id or uuid7(),
            request_id=context.request_id,
            request_method=context.request_method,
            request_path=context.request_path,
            metadata={
                "trigger_event_rows_removed": event_count,
                "trigger_run_rows_removed": run_count,
                "trigger_history_rows_removed": event_count + run_count,
            },
        ),
    )


def _purge_instances(db: Session, plan: LifecyclePlan) -> None:
    """Physically remove a validated plan in dependency-safe audited phases."""

    model_by_table = {
        "departments": Department,
        "modules": Module,
        "fields": Field,
        "records": Record,
        "files": File,
        "saved_views": SavedView,
        "group_access": GroupAccess,
        "dashboard_widgets": DashboardWidget,
        "dashboards": Dashboard,
        "boards": Board,
    }

    for row in plan.rows:
        if row.entity_type != "modules":
            continue
        module = db.get(Module, row.entity_id)
        if module is not None and module.title_field_id is not None:
            module.title_field_id = None
            db.flush()

    for edge_id in plan.scope_ids.get("relationship_edges", ()):
        edge = db.get(RelationshipEdge, edge_id)
        if edge is None:
            raise LifecycleUnavailable("Lifecycle operation row is no longer available")
        db.delete(edge)
        db.flush()

    for key_strip in plan.key_strips:
        record = db.get(Record, key_strip.record_id)
        if record is None:
            raise LifecycleUnavailable("Lifecycle operation row is no longer available")
        if key_strip.key in record.data:
            record.data = {key: value for key, value in record.data.items() if key != key_strip.key}
            db.flush()

    _delete_department_board_children(db, plan)
    _delete_record_trigger_history(db, plan)
    for row in plan.rows:
        if row.entity_type == "sandbox_bindings":
            binding = db.get(SandboxBinding, row.entity_id)
            if binding is None:
                raise LifecycleUnavailable("Lifecycle operation row is no longer available")
            db.delete(binding)
    db.flush()

    for entity_type in (
        "group_access",
        "files",
        "saved_views",
        "dashboard_widgets",
        "dashboards",
        "records",
        "fields",
        "modules",
        "boards",
        "departments",
    ):
        for row in plan.rows:
            if row.entity_type != entity_type:
                continue
            instance = db.get(model_by_table[entity_type], row.entity_id)
            if instance is None:
                raise LifecycleUnavailable("Lifecycle operation row is no longer available")
            db.delete(instance)
            db.flush()


def _apply_field_positions(db: Session, plan: LifecyclePlan) -> None:
    ordered_fields = {field_id: db.get(Field, field_id) for field_id in plan.field_positions}
    for field_id, field in ordered_fields.items():
        if field is None:
            raise LifecycleUnavailable("Lifecycle operation row is no longer available")
        if not field.is_deleted and field.position != plan.field_positions[field_id]:
            field.position += 10_000_000
    if ordered_fields:
        db.flush()
    for field_id, field in ordered_fields.items():
        if field is not None and field.position != plan.field_positions[field_id]:
            field.position = plan.field_positions[field_id]


def _execute(db: Session, plan: LifecyclePlan) -> LifecycleImpactResponse:
    try:
        document_row(db, lock=True)
        _lock_plan_scope(db, plan)
    except OperationalError as error:
        db.rollback()
        raise LifecycleUnavailable("Lifecycle operation is temporarily unavailable") from error
    current = _current_plan(db, plan)
    if current.impact_digest != plan.impact_digest:
        db.rollback()
        raise LifecyclePlanDriftError(
            "Lifecycle impact changed after planning; obtain a new impact plan"
        )
    if current.blockers:
        db.rollback()
        raise LifecyclePreflightError(current.blockers)

    try:
        synchronize_design(db, current)
        _apply_field_positions(db, current)
        if plan.operation is LifecycleOperation.PURGE:
            _purge_instances(db, current)
            if current.target_type is LifecycleTargetType.RECORD:
                _record_purge_security_event(db, current)
        else:
            timestamp = utc_now()
            instances = _transition_instances(db, current)
            close_operation_id = uuid7() if plan.operation is LifecycleOperation.CLOSE else None
            for instance in instances:
                if plan.operation is LifecycleOperation.CLOSE:
                    instance.is_deleted = True
                    instance.deleted_at = timestamp
                else:
                    instance.is_deleted = False
                    instance.deleted_at = None
                instance.lifecycle_close_operation_id = close_operation_id
                # Explicit assignment keeps every changed instance on one lifecycle
                # timestamp instead of relying on SQLAlchemy's per-instance onupdate.
                instance.updated_at = timestamp
            for instance in instances:
                if isinstance(instance, Department):
                    # A closed Department archives its Board; a reopen restores it,
                    # or recreates it so that an open Department always has one.
                    sync_department_board(db, instance, create=not instance.is_deleted)
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise LifecyclePreflightError(()) from error
    except OperationalError as error:
        db.rollback()
        raise LifecycleUnavailable("Lifecycle operation is temporarily unavailable") from error
    except LifecycleError:
        db.rollback()
        raise
    return current.response()


def execute_lifecycle(db: Session, plan: LifecyclePlan) -> LifecycleImpactResponse:
    """Execute an already displayed plan after locking and recomputing it."""

    if plan.actor_id is not None:
        set_audit_actor(db, plan.actor_id)
    return _execute(db, plan)


def close_lifecycle(
    db: Session,
    target_type: LifecycleTargetType | str,
    target_id: UUID,
    actor_id: UUID | None,
    *,
    plan: LifecyclePlan | None = None,
) -> LifecycleImpactResponse:
    selected = plan or plan_lifecycle(
        db, target_type, target_id, LifecycleOperation.CLOSE, actor_id
    )
    if selected.operation is not LifecycleOperation.CLOSE:
        raise LifecycleUnsupportedOperation("Close requires a close impact plan")
    return execute_lifecycle(db, selected)


def reopen_lifecycle(
    db: Session,
    target_type: LifecycleTargetType | str,
    target_id: UUID,
    actor_id: UUID | None,
    *,
    plan: LifecyclePlan | None = None,
) -> LifecycleImpactResponse:
    selected = plan or plan_lifecycle(
        db, target_type, target_id, LifecycleOperation.REOPEN, actor_id
    )
    if selected.operation is not LifecycleOperation.REOPEN:
        raise LifecycleUnsupportedOperation("Reopen requires a reopen impact plan")
    return execute_lifecycle(db, selected)


def purge_lifecycle(
    db: Session,
    target_type: LifecycleTargetType | str,
    target_id: UUID,
    actor_id: UUID | None,
    *,
    plan: LifecyclePlan | None = None,
) -> LifecycleImpactResponse:
    selected = plan or plan_lifecycle(
        db, target_type, target_id, LifecycleOperation.PURGE, actor_id
    )
    if selected.operation is not LifecycleOperation.PURGE:
        raise LifecycleUnsupportedOperation("Purge requires a purge impact plan")
    return execute_lifecycle(db, selected)


__all__ = [
    "close_lifecycle",
    "execute_lifecycle",
    "purge_lifecycle",
    "reopen_lifecycle",
]
