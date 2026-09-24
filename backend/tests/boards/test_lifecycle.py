"""Department lifecycle must account for retained Board references."""

from datetime import UTC, datetime

import pytest
from uuid6 import uuid7
from views.test_access import actor

from app.systems.boards.models import Board, BoardGrant, BoardRecordPlacement, BoardStatus
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.batch_dependencies import load_purge_dependencies
from app.systems.sandbox.lifecycle.exceptions import (
    LifecyclePlanDriftError,
    LifecyclePreflightError,
)
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.planning_scope import LifecycleScope
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlockerCode,
    LifecycleTargetType,
)
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record


def test_department_inventory_tracks_board_state_and_dependency() -> None:
    now = datetime.now(UTC)
    department = Department(
        id=uuid7(),
        department_name="Retained Boards",
        is_deleted=True,
        deleted_at=now,
        updated_at=now,
    )
    board = Board(
        id=uuid7(),
        department_id=department.id,
        owner_id=uuid7(),
        name="Operations",
        description="Team guidance",
        status=BoardStatus.ARCHIVED,
        default_section="calendar",
        revision=4,
        is_deleted=True,
        deleted_at=now,
        updated_at=now,
    )

    class DependencySession:
        def scalars(self, statement):
            entity = statement.column_descriptions[0]["entity"]
            return [board] if entity is Board else []

    scope = LifecycleScope((department,), (), (), (), ())

    dependencies = load_purge_dependencies(
        DependencySession(), scope, LifecycleTargetType.DEPARTMENT  # type: ignore[arg-type]
    )

    assert dependencies.ids.get("boards") == (board.id,)
    state = next(row for row in dependencies.rows if row.entity_type == "boards")
    assert state.state_fingerprint
    blocker = next(
        item
        for item in dependencies.blockers
        if item.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
    )
    assert blocker.entity_type == "boards"
    assert blocker.entity_id == board.id
    assert blocker.department_id == department.id
    assert "reassign" in blocker.detail.casefold() or "clear" in blocker.detail.casefold()


def test_record_purge_inventory_tracks_archived_board_placement_reference() -> None:
    now = datetime.now(UTC)
    record = Record(
        id=uuid7(),
        module_id=uuid7(),
        data={},
        is_deleted=True,
        deleted_at=now,
        updated_at=now,
    )
    placement = BoardRecordPlacement(
        id=uuid7(),
        board_id=uuid7(),
        record_id=record.id,
        is_deleted=True,
        deleted_at=now,
        updated_at=now,
    )

    class DependencySession:
        def scalars(self, statement):
            entity = statement.column_descriptions[0]["entity"]
            return [placement] if entity is BoardRecordPlacement else []

        def execute(self, _statement):
            class EmptyRows:
                def all(self):
                    return []

            return EmptyRows()

    scope = LifecycleScope((), (), (), (record,), ())
    dependencies = load_purge_dependencies(
        DependencySession(), scope, LifecycleTargetType.RECORD  # type: ignore[arg-type]
    )
    assert dependencies.ids["boards"] == (placement.board_id,)
    assert dependencies.ids["board_record_placements"] == (placement.id,)
    assert any(
        blocker.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
        and blocker.entity_id == placement.id
        for blocker in dependencies.blockers
    )
    state = next(
        row for row in dependencies.rows if row.entity_type == "board_record_placements"
    )
    placement.board_id = uuid7()
    changed = load_purge_dependencies(
        DependencySession(), scope, LifecycleTargetType.RECORD  # type: ignore[arg-type]
    )
    changed_state = next(
        row for row in changed.rows if row.entity_type == "board_record_placements"
    )
    assert state.state_fingerprint != changed_state.state_fingerprint


@pytest.mark.integration
def test_record_module_and_department_purges_block_retained_board_placements(
    integration_db,
) -> None:
    now = datetime.now(UTC)
    owner = actor(integration_db)
    department = Department(
        department_name=f"Placement purge department {uuid7()}",
        is_deleted=True,
        deleted_at=now,
    )
    integration_db.add(department)
    integration_db.flush()
    module = Module(
        department_id=department.id,
        module_name="Placement purge module",
        is_deleted=True,
        deleted_at=now,
    )
    archived_board = Board(
        owner_id=owner.id,
        name="Archived shortcuts",
        status=BoardStatus.ARCHIVED,
        is_deleted=True,
        deleted_at=now,
    )
    active_board = Board(owner_id=owner.id, name="Other shortcuts")
    integration_db.add_all([module, archived_board, active_board])
    integration_db.flush()
    record = Record(
        module_id=module.id,
        data={},
        is_deleted=True,
        deleted_at=now,
    )
    integration_db.add(record)
    integration_db.flush()
    archived_placement = BoardRecordPlacement(
        board_id=archived_board.id,
        record_id=record.id,
        is_deleted=True,
        deleted_at=now,
    )
    integration_db.add(archived_placement)
    integration_db.commit()

    for target_type, target_id in (
        ("record", record.id),
        ("module", module.id),
        ("department", department.id),
    ):
        plan = plan_lifecycle(integration_db, target_type, target_id, "purge", owner.id)
        assert archived_placement.id in plan.scope_ids["board_record_placements"]
        assert any(
            row.entity_type == "board_record_placements"
            and row.entity_id == archived_placement.id
            for row in plan.rows
        )
        assert any(
            blocker.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
            and blocker.entity_id == archived_placement.id
            for blocker in plan.blockers
        )
        with pytest.raises(LifecyclePreflightError):
            execute_lifecycle(integration_db, plan)

    second_placement = BoardRecordPlacement(board_id=active_board.id, record_id=record.id)
    integration_db.add(second_placement)
    integration_db.commit()
    current_plan = plan_lifecycle(integration_db, "record", record.id, "purge", owner.id)
    assert set(current_plan.scope_ids["board_record_placements"]) == {
        archived_placement.id,
        second_placement.id,
    }
    assert {
        blocker.entity_id
        for blocker in current_plan.blockers
        if blocker.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
    } == {
        archived_placement.id,
        second_placement.id,
    }
    with pytest.raises(LifecyclePreflightError):
        execute_lifecycle(integration_db, current_plan)
    assert integration_db.get(Record, record.id) is not None
    assert integration_db.get(BoardRecordPlacement, archived_placement.id) is not None
    assert integration_db.get(BoardRecordPlacement, second_placement.id) is not None

    integration_db.delete(archived_placement)
    integration_db.delete(second_placement)
    integration_db.commit()
    unlinked_plan = plan_lifecycle(integration_db, "record", record.id, "purge", owner.id)
    assert not unlinked_plan.blockers
    execute_lifecycle(integration_db, unlinked_plan)
    assert integration_db.get(Record, record.id) is None


@pytest.mark.integration
@pytest.mark.parametrize("target_type", ["module", "department"])
def test_parent_purge_waits_for_board_record_links_to_be_removed(
    integration_db, target_type: str
) -> None:
    now = datetime.now(UTC)
    owner = actor(integration_db)
    department = Department(
        department_name=f"Placement parent purge {uuid7()}",
        is_deleted=True,
        deleted_at=now,
    )
    integration_db.add(department)
    integration_db.flush()
    module = Module(
        department_id=department.id,
        module_name="Placement parent module",
        is_deleted=True,
        deleted_at=now,
    )
    board = Board(
        owner_id=owner.id,
        name="Retained archived Board",
        status=BoardStatus.ARCHIVED,
        is_deleted=True,
        deleted_at=now,
    )
    integration_db.add_all([module, board])
    integration_db.flush()
    record = Record(module_id=module.id, data={}, is_deleted=True, deleted_at=now)
    second_record = Record(module_id=module.id, data={}, is_deleted=True, deleted_at=now)
    integration_db.add_all([record, second_record])
    integration_db.flush()
    placement = BoardRecordPlacement(board_id=board.id, record_id=record.id)
    second_placement = BoardRecordPlacement(board_id=board.id, record_id=second_record.id)
    integration_db.add_all([placement, second_placement])
    integration_db.commit()
    previous_revision = board.revision
    department_id, module_id, record_id, board_id, placement_id = (
        department.id,
        module.id,
        record.id,
        board.id,
        placement.id,
    )

    target_id = module_id if target_type == "module" else department_id
    plan = plan_lifecycle(integration_db, target_type, target_id, "purge", owner.id)
    assert set(plan.scope_ids["board_record_placements"]) == {
        placement_id,
        second_placement.id,
    }
    assert {
        blocker.entity_id
        for blocker in plan.blockers
        if blocker.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
    } == {placement_id, second_placement.id}
    with pytest.raises(LifecyclePreflightError):
        execute_lifecycle(integration_db, plan)
    assert integration_db.get(BoardRecordPlacement, placement_id) is not None
    assert integration_db.get(BoardRecordPlacement, second_placement.id) is not None
    assert integration_db.get(Record, record_id) is not None

    integration_db.delete(placement)
    integration_db.delete(second_placement)
    integration_db.commit()
    unlinked_plan = plan_lifecycle(integration_db, target_type, target_id, "purge", owner.id)
    assert not unlinked_plan.blockers
    execute_lifecycle(integration_db, unlinked_plan)
    assert integration_db.get(Record, record_id) is None
    assert integration_db.get(Record, second_record.id) is None
    assert integration_db.get(Module, module_id) is None
    assert (integration_db.get(Department, department_id) is None) is (
        target_type == "department"
    )
    assert integration_db.get(Board, board_id).revision == previous_revision


@pytest.mark.integration
def test_department_purge_blocks_active_and_deleted_boards_without_deleting_grants(
    integration_db,
) -> None:
    now = datetime.now(UTC)
    owner = actor(integration_db)
    department = Department(department_name=f"Board department {uuid7()}")
    other_department = Department(department_name=f"Other department {uuid7()}")
    integration_db.add_all([department, other_department])
    integration_db.flush()
    active_board = Board(
        department_id=department.id,
        owner_id=owner.id,
        name="Active board",
    )
    deleted_board = Board(
        department_id=department.id,
        owner_id=owner.id,
        name="Deleted archived board",
        status=BoardStatus.ARCHIVED,
        is_deleted=True,
        deleted_at=now,
    )
    other_board = Board(
        department_id=other_department.id,
        owner_id=owner.id,
        name="Other department board",
    )
    unassigned_board = Board(
        department_id=None,
        owner_id=owner.id,
        name="Unassigned board",
    )
    integration_db.add_all([active_board, deleted_board, other_board, unassigned_board])
    integration_db.flush()
    grant = BoardGrant(
        board_id=active_board.id,
        principal_type="everyone",
        permission="view",
        effect="allow",
    )
    department.is_deleted = True
    department.deleted_at = now
    integration_db.add(grant)
    integration_db.flush()
    department_id = department.id
    active_board_id = active_board.id
    deleted_board_id = deleted_board.id
    other_board_id = other_board.id
    unassigned_board_id = unassigned_board.id
    grant_id = grant.id
    integration_db.commit()
    board_ids = {active_board_id, deleted_board_id}

    plan = plan_lifecycle(
        integration_db, LifecycleTargetType.DEPARTMENT, department_id, "purge", None
    )

    board_rows = [row for row in plan.rows if row.entity_type == "boards"]
    assert {row.entity_id for row in board_rows} == board_ids
    assert all(len(row.state_fingerprint) == 64 for row in board_rows)
    assert set(plan.scope_ids["boards"]) == board_ids
    board_blockers = [
        blocker
        for blocker in plan.blockers
        if blocker.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
    ]
    assert {blocker.entity_id for blocker in board_blockers} == board_ids
    assert all(
        blocker.department_id == department_id
        and blocker.conflicting_entity_type == "departments"
        and blocker.conflicting_entity_id == department_id
        and "reassign" in blocker.detail.casefold()
        for blocker in board_blockers
    )

    with pytest.raises(LifecyclePreflightError):
        execute_lifecycle(integration_db, plan)

    assert integration_db.get(Department, department_id) is not None
    assert integration_db.get(Board, active_board_id) is not None
    assert integration_db.get(Board, deleted_board_id) is not None
    assert integration_db.get(Board, other_board_id) is not None
    assert integration_db.get(Board, unassigned_board_id) is not None
    assert integration_db.get(BoardGrant, grant_id) is not None


@pytest.mark.integration
def test_department_purge_plan_drifts_when_a_board_changes_before_execution(integration_db) -> None:
    now = datetime.now(UTC)
    owner = actor(integration_db)
    department = Department(
        department_name=f"Board drift department {uuid7()}",
        is_deleted=True,
        deleted_at=now,
    )
    integration_db.add(department)
    integration_db.flush()
    department_id = department.id
    owner_id = owner.id
    board = Board(
        department_id=department_id,
        owner_id=owner_id,
        name="Before preview",
    )
    integration_db.add(board)
    integration_db.commit()
    board_id = board.id

    plan = plan_lifecycle(
        integration_db, LifecycleTargetType.DEPARTMENT, department_id, "purge", None
    )
    original_state = next(row for row in plan.rows if row.entity_type == "boards")
    board.name = "Changed after preview"
    board.revision += 1
    later_board = Board(
        department_id=department_id,
        owner_id=owner_id,
        name="Created after preview",
    )
    integration_db.add(later_board)
    integration_db.flush()
    integration_db.commit()
    later_board_id = later_board.id

    current_plan = plan_lifecycle(
        integration_db, LifecycleTargetType.DEPARTMENT, department_id, "purge", None
    )
    current_states = {
        row.entity_id: row
        for row in current_plan.rows
        if row.entity_type == "boards"
    }
    assert current_plan.impact_digest != plan.impact_digest
    assert set(current_states) == {board_id, later_board_id}
    assert current_states[board_id].state_fingerprint != original_state.state_fingerprint

    with pytest.raises(LifecyclePlanDriftError):
        execute_lifecycle(integration_db, plan)

    assert integration_db.get(Department, department_id) is not None
    assert integration_db.get(Board, board_id).name == "Changed after preview"
    assert integration_db.get(Board, later_board_id) is not None
