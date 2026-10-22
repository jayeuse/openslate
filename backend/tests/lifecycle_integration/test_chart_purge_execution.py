"""Physical saved-source purges use real constrained sessions and RESTRICT ordering."""

from contextlib import contextmanager

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.boards.models import Board, BoardScope, BoardWidget
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.openview.charts.models import Chart
from app.systems.openview.dashboards.models import Dashboard
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.lifecycle.exceptions import LifecyclePreflightError, LifecycleUnavailable
from app.systems.sandbox.lifecycle.execution import close_lifecycle, execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.modules.models import Module
from tests.charts.widget_reference_support import reference_race_world as reference_race_world

pytestmark = pytest.mark.integration


def _context(world):
    return AuditContext(
        performed_by=world.actors["admin"],
        request_id=uuid7(),
        request_method="POST",
        request_path="/api/departments/owned-chart-purge",
    )


@contextmanager
def _admin_request(world, context=None):
    """A runtime session bound like an admin request: audit actor and organization.

    Production binds the organization in ``get_current_identity``; lifecycle execution
    stages Comms grant events that refuse a session without that binding.
    """
    with AuditSession(world.runtime) as db:
        db.info[AUDIT_CONTEXT_KEY] = context or _context(world)
        scope_session(db, world.organization_id)
        yield db


@contextmanager
def _closed_scope(world, target):
    board_id = None
    widget_id = None
    try:
        if target == "department":
            with AuditSession(world.owner) as db:
                db.info[AUDIT_CONTEXT_KEY] = _context(world)
                board = Board(
                    org_id=world.organization_id,
                    scope=BoardScope.DEPARTMENT,
                    department_id=world.department_id,
                    name="Owned department",
                )
                db.add(board)
                db.flush()
                board_id = board.id
                db.commit()
            with world.client("admin") as client:
                response = client.post(
                    f"/api/boards/{board_id}/widgets",
                    json={
                        "revision": 1,
                        "widget": {
                            "name": "Owned saved source",
                            "widget_type": "chart",
                            "module_id": str(world.module_id),
                            "chart_id": str(world.charts[0]),
                            "config": None,
                            "size": "S",
                            "pinned": True,
                        },
                    },
                )
                assert response.status_code == 201, response.text
                with AuditSession(world.runtime) as db:
                    widget_id = db.scalar(
                        select(BoardWidget.id).where(BoardWidget.board_id == board_id)
                    )
            assert widget_id is not None
        with world.client("admin") as client:
            assert client.delete(f"/api/charts/{world.charts[1]}?revision=1").status_code == 204
        identifier = world.department_id if target == "department" else world.module_id
        with _admin_request(world) as db:
            close_lifecycle(db, target, identifier, world.actors["admin"])
        yield identifier, board_id, widget_id
    finally:
        # Frozen ReferenceRaceWorld owns its original graph, not this extra Board.
        if board_id is not None:
            with world.owner.begin() as connection:
                connection.execute(
                    text("DELETE FROM audit_logs WHERE entity_id = ANY(:ids)"),
                    {"ids": [board_id, widget_id] if widget_id else [board_id]},
                )
                connection.execute(
                    text("DELETE FROM board_widgets WHERE board_id = :id"), {"id": board_id}
                )
                connection.execute(text("DELETE FROM boards WHERE id = :id"), {"id": board_id})


def _plan(world, target, identifier):
    with AuditSession(world.runtime) as db:
        assert db.connection().scalar(text("SELECT current_user")) == "openslate_runtime"
        plan = plan_lifecycle(db, target, identifier, "purge", world.actors["admin"])
        assert not plan.blockers
        assert set(plan.scope_ids["charts"]) == set(world.charts)
        return plan


def _snapshot(world, board_id=None):
    with AuditSession(world.runtime) as db:
        values = {}
        for model, identifiers in (
            (Department, [world.department_id, world.other_department_id]),
            (Module, [world.module_id]),
            (Field, [world.field_id]),
            (Chart, world.charts),
            (Board, [world.board_id, *([board_id] if board_id else [])]),
            (Dashboard, [world.dashboard_id]),
        ):
            for identifier in identifiers:
                row = db.get(model, identifier)
                values[str(identifier)] = (
                    None
                    if row is None
                    else {
                        column.name: getattr(row, column.name) for column in model.__table__.columns
                    }
                )
        values["widgets"] = (
            [
                (row.id, row.chart_id, row.size, row.pinned)
                for row in db.scalars(select(BoardWidget).where(BoardWidget.board_id == board_id))
            ]
            if board_id
            else []
        )
        values["audit"] = [
            row.id
            for row in db.scalars(
                select(AuditLog)
                .where(AuditLog.performed_by == world.actors["admin"])
                .order_by(AuditLog.id)
            )
        ]
        return values


@pytest.mark.parametrize("target", ["department", "module"])
def test_owned_parent_purge_removes_widgets_then_all_retained_charts_and_sources(
    reference_race_world, target
):
    world = reference_race_world
    with _closed_scope(world, target) as (identifier, board_id, widget_id):
        plan = _plan(world, target, identifier)
        if widget_id is not None:
            assert widget_id in plan.scope_ids["board_widgets"]
        context = _context(world)
        with _admin_request(world, context) as db:
            execute_lifecycle(db, plan)
        with AuditSession(world.runtime) as observer:
            for model, ids in (
                (Chart, world.charts),
                (Module, [world.module_id]),
                (Field, [world.field_id]),
            ):
                assert not list(observer.scalars(select(model).where(model.id.in_(ids))))
            assert observer.get(Department, world.other_department_id) is not None
            assert observer.get(Board, world.board_id) is not None
            if target == "department":
                assert observer.get(Department, world.department_id) is None
            else:
                assert observer.get(Department, world.department_id) is not None
            if board_id is not None:
                assert (
                    observer.get(Board, board_id) is None
                    and observer.get(BoardWidget, widget_id) is None
                )
                assert observer.get(Dashboard, world.dashboard_id) is None
            else:
                assert observer.get(Dashboard, world.dashboard_id) is not None
            deleted = list(
                observer.scalars(
                    select(AuditLog).where(
                        AuditLog.request_id == context.request_id,
                        AuditLog.entity_type == "charts",
                        AuditLog.action == AuditAction.DELETE,
                    )
                )
            )
            assert {row.entity_id for row in deleted} == set(world.charts)
            assert all(row.performed_by == world.actors["admin"] for row in deleted)


def test_late_chart_flush_failure_rolls_back_complete_owned_graph_and_audit(
    reference_race_world, monkeypatch
):
    world = reference_race_world
    with _closed_scope(world, "department") as (identifier, board_id, _widget_id):
        plan = _plan(world, "department", identifier)
        before = _snapshot(world, board_id)
        with _admin_request(world) as db:
            original = db.flush
            failed = []

            def fail_after_chart(*args, **kwargs):
                deleting = any(isinstance(row, Chart) for row in db.deleted)
                result = original(*args, **kwargs)
                if deleting:
                    failed.append(True)
                    raise IntegrityError("owned late Chart flush failure", {}, Exception("owned"))
                return result

            monkeypatch.setattr(db, "flush", fail_after_chart)
            with pytest.raises(LifecyclePreflightError):
                execute_lifecycle(db, plan)
            assert failed == [True]
        assert _snapshot(world, board_id) == before


@pytest.mark.parametrize("resource", ["chart", "module", "consumer"])
def test_busy_scope_refuses_without_partial_write_and_releases_earlier_locks(
    reference_race_world, resource, request
):
    world = reference_race_world
    with _closed_scope(world, "department") as (identifier, board_id, widget_id):
        plan = _plan(world, "department", identifier)
        before = _snapshot(world, board_id)
        model, row_id = {
            "chart": (Chart, world.charts[0]),
            "module": (Module, world.module_id),
            "consumer": (BoardWidget, widget_id),
        }[resource]
        with world.runtime.connect() as holder:
            holder_pid = holder.scalar(text("SELECT pg_backend_pid()"))
            holder.execute(select(model).where(model.id == row_id).with_for_update())
            with _admin_request(world) as db:
                request_pid = db.connection().scalar(text("SELECT pg_backend_pid()"))
                assert request_pid != holder_pid
                with pytest.raises(LifecycleUnavailable):
                    execute_lifecycle(db, plan)
                assert not db.in_transaction()
            assert _snapshot(world, board_id) == before
            with AuditSession(world.runtime) as observer:
                assert (
                    observer.scalar(
                        select(Department)
                        .where(Department.id == world.department_id)
                        .with_for_update(nowait=True)
                    )
                    is not None
                )
                if resource != "module":
                    assert (
                        observer.scalar(
                            select(Module)
                            .where(Module.id == world.module_id)
                            .with_for_update(nowait=True)
                        )
                        is not None
                    )
            print(
                f"C_LOCK_PROOF resource={resource} holder_pid={holder_pid} "
                f"request_pid={request_pid} rollback_released_earlier_scope=true"
            )
            request.node.user_properties.extend(
                [
                    ("lock_resource", resource),
                    ("holder_pid", holder_pid),
                    ("request_pid", request_pid),
                ]
            )
            holder.rollback()
        with _admin_request(world) as db:
            execute_lifecycle(db, _plan(world, "department", identifier))


def test_disappeared_scope_after_real_purge_releases_earlier_parent_locks(reference_race_world):
    world = reference_race_world
    with _closed_scope(world, "module") as (identifier, _board_id, _widget_id):
        stale = _plan(world, "module", identifier)
        with _admin_request(world) as winner:
            execute_lifecycle(winner, stale)
        with _admin_request(world) as late:
            with pytest.raises(LifecycleUnavailable):
                execute_lifecycle(late, stale)
            assert not late.in_transaction()
            with AuditSession(world.runtime) as observer:
                assert (
                    observer.scalar(
                        select(Department)
                        .where(Department.id == world.department_id)
                        .with_for_update(nowait=True)
                    )
                    is not None
                )
