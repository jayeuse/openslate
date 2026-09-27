"""Purge inventory for files and saved views, without external storage I/O."""

import hashlib
import json
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.systems.boards.models import Board
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.openview.views.models import SavedView, SavedViewDefault
from app.systems.platform.files.models import File
from app.systems.sandbox.lifecycle.board_announcement_dependencies import (
    load_announcement_purge_dependencies,
)
from app.systems.sandbox.lifecycle.board_event_dependencies import (
    load_board_event_purge_dependencies,
)
from app.systems.sandbox.lifecycle.board_placement_dependencies import (
    load_board_placement_purge_dependencies,
)
from app.systems.sandbox.lifecycle.board_record_link_dependencies import (
    load_board_record_link_purge_dependencies,
)
from app.systems.sandbox.lifecycle.board_widget_dependencies import (
    load_board_widget_purge_dependencies,
)
from app.systems.sandbox.lifecycle.membership_dependencies import (
    load_membership_purge_dependencies,
)
from app.systems.sandbox.lifecycle.planning_scope import LifecycleScope, row_state
from app.systems.sandbox.lifecycle.report_dependencies import load_report_purge_dependencies
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
    LifecycleTargetType,
)
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerCondition,
    RecordTriggerEvent,
    RecordTriggerRun,
)


@dataclass(frozen=True)
class PurgeDependencies:
    rows: tuple[LifecycleRowState, ...]
    blockers: tuple[LifecycleBlocker, ...]
    ids: dict[str, tuple[UUID, ...]]


def fingerprint(values: object) -> str:
    encoded = json.dumps(values, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _widget_references_field(config: dict[str, object], field_ids: set[str]) -> bool:
    query = config.get("query")
    if not isinstance(query, dict):
        return False
    references: list[object] = [query.get(key) for key in ("dimension", "date_field", "measure")]
    definition = query.get("definition")
    if isinstance(definition, dict):
        for key in ("columns", "filters", "sort", "search_fields"):
            entries = definition.get(key)
            if isinstance(entries, list):
                references.extend(entries)
    return any(
        isinstance(reference, dict)
        and isinstance(reference.get("field_id"), str)
        and reference["field_id"] in field_ids
        for reference in references
    )


def load_purge_dependencies(
    db: Session, scope: LifecycleScope, target: LifecycleTargetType
) -> PurgeDependencies:
    record_ids = [record.id for record in scope.records]
    module_ids = (
        [module.id for module in scope.modules]
        if target in {LifecycleTargetType.DEPARTMENT, LifecycleTargetType.MODULE}
        else []
    )
    department_ids = (
        [department.id for department in scope.departments]
        if target is LifecycleTargetType.DEPARTMENT
        else []
    )
    departments_by_id = {department.id: department for department in scope.departments}
    membership_rows, membership_blockers, membership_ids = load_membership_purge_dependencies(
        db, department_ids, departments_by_id, fingerprint
    )
    boards = (
        list(
            db.scalars(
                select(Board).where(Board.department_id.in_(department_ids)).order_by(Board.id)
            )
        )
        if department_ids
        else []
    )
    board_event_rows, board_event_blockers, board_event_ids = load_board_event_purge_dependencies(
        db, department_ids, departments_by_id, fingerprint
    )
    announcement_rows, announcement_blockers, announcement_ids = (
        load_announcement_purge_dependencies(db, department_ids, departments_by_id, fingerprint)
    )
    field_ids = [field.id for field in scope.fields]
    files = (
        list(db.scalars(select(File).where(File.record_id.in_(record_ids)).order_by(File.id)))
        if record_ids
        else []
    )
    placement_rows, placement_blockers, placement_ids, placement_board_ids = (
        load_board_placement_purge_dependencies(db, record_ids, fingerprint)
    )
    record_link_rows, record_link_blockers, record_link_ids, record_link_board_ids = (
        load_board_record_link_purge_dependencies(db, record_ids, fingerprint)
    )
    report_rows, report_blockers, report_ids = load_report_purge_dependencies(
        db, module_ids, record_ids, fingerprint
    )
    views = (
        list(
            db.scalars(
                select(SavedView).where(SavedView.module_id.in_(module_ids)).order_by(SavedView.id)
            )
        )
        if module_ids
        else []
    )
    widget_module_ids = (
        [field.module_id for field in scope.fields]
        if target is LifecycleTargetType.FIELD
        else module_ids
    )
    target_field = scope.fields[0] if target is LifecycleTargetType.FIELD and scope.fields else None
    board_widget_rows, board_widget_blockers, board_widget_ids = (
        load_board_widget_purge_dependencies(db, widget_module_ids, target_field, fingerprint)
    )
    dashboard_widgets = (
        list(
            db.scalars(
                select(DashboardWidget)
                .where(
                    DashboardWidget.config["query"]["module_id"]
                    .as_string()
                    .in_([str(module_id) for module_id in widget_module_ids])
                )
                .order_by(DashboardWidget.id)
            ).all()
        )
        if widget_module_ids
        else []
    )
    if target is LifecycleTargetType.FIELD:
        field_ids_as_text = {str(field_id) for field_id in field_ids}
        dashboard_widgets = [
            widget
            for widget in dashboard_widgets
            if _widget_references_field(widget.config, field_ids_as_text)
        ]
    dashboard_ids = sorted({widget.dashboard_id for widget in dashboard_widgets})
    dashboards = (
        list(
            db.scalars(
                select(Dashboard).where(Dashboard.id.in_(dashboard_ids)).order_by(Dashboard.id)
            ).all()
        )
        if dashboard_ids
        else []
    )
    view_ids = [view.id for view in views]
    view_defaults = (
        list(
            db.scalars(
                select(SavedViewDefault)
                .where(SavedViewDefault.view_id.in_(view_ids))
                .order_by(SavedViewDefault.id)
            )
        )
        if view_ids
        else []
    )
    definition_filters = []
    if module_ids:
        definition_filters.append(RecordTrigger.module_id.in_(module_ids))
    if field_ids:
        definition_filters.extend(
            (
                RecordTrigger.trigger_field_id.in_(field_ids),
                RecordTrigger.trigger_value_field_id.in_(field_ids),
            )
        )
    definitions = (
        list(
            db.scalars(
                select(RecordTrigger)
                .where(or_(*definition_filters))
                .order_by(RecordTrigger.id)
            )
        )
        if definition_filters
        else []
    )
    definition_ids = [definition.id for definition in definitions]
    action_filters = []
    condition_filters = []
    if definition_ids:
        action_filters.append(RecordTriggerAction.trigger_id.in_(definition_ids))
        condition_filters.append(RecordTriggerCondition.trigger_id.in_(definition_ids))
    if field_ids:
        action_filters.extend(
            (
                RecordTriggerAction.target_field_id.in_(field_ids),
                RecordTriggerAction.value_field_id.in_(field_ids),
            )
        )
        condition_filters.extend(
            (
                RecordTriggerCondition.field_id.in_(field_ids),
                RecordTriggerCondition.value_field_id.in_(field_ids),
            )
        )
    actions = (
        list(
            db.scalars(
                select(RecordTriggerAction)
                .where(or_(*action_filters))
                .order_by(RecordTriggerAction.id)
            )
        )
        if action_filters
        else []
    )
    conditions = (
        list(
            db.scalars(
                select(RecordTriggerCondition)
                .where(or_(*condition_filters))
                .order_by(RecordTriggerCondition.id)
            )
        )
        if condition_filters
        else []
    )
    event_filters = []
    if record_ids:
        event_filters.append(RecordTriggerEvent.record_id.in_(record_ids))
    if module_ids:
        event_filters.append(RecordTriggerEvent.module_id.in_(module_ids))
    if definition_ids:
        event_filters.append(RecordTriggerEvent.scheduled_trigger_id.in_(definition_ids))
    events = (
        list(
            db.scalars(
                select(RecordTriggerEvent)
                .where(or_(*event_filters))
                .order_by(RecordTriggerEvent.id)
            )
        )
        if event_filters
        else []
    )
    event_ids = [event.id for event in events]
    run_filters = []
    if definition_ids:
        run_filters.append(RecordTriggerRun.trigger_id.in_(definition_ids))
    if event_ids:
        run_filters.append(RecordTriggerRun.event_id.in_(event_ids))
    runs = (
        list(
            db.scalars(
                select(RecordTriggerRun)
                .where(or_(*run_filters))
                .order_by(RecordTriggerRun.id)
            )
        )
        if run_filters
        else []
    )
    binding_filters = []
    if department_ids:
        binding_filters.append(SandboxBinding.department_id.in_(department_ids))
    if module_ids:
        binding_filters.append(SandboxBinding.module_id.in_(module_ids))
    if field_ids:
        binding_filters.append(SandboxBinding.field_id.in_(field_ids))
    if definition_ids:
        binding_filters.append(SandboxBinding.trigger_id.in_(definition_ids))
    bindings = (
        list(
            db.scalars(
                select(SandboxBinding).where(or_(*binding_filters)).order_by(SandboxBinding.id)
            )
        )
        if binding_filters
        else []
    )
    rows = membership_rows + board_event_rows + announcement_rows + placement_rows
    rows += record_link_rows + report_rows + board_widget_rows
    blockers = membership_blockers + board_event_blockers + announcement_blockers
    blockers += placement_blockers + record_link_blockers
    blockers += report_blockers + board_widget_blockers
    for file in files:
        state = row_state("files", file)
        state.byte_count = file.actual_size or file.expected_size
        state.state_fingerprint = fingerprint(
            {
                key: getattr(file, key)
                for key in (
                    "state",
                    "purpose",
                    "record_id",
                    "actual_size",
                    "expected_size",
                    "digest",
                    "operation_id",
                    "operation_expires_at",
                    "object_key",
                )
            }
        )
        rows.append(state)
        if file.state != "purged":
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.PURGE_FILE_DEPENDENCY,
                    entity_type="files",
                    entity_id=file.id,
                    detail=(
                        "Purge the attached file and confirm object deletion "
                        "before purging its parent"
                    ),
                    conflicting_entity_type="records",
                    conflicting_entity_id=file.record_id,
                )
            )
    for view in views:
        state = row_state("saved_views", view)
        state.state_fingerprint = fingerprint(
            {
                key: getattr(view, key)
                for key in ("module_id", "owner_id", "revision", "visibility", "name", "definition")
            }
        )
        rows.append(state)
    dashboards_by_id = {dashboard.id: dashboard for dashboard in dashboards}
    modules_by_id = {str(module.id): module for module in scope.modules}
    source_label = f"Field {target_field.name!r}" if target_field is not None else "the Module"
    for dashboard in dashboards:
        state = row_state("dashboards", dashboard)
        state.state_fingerprint = fingerprint(
            {
                "owner_id": dashboard.owner_id,
                "name": dashboard.name,
                "revision": dashboard.revision,
            }
        )
        rows.append(state)
    for widget in dashboard_widgets:
        state = row_state("dashboard_widgets", widget)
        state.state_fingerprint = fingerprint(
            {
                "dashboard_id": widget.dashboard_id,
                "position": widget.position,
                "widget_type": widget.widget_type,
                "config": widget.config,
            }
        )
        rows.append(state)
        widget_dashboard = dashboards_by_id.get(widget.dashboard_id)
        query_config = widget.config.get("query")
        module_id = query_config.get("module_id") if isinstance(query_config, dict) else None
        module = modules_by_id.get(module_id) if isinstance(module_id, str) else None
        dashboard_name = widget_dashboard.name if widget_dashboard is not None else ""
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_DASHBOARD_DEPENDENCY,
                entity_type="dashboard_widgets",
                entity_id=widget.id,
                detail=(
                    f"Remove or update the saved query in Dashboard {dashboard_name!r} before "
                    f"purging {source_label}; purge will not delete the Dashboard or its "
                    "other widgets"
                ),
                conflicting_entity_type="dashboards",
                conflicting_entity_id=widget.dashboard_id,
                field_id=target_field.id if target_field is not None else None,
                field_name=target_field.name if target_field is not None else None,
                module_id=module.id if module is not None else None,
                module_name=module.module_name if module is not None else None,
            )
        )
    for default in view_defaults:
        state = row_state("saved_view_defaults", default)
        state.state_fingerprint = fingerprint(
            {key: getattr(default, key) for key in ("user_id", "module_id", "view_id")}
        )
        rows.append(state)
    for board in boards:
        state = row_state("boards", board)
        state.state_fingerprint = fingerprint(
            {
                key: getattr(board, key)
                for key in (
                    "department_id",
                    "owner_id",
                    "name",
                    "description",
                    "status",
                    "default_section",
                    "revision",
                )
            }
        )
        rows.append(state)
        department = (
            departments_by_id.get(board.department_id) if board.department_id is not None else None
        )
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY,
                entity_type="boards",
                entity_id=board.id,
                detail=(
                    "Reassign or clear this Board's Department assignment before purging the "
                    "Department; this operation will not delete the Board or its grants"
                ),
                conflicting_entity_type="departments",
                conflicting_entity_id=board.department_id,
                department_id=board.department_id,
                department_name=(department.department_name if department is not None else None),
            )
        )
    trigger_dependencies = (
        ("record_triggers", definitions),
        ("record_trigger_conditions", conditions),
        ("record_trigger_actions", actions),
        ("record_trigger_events", events),
        ("record_trigger_runs", runs),
        ("sandbox_bindings", bindings),
    )
    for entity_type, dependencies in trigger_dependencies:
        for dependency in dependencies:
            rows.append(row_state(entity_type, dependency))
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.PURGE_TRIGGER_DEPENDENCY,
                    entity_type=entity_type,
                    entity_id=dependency.id,
                    detail=(
                        "Remove the record trigger configuration or execution history "
                        "that references this item before purging it"
                    ),
                )
            )
    return PurgeDependencies(
        tuple(rows),
        tuple(blockers),
        {
            "user_departments": membership_ids,
            "boards": tuple(
                sorted(
                    {board.id for board in boards}
                    | placement_board_ids
                    | record_link_board_ids
                    | set(board_widget_ids["boards"])
                    | set(board_event_ids["boards"])
                    | set(announcement_ids["boards"])
                )
            ),
            "board_events": board_event_ids["board_events"],
            "board_announcements": announcement_ids["board_announcements"],
            "board_announcement_revisions": announcement_ids["board_announcement_revisions"],
            "board_record_placements": placement_ids,
            **record_link_ids,
            "board_widgets": board_widget_ids["board_widgets"],
            **report_ids,
            "dashboards": tuple(dashboard.id for dashboard in dashboards),
            "dashboard_widgets": tuple(widget.id for widget in dashboard_widgets),
            "files": tuple(file.id for file in files),
            "saved_views": tuple(view.id for view in views),
            "saved_view_defaults": tuple(default.id for default in view_defaults),
            "record_triggers": tuple(definition.id for definition in definitions),
            "record_trigger_conditions": tuple(condition.id for condition in conditions),
            "record_trigger_actions": tuple(action.id for action in actions),
            "record_trigger_events": tuple(event.id for event in events),
            "record_trigger_runs": tuple(run.id for run in runs),
            "sandbox_bindings": tuple(binding.id for binding in bindings),
        },
    )
