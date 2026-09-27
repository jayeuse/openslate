"""Dashboard widgets block module purge while they retain query references."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from uuid6 import uuid7
from views.test_access import actor

from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.openview.dashboards.schemas import DashboardChartConfig
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.batch_dependencies import load_purge_dependencies
from app.systems.sandbox.lifecycle.exceptions import (
    LifecyclePlanDriftError,
    LifecyclePreflightError,
)
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.planning_scope import LifecycleScope
from app.systems.sandbox.lifecycle.schemas import LifecycleTargetType
from app.systems.sandbox.modules.models import Module


def _chart_config(module: Module) -> dict[str, object]:
    return {"query": {"module_id": str(module.id)}}


def _closed_module(db) -> tuple[Department, Module]:
    now = datetime.now(UTC)
    department = Department(department_name=f"Dashboard purge {uuid7().hex}")
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id,
        module_name=f"Closed module {uuid7().hex}",
        is_deleted=True,
        deleted_at=now,
    )
    db.add(module)
    db.flush()
    return department, module


def test_module_purge_inventory_includes_deleted_widgets_and_archived_dashboards() -> None:
    now = datetime.now(UTC)
    module_id = uuid7()
    dashboard = Dashboard(
        id=uuid7(),
        owner_id=uuid7(),
        name="Multi-module review",
        revision=3,
        is_deleted=True,
        deleted_at=now,
        updated_at=now,
    )
    active_widget = DashboardWidget(
        id=uuid7(),
        dashboard_id=dashboard.id,
        position=0,
        widget_type="chart",
        config={"query": {"module_id": str(module_id)}},
        is_deleted=False,
        deleted_at=None,
        updated_at=now,
    )
    deleted_widget = DashboardWidget(
        id=uuid7(),
        dashboard_id=dashboard.id,
        position=1,
        widget_type="chart",
        config={"query": {"module_id": str(module_id)}},
        is_deleted=True,
        deleted_at=now,
        updated_at=now,
    )
    module = Module(
        id=module_id,
        department_id=uuid7(),
        module_name="Archived source",
        is_deleted=True,
        deleted_at=now,
        updated_at=now,
    )

    class ScalarRows(list):
        def all(self):
            return self

    class DependencySession:
        def scalars(self, statement):
            entity = statement.column_descriptions[0]["entity"]
            return ScalarRows(
                {
                    DashboardWidget: [active_widget, deleted_widget],
                    Dashboard: [dashboard],
                }.get(entity, [])
            )

    dependencies = load_purge_dependencies(
        DependencySession(),  # type: ignore[arg-type]
        LifecycleScope((), (module,), (), (), ()),
        LifecycleTargetType.MODULE,
    )

    assert dependencies.ids["dashboard_widgets"] == (active_widget.id, deleted_widget.id)
    assert dependencies.ids["dashboards"] == (dashboard.id,)
    widget_rows = {
        row.entity_id: row
        for row in dependencies.rows
        if row.entity_type == "dashboard_widgets"
    }
    assert set(widget_rows) == {active_widget.id, deleted_widget.id}
    assert all(len(row.state_fingerprint) == 64 for row in widget_rows.values())
    dashboard_row = next(row for row in dependencies.rows if row.entity_type == "dashboards")
    assert dashboard_row.state_fingerprint

    blockers = [
        blocker
        for blocker in dependencies.blockers
        if getattr(blocker.code, "value", blocker.code) == "purge_dashboard_dependency"
    ]
    assert {blocker.entity_id for blocker in blockers} == {active_widget.id, deleted_widget.id}
    assert all(
        blocker.entity_type == "dashboard_widgets"
        and blocker.conflicting_entity_type == "dashboards"
        and blocker.conflicting_entity_id == dashboard.id
        for blocker in blockers
    )
    active_fingerprint = widget_rows[active_widget.id].state_fingerprint
    active_widget.config = {"query": {"module_id": str(module_id), "measure": "count"}}
    changed = load_purge_dependencies(
        DependencySession(),  # type: ignore[arg-type]
        LifecycleScope((), (module,), (), (), ()),
        LifecycleTargetType.MODULE,
    )
    changed_row = next(
        row
        for row in changed.rows
        if row.entity_type == "dashboard_widgets" and row.entity_id == active_widget.id
    )
    assert changed_row.state_fingerprint != active_fingerprint


@pytest.mark.integration
def test_module_purge_blocks_archived_and_deleted_dashboard_widgets_without_deleting_dashboard(
    integration_db,
) -> None:
    owner = actor(integration_db)
    _, module = _closed_module(integration_db)
    other_department = Department(department_name=f"Other dashboard module {uuid7().hex}")
    integration_db.add(other_department)
    integration_db.flush()
    other_module = Module(
        department_id=other_department.id,
        module_name="Another module",
    )
    integration_db.add(other_module)
    integration_db.flush()
    now = datetime.now(UTC)
    archived_dashboard = Dashboard(
        owner_id=owner.id,
        name="Archived multi-module dashboard",
        is_deleted=True,
        deleted_at=now,
    )
    active_dashboard = Dashboard(owner_id=owner.id, name="Active dashboard")
    integration_db.add_all([archived_dashboard, active_dashboard])
    integration_db.flush()
    archived_target_widget = DashboardWidget(
        dashboard_id=archived_dashboard.id,
        position=0,
        config=_chart_config(module),
    )
    other_module_widget = DashboardWidget(
        dashboard_id=archived_dashboard.id,
        position=1,
        config=_chart_config(other_module),
    )
    deleted_target_widget = DashboardWidget(
        dashboard_id=active_dashboard.id,
        position=0,
        config=_chart_config(module),
        is_deleted=True,
        deleted_at=now,
    )
    integration_db.add_all(
        [archived_target_widget, other_module_widget, deleted_target_widget]
    )
    integration_db.commit()
    module_id = module.id
    archived_dashboard_id = archived_dashboard.id
    active_dashboard_id = active_dashboard.id
    target_widget_ids = {archived_target_widget.id, deleted_target_widget.id}
    other_widget_id = other_module_widget.id

    plan = plan_lifecycle(integration_db, "module", module_id, "purge", None)

    widget_rows = [row for row in plan.rows if row.entity_type == "dashboard_widgets"]
    dashboard_rows = [row for row in plan.rows if row.entity_type == "dashboards"]
    assert {row.entity_id for row in widget_rows} == target_widget_ids
    assert all(len(row.state_fingerprint) == 64 for row in widget_rows)
    assert {row.entity_id for row in dashboard_rows} == {
        archived_dashboard_id,
        active_dashboard_id,
    }
    blockers = [
        blocker
        for blocker in plan.blockers
        if blocker.code.value == "purge_dashboard_dependency"
    ]
    assert {blocker.entity_id for blocker in blockers} == target_widget_ids
    assert all(
        blocker.conflicting_entity_type == "dashboards"
        and blocker.conflicting_entity_id in {archived_dashboard_id, active_dashboard_id}
        for blocker in blockers
    )

    with pytest.raises(LifecyclePreflightError):
        execute_lifecycle(integration_db, plan)

    assert integration_db.get(Module, module_id) is not None
    assert integration_db.get(Dashboard, archived_dashboard_id).is_deleted
    assert integration_db.get(Dashboard, active_dashboard_id) is not None
    assert integration_db.get(DashboardWidget, other_widget_id) is not None
    assert all(
        integration_db.get(DashboardWidget, widget_id) is not None
        for widget_id in target_widget_ids
    )


@pytest.mark.integration
def test_module_purge_plan_drifts_when_its_dashboard_and_widget_change(integration_db) -> None:
    owner = actor(integration_db)
    _, module = _closed_module(integration_db)
    dashboard = Dashboard(owner_id=owner.id, name="Purge drift dashboard")
    integration_db.add(dashboard)
    integration_db.flush()
    widget = DashboardWidget(
        dashboard_id=dashboard.id,
        position=0,
        config=_chart_config(module),
    )
    integration_db.add(widget)
    integration_db.commit()
    module_id, dashboard_id, widget_id = module.id, dashboard.id, widget.id

    plan = plan_lifecycle(integration_db, "module", module_id, "purge", None)
    original_widget = next(row for row in plan.rows if row.entity_type == "dashboard_widgets")
    original_dashboard = next(row for row in plan.rows if row.entity_type == "dashboards")
    widget.config = {"query": {"module_id": str(module.id), "measure": "count"}}
    dashboard.name = "Renamed during purge preview"
    dashboard.revision += 1
    integration_db.commit()

    current = plan_lifecycle(integration_db, "module", module_id, "purge", None)
    assert current.impact_digest != plan.impact_digest
    current_widget = next(row for row in current.rows if row.entity_type == "dashboard_widgets")
    current_dashboard = next(row for row in current.rows if row.entity_type == "dashboards")
    assert current_widget.state_fingerprint != original_widget.state_fingerprint
    assert current_dashboard.state_fingerprint != original_dashboard.state_fingerprint

    with pytest.raises(LifecyclePlanDriftError):
        execute_lifecycle(integration_db, plan)

    assert integration_db.get(Module, module_id) is not None
    changed_dashboard = integration_db.get(Dashboard, dashboard_id)
    changed_widget = integration_db.get(DashboardWidget, widget_id)
    assert changed_dashboard.name == "Renamed during purge preview"
    assert changed_widget.config == {
        "query": {"module_id": str(module_id), "measure": "count"}
    }


def _field_chart_config(
    module: Module, target: Field, other: Field, location: str
) -> dict[str, object]:
    reference = {"field_id": str(target.id), "expected_type": target.type.value}
    other_reference = {"field_id": str(other.id), "expected_type": other.type.value}
    definition: dict[str, object] = {"version": 1}
    query: dict[str, object] = {
        "module_id": str(module.id),
        "definition": definition,
        "mode": "groups",
        "dimension": other_reference,
        "aggregation": "count",
    }
    chart_type = "bar"
    if location in {"columns", "sort", "search_fields"}:
        definition[location] = [reference]
    elif location == "filters":
        definition[location] = [{**reference, "operator": "eq", "value": "match"}]
    elif location == "dimension":
        query[location] = reference
    elif location == "date_field":
        chart_type = "line"
        query.update(
            mode="date_series",
            date_field=reference,
            from_date="2026-01-01",
            to_date="2026-01-02",
        )
        del query["dimension"]
    elif location == "measure":
        query.update(aggregation="sum", measure=reference)
    return DashboardChartConfig.model_validate(
        {"chart_type": chart_type, "query": query}
    ).model_dump(mode="json")


@pytest.mark.integration
@pytest.mark.parametrize(
    ("location", "field_type"),
    [
        ("columns", FieldType.TEXT),
        ("filters", FieldType.TEXT),
        ("sort", FieldType.TEXT),
        ("search_fields", FieldType.TEXT),
        ("dimension", FieldType.TEXT),
        ("date_field", FieldType.DATE),
        ("measure", FieldType.DECIMAL),
    ],
)
def test_field_purge_blocks_retained_widget_reference_then_preserves_dashboard_on_repair(
    integration_db, location: str, field_type: FieldType
) -> None:
    owner = actor(integration_db)
    _, module = _closed_module(integration_db)
    now = datetime.now(UTC)
    target = Field(
        module_id=module.id,
        name=f"Referenced {location}",
        type=field_type,
        required=False,
        position=0,
        config={},
        is_deleted=True,
        deleted_at=now,
    )
    other = Field(
        module_id=module.id,
        name="Unrelated dimension",
        type=FieldType.TEXT,
        required=False,
        position=1,
        config={},
    )
    integration_db.add_all([target, other])
    integration_db.flush()
    safe_config = _field_chart_config(module, other, other, "dimension")
    archived = location == "date_field"
    deleted = location == "measure"
    dashboard = Dashboard(
        owner_id=owner.id,
        name=f"Field purge {location}",
        is_deleted=archived,
        deleted_at=now if archived else None,
    )
    integration_db.add(dashboard)
    integration_db.flush()
    referencing_widget = DashboardWidget(
        dashboard_id=dashboard.id,
        position=0,
        config=_field_chart_config(module, target, other, location),
        is_deleted=deleted,
        deleted_at=now if deleted else None,
    )
    unrelated_widget = DashboardWidget(
        dashboard_id=dashboard.id, position=1, config=safe_config
    )
    integration_db.add_all([referencing_widget, unrelated_widget])
    integration_db.commit()
    field_id = target.id
    dashboard_id = dashboard.id
    referencing_widget_id = referencing_widget.id
    unrelated_widget_id = unrelated_widget.id

    plan = plan_lifecycle(integration_db, "field", field_id, "purge", None)
    blockers = [
        blocker for blocker in plan.blockers if blocker.code.value == "purge_dashboard_dependency"
    ]
    assert {blocker.entity_id for blocker in blockers} == {referencing_widget_id}
    assert blockers[0].field_id == field_id
    assert blockers[0].conflicting_entity_id == dashboard_id
    assert plan.scope_ids["dashboard_widgets"] == (referencing_widget_id,)
    assert plan.scope_ids["dashboards"] == (dashboard_id,)
    with pytest.raises(LifecyclePreflightError):
        execute_lifecycle(integration_db, plan)
    assert integration_db.get(Field, field_id) is not None
    assert integration_db.get(DashboardWidget, referencing_widget_id) is not None

    referencing_widget.config = safe_config
    integration_db.commit()
    repaired_plan = plan_lifecycle(integration_db, "field", field_id, "purge", None)
    assert repaired_plan.impact_digest != plan.impact_digest
    assert not any(
        blocker.code.value == "purge_dashboard_dependency" for blocker in repaired_plan.blockers
    )
    execute_lifecycle(integration_db, repaired_plan)

    assert integration_db.get(Field, field_id) is None
    assert integration_db.get(Dashboard, dashboard_id) is not None
    assert integration_db.get(DashboardWidget, referencing_widget_id) is not None
    assert integration_db.get(DashboardWidget, unrelated_widget_id) is not None
    assert integration_db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "fields",
            AuditLog.entity_id == field_id,
            AuditLog.action == AuditAction.DELETE,
        )
    ) is not None
