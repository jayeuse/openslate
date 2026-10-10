"""Native guarded runtime requests prove portable source/consumer lock behavior."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import perf_counter
from uuid import UUID

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentitySession
from app.systems.boards import portability_router
from app.systems.boards.models import Board, BoardWidget
from app.systems.manage.audit.models import AuditLog
from app.systems.openview.charts.models import Chart
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from tests.boards.portable_chart_support import (
    portable_race_world as portable_race_world,
)
from tests.boards.portable_chart_support import (
    prepare_cross_pair_board,
)

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("locked", ["module", "field"])
@pytest.mark.parametrize("operation", ["export", "duplicate"])
def test_unselected_cross_pair_lock_does_not_refuse_selected_sources(
    portable_race_world, locked, operation
):
    world = portable_race_world
    prepare_cross_pair_board(world)
    model, identifier = (
        (Module, world.unselected_module_id)
        if locked == "module"
        else (Field, world.unselected_field_id)
    )
    with Session(world.owner) as blocker:
        blocker.scalar(select(model).where(model.id == identifier).with_for_update())
        with world.client("admin" if operation == "duplicate" else "member") as client:
            response = (
                client.post(f"/api/boards/{world.board_id}/duplicate")
                if operation == "duplicate"
                else client.get(f"/api/boards/{world.board_id}/configuration")
            )
            assert response.status_code == (201 if operation == "duplicate" else 200)
            if operation == "duplicate":
                world.copied_board_ids.append(UUID(response.json()["id"]))


def _attached(world):
    with world.client() as client:
        result = world.attachment(client)
        assert result.status_code == 201
        return UUID(result.json()["widget"]["id"])


def _counts(world):
    with Session(world.owner) as db:
        return tuple(
            db.scalar(select(func.count()).select_from(model))
            for model in (Board, BoardWidget, AuditLog)
        )


def _request(world, operation):
    with world.client("admin" if operation == "duplicate" else "member") as client:
        return (
            client.post(f"/api/boards/{world.board_id}/duplicate")
            if operation == "duplicate"
            else client.get(f"/api/boards/{world.board_id}/configuration")
        )


@pytest.mark.parametrize("held", ["module", "chart", "field", "board", "widget"])
@pytest.mark.parametrize("operation", ["export", "duplicate"])
def test_native_contention_releases_all_prior_locks_without_writes(
    portable_race_world, held, operation
):
    world = portable_race_world
    widget_id = _attached(world)
    rows = {
        "department": (Department, world.department_id),
        "module": (Module, world.module_id),
        "chart": (Chart, world.charts[0]),
        "field": (Field, world.field_id),
        "board": (Board, world.board_id),
        "widget": (BoardWidget, widget_id),
    }
    baseline = _counts(world)
    model, identifier = rows[held]
    with Session(world.owner) as blocker:
        blocker.scalar(select(model).where(model.id == identifier).with_for_update())
        started = perf_counter()
        response = _request(world, operation)
        assert response.status_code == 503 and perf_counter() - started < 5
        assert response.headers["Cache-Control"] == "private, no-store"
        assert (
            str(world.charts[0]) not in response.text and str(world.module_id) not in response.text
        )
        with Session(world.owner) as verifier:
            for key in ("department", "module", "chart", "field"):
                if key == held:
                    continue
                kind, identity = rows[key]
                assert (
                    verifier.scalar(
                        select(kind).where(kind.id == identity).with_for_update(nowait=True)
                    )
                    is not None
                )
        assert _counts(world) == baseline
    with Session(world.owner) as durable:
        widget = durable.get(BoardWidget, widget_id)
        assert widget.chart_id == world.charts[0] and widget.config is None
        assert durable.get(Board, world.board_id).revision == 2


@pytest.mark.parametrize("changed", ["source", "consumer"])
def test_committed_drift_is_unavailable_after_unlocked_discovery(
    portable_race_world, monkeypatch, changed
):
    world = portable_race_world
    widget_id = _attached(world)
    entered, proceed = Event(), Event()
    original = portability_router._locked_departments

    def pause(db, ids):
        entered.set()
        if not proceed.wait(10):
            raise RuntimeError("Owned drift barrier timed out")
        return original(db, ids)

    monkeypatch.setattr(portability_router, "_locked_departments", pause)
    with ThreadPoolExecutor(max_workers=1) as executor:
        request = executor.submit(_request, world, "export")
        try:
            assert entered.wait(5)
            if changed == "source":
                with AuditSession(world.owner) as mutation:
                    mutation.scalar(
                        select(Module).where(Module.id == world.module_id).with_for_update()
                    )
                    field = mutation.scalar(
                        select(Field).where(Field.id == world.field_id).with_for_update()
                    )
                    field.type = "number"
                    mutation.commit()
            else:
                with world.client("admin") as writer:
                    response = writer.patch(
                        f"/api/boards/{world.board_id}/widgets/{widget_id}",
                        json={
                            "revision": 2,
                            "widget": {
                                "name": "Committed new presentation",
                                "widget_type": "chart",
                                "module_id": str(world.module_id),
                                "chart_id": str(world.charts[0]),
                                "config": None,
                                "size": "L",
                                "pinned": False,
                            },
                        },
                    )
                    assert response.status_code == 200
            expected = _counts(world)
        finally:
            proceed.set()
        result = request.result(timeout=15)
    assert (
        result.status_code == 409 and result.json()["detail"]["code"] == "board_source_unavailable"
    )
    assert result.headers["Cache-Control"] == "private, no-store"
    assert str(world.charts[0]) not in result.text
    assert _counts(world) == expected
    with Session(world.owner) as durable:
        widget = durable.get(BoardWidget, widget_id)
        assert widget.chart_id == world.charts[0] and widget.config is None
        assert (widget.size, widget.pinned) == (
            ("L", False) if changed == "consumer" else ("S", True)
        )


def test_revoked_session_cannot_export_a_normalized_source(portable_race_world):
    world = portable_race_world
    _attached(world)
    with AuditSession(world.owner) as mutation:
        mutation.get(IdentitySession, world.sessions["member"]).revoked_at = utc_now()
        mutation.commit()
    before = _counts(world)
    result = _request(world, "export")
    assert result.status_code == 409 and result.headers["Cache-Control"] == "private, no-store"
    assert str(world.charts[0]) not in result.text and _counts(world) == before
