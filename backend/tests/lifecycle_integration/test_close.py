import os
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.lifecycle.exceptions import (
    LifecycleClosedAncestorError,
    LifecyclePlanDriftError,
    LifecyclePreflightError,
)
from app.systems.lifecycle.planner import plan_lifecycle
from app.systems.lifecycle.schemas import LifecycleBlockerCode, LifecycleTargetType
from app.systems.lifecycle.service import close_lifecycle, reopen_lifecycle
from app.systems.modules.models import Module
from tests.lifecycle_integration_support import _item  # noqa: F401

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("TEST_DATABASE_URL") is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


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
