"""Purge inventory for files and saved views, without external storage I/O."""

import hashlib
import json
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.comms.messages.link_models import CommsMessageRecordLink
from app.systems.openview.views.models import SavedView
from app.systems.platform.files.models import File
from app.systems.sandbox.lifecycle.access_dependencies import (
    load_group_access_purge_dependencies,
)
from app.systems.sandbox.lifecycle.board_card_dependencies import (
    load_board_card_purge_dependencies,
)
from app.systems.sandbox.lifecycle.board_record_link_dependencies import (
    load_board_record_link_purge_dependencies,
)
from app.systems.sandbox.lifecycle.chart_dependencies import load_chart_purge_dependencies
from app.systems.sandbox.lifecycle.dashboard_dependencies import (
    load_dashboard_purge_dependencies,
)
from app.systems.sandbox.lifecycle.department_board_dependencies import (
    load_department_board_purge_dependencies,
)
from app.systems.sandbox.lifecycle.design_sync import binding_identity, owned_binding
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
    TriggerEventState,
)


@dataclass(frozen=True)
class PurgeDependencies:
    rows: tuple[LifecycleRowState, ...]
    blockers: tuple[LifecycleBlocker, ...]
    ids: dict[str, tuple[UUID, ...]]


def fingerprint(values: object) -> str:
    encoded = json.dumps(values, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _owned_terminal_event(event: RecordTriggerEvent, record_ids: list[UUID]) -> bool:
    return event.record_id in record_ids and event.state in {
        TriggerEventState.SUCCEEDED,
        TriggerEventState.FAILED,
    }


def _comms_reference_blockers(
    db: Session, records: list[UUID], modules: list[UUID]
) -> list[LifecycleBlocker]:
    if not records and not modules:
        return []
    links = db.scalars(
        select(CommsMessageRecordLink).where(
            CommsMessageRecordLink.org_id == bound_organization_column(),
            or_(CommsMessageRecordLink.record_id.in_(records),
                CommsMessageRecordLink.module_id.in_(modules)),
        )
    ).all()
    # Retained links are FK dependencies even after message deletion. Report only
    # the caller's source target, never a private conversation, message or link ID.
    targets = {("records", link.record_id) if link.record_id in records
               else ("modules", link.module_id) for link in links}
    return [LifecycleBlocker(
        code=LifecycleBlockerCode.PURGE_EXTERNAL_SCHEMA_DEPENDENCY,
        entity_type=kind, entity_id=identity,
        detail=("Retained content references this source; remove those references "
                "through their supported lifecycle before purging"),
    ) for kind, identity in sorted(targets)]


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
    access_rows, group_access_ids = load_group_access_purge_dependencies(
        db, department_ids, module_ids, fingerprint
    )
    board_rows, board_blockers, department_board_ids = load_department_board_purge_dependencies(
        db, department_ids, departments_by_id, fingerprint
    )
    field_ids = [field.id for field in scope.fields]
    file_filters = []
    if record_ids:
        file_filters.append(File.record_id.in_(record_ids))
    if department_ids:
        file_filters.append(File.department_id.in_(department_ids))
    files = (
        list(db.scalars(select(File).where(or_(*file_filters)).order_by(File.id)))
        if file_filters
        else []
    )
    record_link_rows, record_link_blockers, record_link_ids, record_link_board_ids = (
        load_board_record_link_purge_dependencies(db, record_ids, fingerprint)
    )
    department_owned_record_link_ids = set(department_board_ids["board_record_links"])
    department_owned_revision_link_ids = set(
        department_board_ids["board_post_revision_record_links"]
    )
    cascade_link_ids = department_owned_record_link_ids | department_owned_revision_link_ids
    record_link_rows = [row for row in record_link_rows if row.entity_id not in cascade_link_ids]
    record_link_blockers = [
        blocker for blocker in record_link_blockers if blocker.entity_id not in cascade_link_ids
    ]
    card_rows, card_ids, card_board_ids = load_board_card_purge_dependencies(
        db, record_ids, module_ids, department_board_ids["boards"], fingerprint
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
    chart_rows, chart_blockers, charts = load_chart_purge_dependencies(
        db, widget_module_ids, target_field, scope.modules, fingerprint
    )
    dashboard_rows, dashboard_blockers, dashboard_ids = load_dashboard_purge_dependencies(
        db,
        department_ids,
        widget_module_ids,
        field_ids if target is LifecycleTargetType.FIELD else [],
        target_field,
        scope.modules,
        fingerprint,
        charts,
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
                select(RecordTrigger).where(or_(*definition_filters)).order_by(RecordTrigger.id)
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
    if record_ids and event_ids:
        # A root cannot be removed while another record's history still references it.
        # Inventory and lock those dependants without expanding record ownership.
        events += list(
            db.scalars(
                select(RecordTriggerEvent)
                .where(
                    RecordTriggerEvent.root_event_id.in_(event_ids),
                    RecordTriggerEvent.id.not_in(event_ids),
                )
                .order_by(RecordTriggerEvent.id)
            )
        )
        events.sort(key=lambda event: event.id)
        event_ids = [event.id for event in events]
    events_by_id = {event.id: event for event in events}
    run_filters = []
    if definition_ids:
        run_filters.append(RecordTriggerRun.trigger_id.in_(definition_ids))
    if event_ids:
        run_filters.append(RecordTriggerRun.event_id.in_(event_ids))
    runs = (
        list(
            db.scalars(
                select(RecordTriggerRun).where(or_(*run_filters)).order_by(RecordTriggerRun.id)
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
    rows = access_rows + board_rows
    rows += record_link_rows + card_rows + report_rows + chart_rows
    blockers = board_blockers + record_link_blockers
    blockers += _comms_reference_blockers(db, record_ids, module_ids)
    blockers += report_blockers + chart_blockers
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
                    "department_id",
                    "conversation_id",
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
                    conflicting_entity_type="departments"
                    if file.department_id is not None
                    else "records",
                    conflicting_entity_id=file.department_id or file.record_id,
                )
            )
    for view in views:
        state = row_state("saved_views", view)
        state.state_fingerprint = fingerprint(
            {
                key: getattr(view, key)
                for key in ("module_id", "revision", "is_default", "name", "definition")
            }
        )
        rows.append(state)
    rows += dashboard_rows
    blockers += dashboard_blockers
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
            state = row_state(entity_type, dependency)
            removable = False
            if isinstance(dependency, RecordTriggerEvent):
                state.state_fingerprint = fingerprint(
                    {
                        key: getattr(dependency, key)
                        for key in (
                            "record_id",
                            "module_id",
                            "state",
                            "root_event_id",
                            "depth",
                            "scheduled_trigger_id",
                            "attempt_count",
                            "lease_expires_at",
                        )
                    }
                )
                removable = _owned_terminal_event(dependency, record_ids)
            elif isinstance(dependency, RecordTriggerRun):
                state.state_fingerprint = fingerprint(
                    {key: getattr(dependency, key) for key in ("event_id", "trigger_id", "state")}
                )
                event = events_by_id.get(dependency.event_id)
                removable = event is not None and _owned_terminal_event(event, record_ids)
            elif isinstance(dependency, SandboxBinding):
                state.state_fingerprint = fingerprint(binding_identity(dependency))
                removable = owned_binding(
                    dependency, set(department_ids), set(module_ids), set(field_ids)
                )
            rows.append(state)
            if removable:
                continue
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.PURGE_TRIGGER_DEPENDENCY,
                    entity_type=entity_type,
                    entity_id=dependency.id,
                    detail=(
                        "Automation work is still pending or running, or history belongs "
                        "to another record that depends on this item"
                        if target is LifecycleTargetType.RECORD
                        else "Remove the record trigger configuration or execution history "
                        "that references this item before purging it"
                    ),
                )
            )
    return PurgeDependencies(
        tuple(rows),
        tuple(blockers),
        {
            "group_access": group_access_ids,
            **department_board_ids,
            "boards": tuple(
                sorted(
                    set(department_board_ids["boards"]) | record_link_board_ids | card_board_ids
                )
            ),
            **{
                key: tuple(sorted(set(department_board_ids[key]) | set(card_ids[key])))
                for key in card_ids
            },
            **record_link_ids,
            "board_record_links": tuple(
                sorted(
                    set(department_board_ids["board_record_links"])
                    | set(record_link_ids["board_record_links"])
                )
            ),
            "board_post_revision_record_links": tuple(
                sorted(
                    set(department_board_ids["board_post_revision_record_links"])
                    | set(record_link_ids["board_post_revision_record_links"])
                )
            ),
            **report_ids,
            **dashboard_ids,
            "charts": tuple(charts),
            "files": tuple(file.id for file in files),
            "saved_views": tuple(view.id for view in views),
            "record_triggers": tuple(definition.id for definition in definitions),
            "record_trigger_conditions": tuple(condition.id for condition in conditions),
            "record_trigger_actions": tuple(action.id for action in actions),
            "record_trigger_events": tuple(event.id for event in events),
            "record_trigger_runs": tuple(run.id for run in runs),
            "sandbox_bindings": tuple(binding.id for binding in bindings),
        },
    )
