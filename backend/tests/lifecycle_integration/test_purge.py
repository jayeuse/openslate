import os
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.sandbox.lifecycle.execution as lifecycle_execution
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.exceptions import (
    LifecyclePlanDriftError,
    LifecyclePreflightError,
)
from app.systems.sandbox.lifecycle.planner import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleBlockerCode, LifecycleTargetType
from app.systems.sandbox.lifecycle.service import purge_lifecycle
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.record_triggers.models import (
    RecordTriggerAction,
    RecordTriggerCondition,
    RecordTriggerEvent,
    RecordTriggerRun,
    TriggerEventState,
)
from app.systems.sandbox.records.models import Record
from tests.lifecycle_integration.lifecycle_integration_support import (
    _close_rows,
    _item,
)
from tests.sandbox_record_triggers.support import publish_trigger

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("TEST_DATABASE_URL") is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


def test_department_purge_removes_owned_rows_and_all_incident_edges_only(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    department = _item(lifecycle_graph, "department_x")
    module = _item(lifecycle_graph, "module_x")
    field_same = _item(lifecycle_graph, "field_same")
    field_external = _item(lifecycle_graph, "field_external")
    source = _item(lifecycle_graph, "source")
    same_target = _item(lifecycle_graph, "same_target")
    deleted_target = _item(lifecycle_graph, "deleted_target")
    external_edge = _item(lifecycle_graph, "external_edge")
    external_unrelated_edge = _item(lifecycle_graph, "external_unrelated_edge")
    _close_rows(department, module, field_same, field_external, source, same_target, deleted_target)
    external_edge.is_deleted = True  # type: ignore[attr-defined]
    external_edge.deleted_at = datetime.now(UTC)  # type: ignore[attr-defined]
    integration_db.commit()

    plan = plan_lifecycle(
        integration_db, LifecycleTargetType.DEPARTMENT, department.id, "purge", None  # type: ignore[attr-defined]
    )
    assert {state.edge_id for state in plan.edge_states} == {
        lifecycle_graph[key].id  # type: ignore[attr-defined]
        for key in ("same_edge", "external_edge", "unrelated_edge")
    }
    assert not plan.blockers

    purge_lifecycle(
        integration_db, LifecycleTargetType.DEPARTMENT, department.id, None, plan=plan  # type: ignore[attr-defined]
    )

    for key in (
        "department_x",
        "module_x",
        "field_same",
        "field_external",
        "source",
        "same_target",
        "deleted_target",
        "same_edge",
        "external_edge",
        "unrelated_edge",
    ):
        value = _item(lifecycle_graph, key)
        assert integration_db.get(type(value), value.id) is None  # type: ignore[attr-defined]
    external_target = _item(lifecycle_graph, "external_target")
    assert integration_db.get(type(external_target), external_target.id) is not None  # type: ignore[attr-defined]
    assert (
        integration_db.get(type(external_unrelated_edge), external_unrelated_edge.id) is not None  # type: ignore[attr-defined]
    )


def test_module_purge_owns_fields_and_records_but_not_its_department(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    module = _item(lifecycle_graph, "module_x")
    department = _item(lifecycle_graph, "department_x")
    owned = [
        module,
        _item(lifecycle_graph, "field_same"),
        _item(lifecycle_graph, "field_external"),
        _item(lifecycle_graph, "source"),
        _item(lifecycle_graph, "same_target"),
        _item(lifecycle_graph, "deleted_target"),
    ]
    _close_rows(*owned)
    integration_db.commit()

    purge_lifecycle(integration_db, LifecycleTargetType.MODULE, module.id, None)  # type: ignore[attr-defined]

    assert integration_db.get(Module, module.id) is None  # type: ignore[attr-defined]
    assert integration_db.get(Department, department.id) is not None  # type: ignore[attr-defined]
    assert integration_db.get(Module, _item(lifecycle_graph, "module_y").id) is not None  # type: ignore[attr-defined]
    assert integration_db.get(Record, _item(lifecycle_graph, "external_target").id) is not None  # type: ignore[attr-defined]


def test_external_active_and_closed_relationship_fields_block_module_and_department_purge(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    module = _item(lifecycle_graph, "module_x")
    department = _item(lifecycle_graph, "department_x")
    external_module = _item(lifecycle_graph, "module_y")
    active_incoming = Field(
        module=external_module,
        name="Active incoming",
        type=FieldType.RELATIONSHIP,
        position=1,
        relationship_target_module_id=module.id,  # type: ignore[attr-defined]
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
    )
    closed_incoming = Field(
        module=external_module,
        name="Closed incoming",
        type=FieldType.RELATIONSHIP,
        position=2,
        relationship_target_module_id=module.id,  # type: ignore[attr-defined]
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    integration_db.add_all([active_incoming, closed_incoming])
    _close_rows(
        module,
        _item(lifecycle_graph, "field_same"),
        _item(lifecycle_graph, "field_external"),
    )
    integration_db.commit()

    for target_type, target in (
        (LifecycleTargetType.MODULE, module),
        (LifecycleTargetType.DEPARTMENT, department),
    ):
        _close_rows(target)
        integration_db.flush()
        plan = plan_lifecycle(integration_db, target_type, target.id, "purge", None)  # type: ignore[attr-defined]
        blockers = [
            blocker
            for blocker in plan.blockers
            if blocker.code is LifecycleBlockerCode.PURGE_EXTERNAL_SCHEMA_DEPENDENCY
        ]
        assert {blocker.entity_id for blocker in blockers} == {
            active_incoming.id,
            closed_incoming.id,
        }
        assert all(
            blocker.entity_type == "fields"
            and blocker.field_name in {"Active incoming", "Closed incoming"}
            and blocker.module_name == external_module.module_name  # type: ignore[attr-defined]
            and blocker.department_name == _item(lifecycle_graph, "department_y").department_name  # type: ignore[attr-defined]
            for blocker in blockers
        )
        with pytest.raises(LifecyclePreflightError):
            purge_lifecycle(integration_db, target_type, target.id, None, plan=plan)  # type: ignore[attr-defined]
        assert integration_db.get(Module, module.id) is not None  # type: ignore[attr-defined]


def test_primitive_field_purge_strips_exact_uuid_key_from_active_and_archived_records(
    integration_db: Session, primitive_field_graph: dict[str, object]
) -> None:
    field = _item(primitive_field_graph, "field")
    active = _item(primitive_field_graph, "active")
    archived = _item(primitive_field_graph, "archived")
    key = str(field.id)  # type: ignore[attr-defined]
    original_active = dict(active.data)  # type: ignore[attr-defined]
    original_archived = dict(archived.data)  # type: ignore[attr-defined]

    purge_lifecycle(integration_db, LifecycleTargetType.FIELD, field.id, None)  # type: ignore[attr-defined]

    assert integration_db.get(Field, field.id) is None  # type: ignore[attr-defined]
    assert active.data == {  # type: ignore[attr-defined]
        key_: value for key_, value in original_active.items() if key_ != key
    }
    assert archived.data == {  # type: ignore[attr-defined]
        key_: value for key_, value in original_archived.items() if key_ != key
    }
    assert active.data["keep"] == {"nested": [1, 2]}  # type: ignore[attr-defined]
    assert archived.data["keep"] == "archived"  # type: ignore[attr-defined]


def test_relationship_field_purge_deletes_active_and_closed_edges_but_preserves_records(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    field = _item(lifecycle_graph, "field_same")
    edge = _item(lifecycle_graph, "same_edge")
    unrelated_edge = _item(lifecycle_graph, "unrelated_edge")
    source = _item(lifecycle_graph, "source")
    same_target = _item(lifecycle_graph, "same_target")
    deleted_target = _item(lifecycle_graph, "deleted_target")
    _close_rows(field)
    unrelated_edge.is_deleted = True  # type: ignore[attr-defined]
    unrelated_edge.deleted_at = datetime.now(UTC)  # type: ignore[attr-defined]
    integration_db.flush()

    plan = plan_lifecycle(integration_db, LifecycleTargetType.FIELD, field.id, "purge", None)  # type: ignore[attr-defined]
    assert {state.is_deleted for state in plan.edge_states} == {False, True}
    purge_lifecycle(integration_db, LifecycleTargetType.FIELD, field.id, None, plan=plan)  # type: ignore[attr-defined]

    assert integration_db.get(Field, field.id) is None  # type: ignore[attr-defined]
    assert integration_db.get(Record, source.id) is not None  # type: ignore[attr-defined]
    assert integration_db.get(Record, same_target.id) is not None  # type: ignore[attr-defined]
    assert integration_db.get(Record, deleted_target.id) is not None  # type: ignore[attr-defined]
    assert integration_db.get(type(edge), edge.id) is None  # type: ignore[attr-defined]
    assert integration_db.get(type(unrelated_edge), unrelated_edge.id) is None  # type: ignore[attr-defined]


def test_record_purge_removes_only_incident_edges_and_preserves_other_rows(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    source = _item(lifecycle_graph, "source")
    same_edge = _item(lifecycle_graph, "same_edge")
    external_edge = _item(lifecycle_graph, "external_edge")
    unrelated_edge = _item(lifecycle_graph, "unrelated_edge")
    external_unrelated_edge = _item(lifecycle_graph, "external_unrelated_edge")
    _close_rows(source)
    external_edge.is_deleted = True  # type: ignore[attr-defined]
    external_edge.deleted_at = datetime.now(UTC)  # type: ignore[attr-defined]
    integration_db.flush()

    purge_lifecycle(integration_db, LifecycleTargetType.RECORD, source.id, None)  # type: ignore[attr-defined]

    assert integration_db.get(Record, source.id) is None  # type: ignore[attr-defined]
    assert integration_db.get(type(same_edge), same_edge.id) is None  # type: ignore[attr-defined]
    assert integration_db.get(type(external_edge), external_edge.id) is None  # type: ignore[attr-defined]
    assert integration_db.get(type(unrelated_edge), unrelated_edge.id) is not None  # type: ignore[attr-defined]
    assert integration_db.get(type(external_unrelated_edge), external_unrelated_edge.id) is not None  # type: ignore[attr-defined]


def test_record_purge_preflights_record_trigger_history(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    source = _item(lifecycle_graph, "source")
    event = RecordTriggerEvent(
        record_id=source.id,  # type: ignore[attr-defined]
        module_id=source.module_id,  # type: ignore[attr-defined]
        event_kind="record-created",
        changed_field_ids=[],
        values={},
        previous_values={},
        depth=0,
        action_budget=100,
        state=TriggerEventState.PENDING,
        next_attempt_at=datetime.now(UTC),
    )
    integration_db.add(event)
    _close_rows(source)
    integration_db.commit()

    plan = plan_lifecycle(integration_db, LifecycleTargetType.RECORD, source.id, "purge", None)  # type: ignore[attr-defined]

    assert any(
        blocker.code is LifecycleBlockerCode.PURGE_TRIGGER_DEPENDENCY
        and blocker.entity_type == "record_trigger_events"
        and blocker.entity_id == event.id
        for blocker in plan.blockers
    )
    with pytest.raises(LifecyclePreflightError):
        purge_lifecycle(integration_db, LifecycleTargetType.RECORD, source.id, None, plan=plan)  # type: ignore[attr-defined]
    assert integration_db.get(Record, source.id) is not None  # type: ignore[attr-defined]


def test_module_purge_preflights_all_record_trigger_dependencies(
    integration_db: Session,
) -> None:
    _actor, module, fields, definition = publish_trigger(integration_db)
    event = RecordTriggerEvent(
        module_id=module.id,
        scheduled_trigger_id=definition.id,
        event_kind="schedule",
        changed_field_ids=[],
        values={},
        previous_values={},
        depth=0,
        action_budget=100,
        state=TriggerEventState.PENDING,
        next_attempt_at=datetime.now(UTC),
    )
    integration_db.add(event)
    integration_db.flush()
    integration_db.add(
        RecordTriggerRun(
            event_id=event.id,
            trigger_id=definition.id,
            state="succeeded",
            details={},
        )
    )
    _close_rows(module, *fields.values())
    integration_db.commit()

    plan = plan_lifecycle(integration_db, LifecycleTargetType.MODULE, module.id, "purge", None)

    assert {
        blocker.entity_type
        for blocker in plan.blockers
        if blocker.code is LifecycleBlockerCode.PURGE_TRIGGER_DEPENDENCY
    } == {
        "record_trigger_actions",
        "record_trigger_conditions",
        "record_triggers",
        "record_trigger_events",
        "record_trigger_runs",
        "sandbox_bindings",
    }
    with pytest.raises(LifecyclePreflightError):
        purge_lifecycle(integration_db, LifecycleTargetType.MODULE, module.id, None, plan=plan)
    assert integration_db.get(Module, module.id) is not None


def test_field_purge_preflights_cross_module_trigger_references_including_closed_condition(
    integration_db: Session,
) -> None:
    _actor, module, _fields, definition = publish_trigger(integration_db)
    referenced_module = Module(
        department_id=module.department_id,
        module_name=f"Trigger references {uuid7()}",
    )
    integration_db.add(referenced_module)
    integration_db.flush()
    referenced_field = Field(
        module_id=referenced_module.id,
        name="Cross-module reference",
        type=FieldType.TEXT,
        position=0,
    )
    integration_db.add(referenced_field)
    integration_db.flush()
    condition = integration_db.scalar(
        select(RecordTriggerCondition).where(
            RecordTriggerCondition.trigger_id == definition.id
        )
    )
    action = integration_db.scalar(
        select(RecordTriggerAction).where(
            RecordTriggerAction.trigger_id == definition.id
        )
    )
    trigger_binding = integration_db.scalar(
        select(SandboxBinding).where(SandboxBinding.trigger_id == definition.id)
    )
    assert condition is not None and action is not None and trigger_binding is not None
    definition.trigger_field_id = referenced_field.id
    definition.trigger_value_field_id = referenced_field.id
    condition.field_id = referenced_field.id
    condition.value_field_id = referenced_field.id
    condition.is_deleted = True
    condition.deleted_at = datetime.now(UTC)
    action.target_field_id = referenced_field.id
    action.value_field_id = referenced_field.id
    _close_rows(referenced_field)
    integration_db.commit()

    plan = plan_lifecycle(
        integration_db, LifecycleTargetType.FIELD, referenced_field.id, "purge", None
    )

    trigger_blockers = {
        (blocker.entity_type, blocker.entity_id)
        for blocker in plan.blockers
        if blocker.code is LifecycleBlockerCode.PURGE_TRIGGER_DEPENDENCY
    }
    assert {
        ("record_triggers", definition.id),
        ("record_trigger_conditions", condition.id),
        ("record_trigger_actions", action.id),
        ("sandbox_bindings", trigger_binding.id),
    } <= trigger_blockers
    assert any(
        row.entity_type == "record_trigger_conditions"
        and row.entity_id == condition.id
        and row.is_deleted
        for row in plan.rows
    )
    with pytest.raises(LifecyclePreflightError):
        purge_lifecycle(
            integration_db, LifecycleTargetType.FIELD, referenced_field.id, None, plan=plan
        )
    assert integration_db.get(Field, referenced_field.id) is not None


def test_department_purge_preflights_its_direct_sandbox_binding(
    integration_db: Session,
) -> None:
    department = Department(department_name=f"Bound department {uuid7()}")
    integration_db.add(department)
    integration_db.flush()
    binding = SandboxBinding(
        kind="department",
        sandbox_id=f"department-{uuid7()}",
        department_id=department.id,
    )
    integration_db.add(binding)
    _close_rows(department)
    integration_db.commit()

    plan = plan_lifecycle(
        integration_db, LifecycleTargetType.DEPARTMENT, department.id, "purge", None
    )

    assert [
        (blocker.entity_type, blocker.entity_id)
        for blocker in plan.blockers
    ] == [("sandbox_bindings", binding.id)]
    with pytest.raises(LifecyclePreflightError):
        purge_lifecycle(
            integration_db, LifecycleTargetType.DEPARTMENT, department.id, None, plan=plan
        )
    assert integration_db.get(Department, department.id) is not None


def test_purge_plan_drift_aborts_without_deleting_rows(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    source = _item(lifecycle_graph, "source")
    _close_rows(source)
    integration_db.flush()
    plan = plan_lifecycle(integration_db, LifecycleTargetType.RECORD, source.id, "purge", None)  # type: ignore[attr-defined]
    source.data["drift"] = True  # type: ignore[attr-defined]
    integration_db.flush()

    with pytest.raises(LifecyclePlanDriftError):
        purge_lifecycle(integration_db, LifecycleTargetType.RECORD, source.id, None, plan=plan)  # type: ignore[attr-defined]
    assert integration_db.get(Record, source.id) is not None  # type: ignore[attr-defined]


def test_purge_is_all_or_nothing_when_a_late_flush_fails(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    source = _item(lifecycle_graph, "source")
    same_edge = _item(lifecycle_graph, "same_edge")
    _close_rows(source)
    integration_db.flush()
    original_purge = lifecycle_execution._purge_instances

    def fail_after_mutation(db: Session, plan: object) -> None:
        original_purge(db, plan)  # type: ignore[arg-type]
        raise IntegrityError("forced test failure", {}, RuntimeError("forced"))

    with patch.object(lifecycle_execution, "_purge_instances", side_effect=fail_after_mutation):
        with pytest.raises(LifecyclePreflightError):
            purge_lifecycle(integration_db, LifecycleTargetType.RECORD, source.id, None)  # type: ignore[attr-defined]

    assert integration_db.get(Record, source.id) is not None  # type: ignore[attr-defined]
    assert integration_db.get(type(same_edge), same_edge.id) is not None  # type: ignore[attr-defined]


def test_purge_writes_per_row_snapshots_under_the_request_context(
    integration_db: Session, primitive_field_graph: dict[str, object]
) -> None:
    field = _item(primitive_field_graph, "field")
    active = _item(primitive_field_graph, "active")
    archived = _item(primitive_field_graph, "archived")
    request_id = integration_db.info["audit_context"].request_id  # type: ignore[union-attr]
    before_ids = set(integration_db.scalars(select(AuditLog.id)).all())

    purge_lifecycle(integration_db, LifecycleTargetType.FIELD, field.id, None)  # type: ignore[attr-defined]

    logs = list(
        integration_db.scalars(
            select(AuditLog).where(AuditLog.id.not_in(before_ids)).order_by(AuditLog.entity_type)
        ).all()
    )
    assert {(log.entity_type, log.entity_id) for log in logs} == {
        ("fields", field.id),
        ("records", active.id),
        ("records", archived.id),
    }  # type: ignore[attr-defined]
    assert {log.request_id for log in logs} == {request_id}
    field_log = next(log for log in logs if log.entity_id == field.id)  # type: ignore[attr-defined]
    assert field_log.before is not None and field_log.after is None
    record_logs = [log for log in logs if log.entity_type == "records"]
    assert all(log.before and log.after for log in record_logs)
