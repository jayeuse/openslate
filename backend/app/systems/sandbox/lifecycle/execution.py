"""Locked lifecycle mutation execution."""

from typing import Any
from uuid import UUID

from sqlalchemy import Select, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.policy.service import get_defaults
from app.systems.access.users.models import UserDepartment
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardRecordPlacement, BoardWidget
from app.systems.manage.audit.context import set_audit_actor
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.openview.reports.models import Report, ReportRun, ReportRunRow
from app.systems.openview.views.models import SavedView, SavedViewDefault
from app.systems.platform.files.models import File
from app.systems.sandbox.automations.models import (
    PublishedAutomationAction,
    PublishedAutomationCondition,
    PublishedAutomationDefinition,
    PublishedAutomationEvent,
    PublishedAutomationRun,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
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
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge

_LOCK_MODELS: tuple[tuple[str, type[Any]], ...] = (
    ("departments", Department),
    ("user_departments", UserDepartment),
    ("boards", Board),
    ("board_announcements", BoardAnnouncement),
    ("board_announcement_revisions", BoardAnnouncementRevision),
    ("board_events", BoardEvent),
    ("board_widgets", BoardWidget),
    ("dashboards", Dashboard),
    ("dashboard_widgets", DashboardWidget),
    ("reports", Report),
    ("modules", Module),
    ("report_runs", ReportRun),
    ("fields", Field),
    ("records", Record),
    ("report_run_rows", ReportRunRow),
    ("board_record_placements", BoardRecordPlacement),
    ("relationship_edges", RelationshipEdge),
    ("files", File),
    ("saved_views", SavedView),
    ("saved_view_defaults", SavedViewDefault),
    ("published_automation_definitions", PublishedAutomationDefinition),
    ("published_automation_conditions", PublishedAutomationCondition),
    ("published_automation_actions", PublishedAutomationAction),
    ("published_automation_events", PublishedAutomationEvent),
    ("published_automation_runs", PublishedAutomationRun),
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


def _purge_instances(db: Session, plan: LifecyclePlan) -> None:
    """Physically remove a validated plan in dependency-safe audited phases."""

    model_by_table = {
        "departments": Department,
        "modules": Module,
        "fields": Field,
        "records": Record,
        "files": File,
        "saved_views": SavedView,
        "saved_view_defaults": SavedViewDefault,
    }

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

    for entity_type in (
        "files",
        "saved_view_defaults",
        "saved_views",
        "records",
        "fields",
        "modules",
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


def _execute(db: Session, plan: LifecyclePlan) -> LifecycleImpactResponse:
    if (
        plan.operation is LifecycleOperation.CLOSE
        and plan.target_type is LifecycleTargetType.DEPARTMENT
    ):
        get_defaults(db, lock=True)
    _lock_plan_scope(db, plan)
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
        if plan.operation is LifecycleOperation.PURGE:
            _purge_instances(db, current)
        else:
            timestamp = utc_now()
            instances = _transition_instances(db, current)
            for instance in instances:
                if plan.operation is LifecycleOperation.CLOSE:
                    instance.is_deleted = True
                    instance.deleted_at = timestamp
                else:
                    instance.is_deleted = False
                    instance.deleted_at = None
                # Explicit assignment keeps every changed instance on one lifecycle
                # timestamp instead of relying on SQLAlchemy's per-instance onupdate.
                instance.updated_at = timestamp
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
