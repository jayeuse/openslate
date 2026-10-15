"""Lifecycle purge key-strip planning preserves exact top-level JSON keys."""

import os
from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session

from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.planner import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleTargetType
from app.systems.sandbox.lifecycle.service import purge_lifecycle
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.lifecycle_integration.lifecycle_integration_support import (
    LifecycleGraph,
    PrimitiveFieldGraph,
    close_rows,
)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("TEST_DATABASE_URL") is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


def test_field_purge_plan_lists_only_records_with_the_top_level_key(
    integration_db: Session,
    primitive_field_graph: PrimitiveFieldGraph,
) -> None:
    field = primitive_field_graph.field
    module = primitive_field_graph.module
    active = primitive_field_graph.active
    archived = primitive_field_graph.archived
    assert isinstance(field, Field)
    assert isinstance(module, Module)
    assert isinstance(active, Record)
    assert isinstance(archived, Record)
    key = str(field.id)

    explicit_null = Record(module_id=module.id, data={key: None})
    nested_value = Record(module_id=module.id, data={key: {"nested": [1, None]}})
    key_only_nested = Record(module_id=module.id, data={"other": {"nested": key}})
    integration_db.add_all([explicit_null, nested_value, key_only_nested])
    integration_db.flush()

    plan = plan_lifecycle(integration_db, LifecycleTargetType.FIELD, field.id, "purge", None)
    repeated_plan = plan_lifecycle(
        integration_db, LifecycleTargetType.FIELD, field.id, "purge", None
    )

    assert [strip.record_id for strip in plan.key_strips] == sorted(
        [active.id, archived.id, explicit_null.id, nested_value.id]
    )
    assert all(strip.field_id == field.id for strip in plan.key_strips)
    assert all(strip.module_id == module.id and strip.key == key for strip in plan.key_strips)
    assert key_only_nested.id not in {strip.record_id for strip in plan.key_strips}
    assert plan.impact_digest == repeated_plan.impact_digest


def test_relationship_field_purge_deletes_active_and_closed_edges_but_preserves_records(
    integration_db: Session, lifecycle_graph: LifecycleGraph
) -> None:
    field = lifecycle_graph.field_same
    edge = lifecycle_graph.same_edge
    unrelated_edge = lifecycle_graph.unrelated_edge
    module = lifecycle_graph.module_x
    source = lifecycle_graph.source
    same_target = lifecycle_graph.same_target
    deleted_target = lifecycle_graph.deleted_target
    title_field = Field(module_id=module.id, name="Work order", type=FieldType.TEXT, position=2)
    integration_db.add(title_field)
    integration_db.flush()
    module.title_field_id = title_field.id
    source.data = {str(title_field.id): "Pump inspection"}
    same_target.data = {str(title_field.id): "Closed seal replacement"}
    deleted_target.data = {str(title_field.id): "Valve servicing"}
    close_rows(field, module, same_target)
    unrelated_edge.is_deleted = True
    unrelated_edge.deleted_at = datetime.now(UTC)
    integration_db.flush()

    plan = plan_lifecycle(integration_db, LifecycleTargetType.FIELD, field.id, "purge", None)
    assert {state.is_deleted for state in plan.edge_states} == {False, True}
    assert len(plan.external_impacts) == 4
    assert {
        (impact.edge_id, impact.external_record_id, impact.external_record_label)
        for impact in plan.external_impacts
    } == {
        (edge.id, source.id, "Pump inspection"),
        (edge.id, same_target.id, "Closed seal replacement"),
        (unrelated_edge.id, same_target.id, "Closed seal replacement"),
        (unrelated_edge.id, deleted_target.id, "Valve servicing"),
    }
    purge_lifecycle(integration_db, LifecycleTargetType.FIELD, field.id, None, plan=plan)

    assert integration_db.get(Field, field.id) is None
    assert integration_db.get(Record, source.id) is not None
    assert integration_db.get(Record, same_target.id) is not None
    assert integration_db.get(Record, deleted_target.id) is not None
    assert integration_db.get(type(edge), edge.id) is None
    assert integration_db.get(type(unrelated_edge), unrelated_edge.id) is None
    assert integration_db.get(Module, module.id) is module and module.is_deleted
    assert same_target.is_deleted
    for key in ("external_edge", "external_unrelated_edge"):
        survivor = getattr(lifecycle_graph, key)
        assert integration_db.get(type(survivor), survivor.id) is not None
