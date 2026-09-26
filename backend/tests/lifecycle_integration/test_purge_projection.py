"""Lifecycle purge key-strip planning preserves exact top-level JSON keys."""

import os

import pytest
from sqlalchemy.orm import Session

from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.lifecycle.planner import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleTargetType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("TEST_DATABASE_URL") is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


def test_field_purge_plan_lists_only_records_with_the_top_level_key(
    integration_db: Session,
    primitive_field_graph: dict[str, object],
) -> None:
    field = primitive_field_graph["field"]
    module = primitive_field_graph["module"]
    active = primitive_field_graph["active"]
    archived = primitive_field_graph["archived"]
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
