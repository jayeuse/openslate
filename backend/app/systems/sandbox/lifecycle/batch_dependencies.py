"""Purge inventory for files and saved views, without external storage I/O."""

import hashlib
import json
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.systems.openview.views.models import SavedView
from app.systems.platform.files.models import File
from app.systems.sandbox.automations.models import (
    PublishedAutomationAction,
    PublishedAutomationCondition,
    PublishedAutomationDefinition,
    PublishedAutomationEvent,
    PublishedAutomationRun,
)
from app.systems.sandbox.lifecycle.planning_scope import LifecycleScope, row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
    LifecycleTargetType,
)
from app.systems.sandbox.publications.models import SandboxBinding


@dataclass(frozen=True)
class PurgeDependencies:
    rows: tuple[LifecycleRowState, ...]
    blockers: tuple[LifecycleBlocker, ...]
    ids: dict[str, tuple[UUID, ...]]


def fingerprint(values: object) -> str:
    encoded = json.dumps(values, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


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
    field_ids = [field.id for field in scope.fields]
    files = (
        list(db.scalars(select(File).where(File.record_id.in_(record_ids)).order_by(File.id)))
        if record_ids
        else []
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
    definition_filters = []
    if module_ids:
        definition_filters.append(PublishedAutomationDefinition.module_id.in_(module_ids))
    if field_ids:
        definition_filters.extend(
            (
                PublishedAutomationDefinition.trigger_field_id.in_(field_ids),
                PublishedAutomationDefinition.trigger_value_field_id.in_(field_ids),
            )
        )
    definitions = (
        list(
            db.scalars(
                select(PublishedAutomationDefinition)
                .where(or_(*definition_filters))
                .order_by(PublishedAutomationDefinition.id)
            )
        )
        if definition_filters
        else []
    )
    definition_ids = [definition.id for definition in definitions]
    action_filters = []
    condition_filters = []
    if definition_ids:
        action_filters.append(PublishedAutomationAction.automation_id.in_(definition_ids))
        condition_filters.append(PublishedAutomationCondition.automation_id.in_(definition_ids))
    if field_ids:
        action_filters.extend(
            (
                PublishedAutomationAction.target_field_id.in_(field_ids),
                PublishedAutomationAction.value_field_id.in_(field_ids),
            )
        )
        condition_filters.extend(
            (
                PublishedAutomationCondition.field_id.in_(field_ids),
                PublishedAutomationCondition.value_field_id.in_(field_ids),
            )
        )
    actions = (
        list(
            db.scalars(
                select(PublishedAutomationAction)
                .where(or_(*action_filters))
                .order_by(PublishedAutomationAction.id)
            )
        )
        if action_filters
        else []
    )
    conditions = (
        list(
            db.scalars(
                select(PublishedAutomationCondition)
                .where(or_(*condition_filters))
                .order_by(PublishedAutomationCondition.id)
            )
        )
        if condition_filters
        else []
    )
    event_filters = []
    if record_ids:
        event_filters.append(PublishedAutomationEvent.record_id.in_(record_ids))
    if module_ids:
        event_filters.append(PublishedAutomationEvent.module_id.in_(module_ids))
    if definition_ids:
        event_filters.append(
            PublishedAutomationEvent.scheduled_automation_id.in_(definition_ids)
        )
    events = (
        list(
            db.scalars(
                select(PublishedAutomationEvent)
                .where(or_(*event_filters))
                .order_by(PublishedAutomationEvent.id)
            )
        )
        if event_filters
        else []
    )
    event_ids = [event.id for event in events]
    run_filters = []
    if definition_ids:
        run_filters.append(PublishedAutomationRun.automation_id.in_(definition_ids))
    if event_ids:
        run_filters.append(PublishedAutomationRun.event_id.in_(event_ids))
    runs = (
        list(
            db.scalars(
                select(PublishedAutomationRun)
                .where(or_(*run_filters))
                .order_by(PublishedAutomationRun.id)
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
        binding_filters.append(SandboxBinding.automation_id.in_(definition_ids))
    bindings = (
        list(
            db.scalars(
                select(SandboxBinding).where(or_(*binding_filters)).order_by(SandboxBinding.id)
            )
        )
        if binding_filters
        else []
    )
    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
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
    automation_dependencies = (
        ("published_automation_definitions", definitions),
        ("published_automation_conditions", conditions),
        ("published_automation_actions", actions),
        ("published_automation_events", events),
        ("published_automation_runs", runs),
        ("sandbox_bindings", bindings),
    )
    for entity_type, dependencies in automation_dependencies:
        for dependency in dependencies:
            rows.append(row_state(entity_type, dependency))
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.PURGE_AUTOMATION_DEPENDENCY,
                    entity_type=entity_type,
                    entity_id=dependency.id,
                    detail=(
                        "Remove the published automation configuration or execution history "
                        "that references this item before purging it"
                    ),
                )
            )
    return PurgeDependencies(
        tuple(rows),
        tuple(blockers),
        {
            "files": tuple(file.id for file in files),
            "saved_views": tuple(view.id for view in views),
            "published_automation_definitions": tuple(
                definition.id for definition in definitions
            ),
            "published_automation_conditions": tuple(condition.id for condition in conditions),
            "published_automation_actions": tuple(action.id for action in actions),
            "published_automation_events": tuple(event.id for event in events),
            "published_automation_runs": tuple(run.id for run in runs),
            "sandbox_bindings": tuple(binding.id for binding in bindings),
        },
    )
