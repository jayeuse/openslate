"""Retained Board widget sources are physical-purge dependencies."""

from datetime import UTC, datetime

import pytest
from uuid6 import uuid7
from views.test_access import actor

from app.systems.boards.models import Board, BoardStatus, BoardWidget
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.exceptions import (
    LifecyclePlanDriftError,
    LifecyclePreflightError,
)
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleBlockerCode
from app.systems.sandbox.modules.models import Module


def _closed_module(db) -> Module:
    department = Department(
        department_name=f"Widget purge {uuid7().hex}",
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id,
        module_name=f"Widget source {uuid7().hex}",
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add(module)
    db.flush()
    return module


def _config(field: Field, location: str) -> dict[str, object]:
    reference = {
        "field_id": str(field.id),
        "expected_type": getattr(field.type, "value", field.type),
    }
    config: dict[str, object] = {"version": 1, "fields": [], "filters": [], "metric": None}
    if location == "fields":
        config["fields"] = [reference]
    elif location == "filters":
        config["filters"] = [{**reference, "operator": "eq", "value": "matching"}]
    else:
        config["metric"] = reference
    return config


@pytest.mark.integration
@pytest.mark.parametrize(
    ("location", "field_type"),
    [("fields", FieldType.TEXT), ("filters", FieldType.TEXT), ("metric", FieldType.NUMBER)],
)
def test_field_purge_blocks_retained_board_widget_references_and_detects_drift(
    integration_db, location: str, field_type: FieldType
) -> None:
    owner = actor(integration_db)
    module = _closed_module(integration_db)
    now = datetime.now(UTC)
    target = Field(
        module_id=module.id,
        name="Source",
        type=field_type,
        position=0,
        config={},
        is_deleted=True,
        deleted_at=now,
    )
    other = Field(
        module_id=module.id, name="Other", type=field_type, position=1, config={}
    )
    board = Board(
        owner_id=owner.id,
        name="Retained Board",
        status=BoardStatus.ARCHIVED if location == "filters" else BoardStatus.ACTIVE,
        is_deleted=location == "metric",
        deleted_at=now if location == "metric" else None,
    )
    integration_db.add_all([target, other, board])
    integration_db.flush()
    widget = BoardWidget(
        board_id=board.id,
        module_id=module.id,
        creator_id=owner.id,
        name="Source widget",
        position=0,
        widget_type="chart" if location == "metric" else "records",
        config=_config(target, location),
        audience_kind="everyone",
        is_deleted=location == "filters",
        deleted_at=now if location == "filters" else None,
    )
    integration_db.add(widget)
    integration_db.commit()

    plan = plan_lifecycle(integration_db, "field", target.id, "purge", owner.id)
    blockers = [
        item for item in plan.blockers if item.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
    ]
    assert {item.entity_id for item in blockers} == {widget.id}
    assert blockers[0].field_id == target.id
    assert blockers[0].conflicting_entity_id == board.id
    assert plan.scope_ids["board_widgets"] == (widget.id,)
    assert board.id in plan.scope_ids["boards"]
    state = next(row for row in plan.rows if row.entity_type == "board_widgets")
    assert len(state.state_fingerprint) == 64
    with pytest.raises(LifecyclePreflightError):
        execute_lifecycle(integration_db, plan)
    assert integration_db.get(Field, target.id) is not None

    widget.config = _config(other, location)
    integration_db.commit()
    with pytest.raises(LifecyclePlanDriftError):
        execute_lifecycle(integration_db, plan)
    repaired = plan_lifecycle(integration_db, "field", target.id, "purge", owner.id)
    assert repaired.impact_digest != plan.impact_digest
    assert not any(
        item.entity_id == widget.id and item.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
        for item in repaired.blockers
    )


@pytest.mark.integration
@pytest.mark.parametrize("target_type", ["module", "department"])
def test_parent_purge_blocks_archived_and_deleted_board_widgets(
    integration_db, target_type: str
) -> None:
    owner = actor(integration_db)
    module = _closed_module(integration_db)
    board = Board(owner_id=owner.id, name="Archived Board", status=BoardStatus.ARCHIVED)
    field = Field(
        module_id=module.id,
        name="Source",
        type=FieldType.TEXT,
        position=0,
        config={},
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    integration_db.add_all([board, field])
    integration_db.flush()
    now = datetime.now(UTC)
    active = BoardWidget(
        board_id=board.id,
        module_id=module.id,
        creator_id=owner.id,
        name="Archived source",
        position=0,
        widget_type="summary",
        config=_config(field, "fields"),
        audience_kind="everyone",
    )
    deleted = BoardWidget(
        board_id=board.id,
        module_id=module.id,
        creator_id=owner.id,
        name="Deleted widget",
        position=1,
        widget_type="summary",
        config={"version": 1, "fields": [], "filters": [], "metric": None},
        audience_kind="everyone",
        is_deleted=True,
        deleted_at=now,
    )
    integration_db.add_all([active, deleted])
    integration_db.commit()

    target_id = module.id if target_type == "module" else module.department_id
    plan = plan_lifecycle(integration_db, target_type, target_id, "purge", owner.id)
    blockers = [
        item for item in plan.blockers if item.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
    ]
    assert {item.entity_id for item in blockers} == {active.id, deleted.id}
    assert set(plan.scope_ids["board_widgets"]) == {active.id, deleted.id}
    assert {row.entity_id for row in plan.rows if row.entity_type == "board_widgets"} == {
        active.id,
        deleted.id,
    }
    with pytest.raises(LifecyclePreflightError):
        execute_lifecycle(integration_db, plan)
    assert integration_db.get(Module, module.id) is not None
    assert integration_db.get(Board, board.id) is not None
