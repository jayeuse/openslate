import os
from collections.abc import Generator
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.lifecycle.service as lifecycle_service
from app.systems.audit.models import AuditLog
from app.systems.departments.models import Department
from app.systems.fields.models import Field, FieldType
from app.systems.lifecycle.exceptions import (
    LifecycleClosedAncestorError,
    LifecyclePlanDriftError,
    LifecyclePreflightError,
)
from app.systems.lifecycle.planner import plan_lifecycle
from app.systems.lifecycle.schemas import LifecycleBlockerCode, LifecycleTargetType
from app.systems.lifecycle.service import (
    close_lifecycle,
    purge_lifecycle,
    reopen_lifecycle,
)
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.relationships.models import RelationshipEdge

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("TEST_DATABASE_URL") is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


@pytest.fixture
def lifecycle_graph(integration_db: Session) -> Generator[dict[str, object], None, None]:
    token = str(uuid7())
    department_x = Department(department_name=f"Lifecycle X {token}")
    department_y = Department(department_name=f"Lifecycle Y {token}")
    module_x = Module(
        department=department_x,
        module_name=f"Module X {token}",
        is_schema_accepted=True,
    )
    module_y = Module(
        department=department_y,
        module_name=f"Module Y {token}",
        is_schema_accepted=True,
    )
    integration_db.add_all([department_x, department_y, module_x, module_y])
    integration_db.flush()
    field_same = Field(
        module=module_x,
        name="Same module relationship",
        type=FieldType.RELATIONSHIP,
        position=0,
        relationship_target_module_id=module_x.id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
    )
    field_external = Field(
        module=module_x,
        name="External relationship",
        type=FieldType.RELATIONSHIP,
        position=1,
        relationship_target_module_id=module_y.id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
    )
    field_y = Field(
        module=module_y,
        name="Y relationship",
        type=FieldType.RELATIONSHIP,
        position=0,
        relationship_target_module_id=module_y.id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
    )
    source = Record(module=module_x)
    same_target = Record(module=module_x)
    external_target = Record(module=module_y)
    external_other = Record(module=module_y)
    deleted_target = Record(module=module_x)
    integration_db.add_all(
        [
            field_same,
            field_external,
            field_y,
            source,
            same_target,
            external_target,
            external_other,
            deleted_target,
        ]
    )
    integration_db.flush()
    same_edge = RelationshipEdge(
        field=field_same, source_record=source, target_record=same_target
    )
    external_edge = RelationshipEdge(
        field=field_external, source_record=source, target_record=external_target
    )
    unrelated_edge = RelationshipEdge(
        field=field_same, source_record=same_target, target_record=deleted_target
    )
    external_unrelated_edge = RelationshipEdge(
        field=field_y, source_record=external_target, target_record=external_other
    )
    integration_db.add_all([same_edge, external_edge, unrelated_edge, external_unrelated_edge])
    integration_db.flush()
    # Lifecycle services commit and roll back their own transactions. Commit
    # fixture setup into the outer test transaction so operation rollbacks do
    # not erase the graph being asserted.
    integration_db.commit()
    graph: dict[str, object] = {
        "department_x": department_x,
        "department_y": department_y,
        "module_x": module_x,
        "module_y": module_y,
        "field_same": field_same,
        "field_external": field_external,
        "field_y": field_y,
        "source": source,
        "same_target": same_target,
        "external_target": external_target,
        "external_other": external_other,
        "deleted_target": deleted_target,
        "same_edge": same_edge,
        "external_edge": external_edge,
        "unrelated_edge": unrelated_edge,
        "external_unrelated_edge": external_unrelated_edge,
    }
    yield graph


def _item(graph: dict[str, object], key: str) -> object:
    return graph[key]


@pytest.fixture
def primitive_field_graph(integration_db: Session) -> Generator[dict[str, object], None, None]:
    token = str(uuid7())
    department = Department(department_name=f"Primitive purge {token}")
    module = Module(department=department, module_name=f"Primitive module {token}")
    field = Field(module=module, name="Retired primitive", type=FieldType.TEXT, position=0)
    integration_db.add_all([department, module, field])
    integration_db.flush()
    field_key = str(field.id)
    active = Record(module=module, data={"keep": {"nested": [1, 2]}, field_key: "active"})
    archived = Record(
        module=module,
        data={"keep": "archived", field_key: {"preserve": True}},
        is_deleted=True,
    )
    integration_db.add_all([active, archived])
    integration_db.flush()
    field.is_deleted = True
    field.deleted_at = datetime.now(UTC)
    integration_db.commit()
    graph = {
        "department": department,
        "module": module,
        "field": field,
        "active": active,
        "archived": archived,
    }
    yield graph


def _close_rows(*rows: object) -> None:
    timestamp = datetime.now(UTC)
    for row in rows:
        row.is_deleted = True  # type: ignore[attr-defined]
        row.deleted_at = timestamp  # type: ignore[attr-defined]


def test_department_close_cascades_only_owned_rows_and_commits_once(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    department_x = _item(lifecycle_graph, "department_x")
    department_y = _item(lifecycle_graph, "department_y")
    module_x = _item(lifecycle_graph, "module_x")
    module_y = _item(lifecycle_graph, "module_y")
    field_y = _item(lifecycle_graph, "field_y")
    external_edge = _item(lifecycle_graph, "external_edge")

    with patch.object(integration_db, "commit", wraps=integration_db.commit) as commit:
        result = close_lifecycle(
            integration_db,
            LifecycleTargetType.DEPARTMENT,
            department_x.id,  # type: ignore[attr-defined]
            None,
        )

    assert commit.call_count == 1
    assert all(row.is_deleted is False for row in result.rows)
    assert department_x.is_deleted is True  # type: ignore[attr-defined]
    assert module_x.is_deleted is True  # type: ignore[attr-defined]
    assert module_y.is_deleted is False  # type: ignore[attr-defined]
    assert field_y.is_deleted is False  # type: ignore[attr-defined]
    assert external_edge.is_deleted is False  # type: ignore[attr-defined]
    assert department_y.is_deleted is False  # type: ignore[attr-defined]


def test_field_close_reports_same_module_records_and_department_label(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    field = _item(lifecycle_graph, "field_same")
    module = _item(lifecycle_graph, "module_x")
    result = close_lifecycle(
        integration_db, LifecycleTargetType.FIELD, field.id, None  # type: ignore[attr-defined]
    )

    assert [row.entity_type for row in result.rows] == ["fields"]
    assert len(result.external_impacts) == 4
    assert {impact.external_module_id for impact in result.external_impacts} == {module.id}  # type: ignore[attr-defined]
    assert {
        impact.external_department_name for impact in result.external_impacts
    } == {lifecycle_graph["department_x"].department_name}  # type: ignore[attr-defined]
    assert field.is_deleted is True  # type: ignore[attr-defined]


def test_reopen_department_sweeps_independently_closed_descendants(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    department = _item(lifecycle_graph, "department_x")
    module = _item(lifecycle_graph, "module_x")
    field = _item(lifecycle_graph, "field_same")
    record = _item(lifecycle_graph, "source")
    module.is_schema_accepted = False  # valid schema does not require prior acceptance
    for row in (department, module, field, record):
        row.is_deleted = True  # type: ignore[attr-defined]
    integration_db.flush()

    result = reopen_lifecycle(
        integration_db, LifecycleTargetType.DEPARTMENT, department.id, None  # type: ignore[attr-defined]
    )

    assert {row.entity_type for row in result.rows} >= {
        "departments",
        "modules",
        "fields",
        "records",
    }
    assert all(
        row.is_deleted is False for row in (department, module, field, record)
    )  # type: ignore[attr-defined]


def test_plan_drift_rolls_back_without_closing_rows(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    department = _item(lifecycle_graph, "department_x")
    module = _item(lifecycle_graph, "module_x")
    plan = plan_lifecycle(
        integration_db, LifecycleTargetType.DEPARTMENT, department.id, "close", None  # type: ignore[attr-defined]
    )
    module.module_name = f"Drifted {uuid7()}"  # type: ignore[attr-defined]
    integration_db.flush()

    with pytest.raises(LifecyclePlanDriftError), patch.object(
        integration_db, "rollback", wraps=integration_db.rollback
    ) as rollback:
        close_lifecycle(
            integration_db,
            LifecycleTargetType.DEPARTMENT,
            department.id,  # type: ignore[attr-defined]
            None,
            plan=plan,
        )

    assert rollback.call_count == 1
    assert department.is_deleted is False  # type: ignore[attr-defined]


def test_reopen_rejects_closed_nearest_ancestor_and_names_active_conflict(
    integration_db: Session, lifecycle_graph: dict[str, object]
) -> None:
    department = _item(lifecycle_graph, "department_x")
    module = _item(lifecycle_graph, "module_x")
    field = _item(lifecycle_graph, "field_same")
    module.is_deleted = True  # type: ignore[attr-defined]
    department.is_deleted = True  # type: ignore[attr-defined]
    field.is_deleted = True  # type: ignore[attr-defined]
    integration_db.flush()

    with pytest.raises(LifecycleClosedAncestorError, match="Module X"):
        reopen_lifecycle(integration_db, LifecycleTargetType.FIELD, field.id, None)  # type: ignore[attr-defined]

    department.is_deleted = False  # type: ignore[attr-defined]
    active_conflict = Module(
        department_id=department.id,  # type: ignore[attr-defined]
        module_name=module.module_name,  # type: ignore[attr-defined]
        is_schema_accepted=True,
    )
    integration_db.add(active_conflict)
    integration_db.commit()
    with pytest.raises(LifecyclePreflightError) as raised:
        reopen_lifecycle(integration_db, LifecycleTargetType.MODULE, module.id, None)  # type: ignore[attr-defined]

    blockers = raised.value.blockers
    assert any(blocker.code is LifecycleBlockerCode.MODULE_NAME_CONFLICT for blocker in blockers)
    assert any(blocker.conflicting_entity_id == active_conflict.id for blocker in blockers)
    assert module.is_deleted is True  # type: ignore[attr-defined]


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
    original_purge = lifecycle_service._purge_instances

    def fail_after_mutation(db: Session, plan: object) -> None:
        original_purge(db, plan)  # type: ignore[arg-type]
        raise IntegrityError("forced test failure", {}, RuntimeError("forced"))

    with patch.object(lifecycle_service, "_purge_instances", side_effect=fail_after_mutation):
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
