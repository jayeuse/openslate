"""Board source, presentation and reference commands through the real HTTP writers."""

import json
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.systems.boards.models import Board, BoardWidget
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.openview.charts.models import Chart
from tests.charts.chart_route_support import chart_world as chart_world
from tests.charts.widget_reference_support import managed_board

pytestmark = pytest.mark.integration


def test_readable_chart_can_be_managed_as_board_widget_without_chart_edit_authority(chart_world):
    world = chart_world
    board = managed_board(world, "reader")
    with world.client("manager") as chart_client:
        chart = chart_client.post("/api/charts", json=world.body()).json()
    root = f"/api/boards/{board.id}/widgets"
    spec = {
        "name": "Shared data",
        "widget_type": "chart",
        "module_id": str(world.module.id),
        "chart_id": chart["id"],
        "config": None,
        "size": "S",
        "pinned": True,
    }
    with world.client("reader") as client:
        assert (
            client.patch(
                f"/api/charts/{chart['id']}", json={"revision": 1, "name": "Forbidden"}
            ).status_code
            == 403
        )
        created = client.post(root, json={"revision": 1, "widget": spec})
        assert created.status_code == 201
        widget = created.json()["widget"]
        assert widget["chart_id"] == chart["id"] and widget["config"] is None
        assert widget["size"] == "S" and widget["pinned"] is True
        row = world.db.get(BoardWidget, UUID(widget["id"]))
        assert row.chart_id == UUID(chart["id"]) and row.config is None
        assert row.size == "S" and row.pinned is True
        changed = client.patch(
            f"{root}/{widget['id']}",
            json={
                "revision": 2,
                "widget": {**spec, "name": "Renamed", "size": "M", "pinned": False},
            },
        )
        assert changed.status_code == 200 and changed.json()["board_revision"] == 3
        duplicate = client.post(f"{root}/{widget['id']}/duplicate", json={"revision": 3})
        assert duplicate.status_code == 201 and duplicate.json()["board_revision"] == 4
        copied = duplicate.json()["widget"]
        assert copied["chart_id"] == chart["id"] and copied["config"] is None
        assert copied["size"] == "M" and copied["pinned"] is False
        large = client.patch(
            f"{root}/{widget['id']}", json={"revision": 4, "widget": {**spec, "size": "L"}}
        )
        assert large.status_code == 200 and large.json()["board_revision"] == 5
        ordered = client.put(
            f"{root}/order", json={"revision": 5, "widget_ids": [copied["id"], widget["id"]]}
        )
        assert ordered.status_code == 200 and ordered.json()["board_revision"] == 6
        shown = client.get(root).json()["items"]
        assert [(item["id"], item["size"], item["pinned"]) for item in shown] == [
            (copied["id"], "M", False),
            (widget["id"], "L", True),
        ]
        with world.client("manager") as chart_client:
            usage = chart_client.get(f"/api/charts/{chart['id']}/usage").json()
            assert usage["items"] == [] and usage["has_restricted_usage"] is True
            assert chart_client.delete(f"/api/charts/{chart['id']}?revision=1").status_code == 409
        assert client.delete(f"{root}/{widget['id']}?revision=6").status_code == 204
        assert client.delete(f"{root}/{copied['id']}?revision=7").status_code == 204
    with world.client("manager") as chart_client:
        assert chart_client.delete(f"/api/charts/{chart['id']}?revision=1").status_code == 204


def test_normalized_inline_board_query_keeps_complete_semantics_and_redacts_audit(chart_world):
    world = chart_world
    board = managed_board(world, "reader")
    query = world.grouped()
    query.update(
        {
            "aggregation": "sum",
            "measure": {"field_id": str(world.amount.id), "expected_type": "number"},
            "date_field": {"field_id": str(world.date.id), "expected_type": "date"},
            "from_date": "2025-01-01",
            "to_date": "2025-12-31",
        }
    )
    query["definition"] = {
        "version": 1,
        "columns": [{"field_id": str(world.label.id), "expected_type": "text"}],
        "filters": [
            {
                "field_id": str(world.label.id),
                "expected_type": "text",
                "operator": "contains",
                "value": "a",
            }
        ],
        "logic": "or",
        "sort": [
            {"field_id": str(world.amount.id), "expected_type": "number", "direction": "desc"}
        ],
        "deleted": "include",
        "search": "PRIVATE-QUERY-CANARY",
        "search_fields": [{"field_id": str(world.label.id), "expected_type": "text"}],
    }
    spec = {
        "name": "Normalized",
        "widget_type": "chart",
        "module_id": str(world.module.id),
        "size": "S",
        "pinned": True,
        "chart_id": None,
        "config": {"version": 1, "chart_type": "bar", "query": query},
    }
    with world.client("reader") as client:
        result = client.post(
            f"/api/boards/{board.id}/widgets", json={"revision": 1, "widget": spec}
        )
        assert result.status_code == 201
        saved = result.json()["widget"]
        assert saved["config"]["query"] == query
        assert saved["chart_id"] is None and saved["size"] == "S" and saved["pinned"] is True
        row = world.db.get(BoardWidget, UUID(saved["id"]))
        assert row.chart_id is None and row.config == spec["config"]
        assert client.get(f"/api/boards/{board.id}/widgets").json()["items"][0] == saved
        audits = world.db.scalars(
            select(AuditLog).where(
                AuditLog.entity_type == "board_widgets", AuditLog.entity_id == row.id
            )
        ).all()
        assert len(audits) == 1 and audits[0].after["config"] == REDACTED
        assert "PRIVATE-QUERY-CANARY" not in json.dumps(audits[0].after)


def test_widget_http_source_grammars_reject_ambiguous_sources_without_changes(chart_world):
    world = chart_world
    board = managed_board(world, "reader")
    with world.client("manager") as owner:
        chart_id = owner.post("/api/charts", json=world.body()).json()["id"]
    reference = {
        "name": "Valid",
        "widget_type": "chart",
        "module_id": str(world.module.id),
        "chart_id": chart_id,
        "config": None,
    }
    invalid = [
        {**reference, "chart_id": None},
        {**reference, "config": {}},
        {**reference, "size": "half"},
        {**reference, "size": "XS"},
        {**reference, "chart_id": "display-name"},
        {**reference, "audience": {}},
        {**reference, "chart_id": None, "config": {"size": "full"}},
        {
            **reference,
            "chart_id": None,
            "config": {"query": world.grouped(), "chart_type": "bar", "fields": []},
        },
        {
            **reference,
            "chart_id": None,
            "widget_type": "records",
            "config": {"query": world.grouped(), "chart_type": "bar"},
        },
    ]
    with world.client("reader") as client:
        for body in invalid:
            refusal = client.post(
                f"/api/boards/{board.id}/widgets", json={"revision": 1, "widget": body}
            )
            assert refusal.status_code == 422
            assert world.db.get(Board, board.id).revision == 1
            assert (
                world.db.scalars(select(BoardWidget).where(BoardWidget.board_id == board.id)).all()
                == []
            )
        legacy = client.post(
            f"/api/boards/{board.id}/widgets",
            json={
                "revision": 1,
                "widget": {
                    "name": "Legacy",
                    "widget_type": "records",
                    "module_id": str(world.module.id),
                    "config": {},
                },
            },
        )
        assert legacy.status_code == 201
        saved = legacy.json()["widget"]
        assert saved["size"] == "M" and saved["pinned"] is False and saved["chart_id"] is None
        assert "size" not in saved["config"] and "pinned" not in saved["config"]


def test_board_authority_is_distinct_from_current_chart_source_admission(chart_world):
    world = chart_world
    board = managed_board(world, "reader", "stranger")
    with world.client("manager") as owner:
        chart = owner.post("/api/charts", json=world.body("SECRET-CHART-CANARY")).json()
    spec = {
        "name": "Ref",
        "widget_type": "chart",
        "module_id": str(world.module.id),
        "chart_id": chart["id"],
        "config": None,
    }
    root = f"/api/boards/{board.id}/widgets"
    for actor in ("manager", "module_manager", "stranger"):
        with world.client(actor) as client:
            denied = client.post(root, json={"revision": 1, "widget": spec})
            assert denied.status_code == 404
            assert "SECRET-CHART-CANARY" not in denied.text
    with world.client("reader") as client:
        for changed in (
            {**spec, "module_id": str(world.other_module.id)},
            {**spec, "widget_type": "summary"},
        ):
            denied = client.post(root, json={"revision": 1, "widget": changed})
            assert denied.status_code == 409 and denied.json()["detail"]["code"] == "widget_invalid"
        world.label.type = "number"
        world.db.commit()
        stale = client.post(root, json={"revision": 1, "widget": spec})
        assert stale.status_code == 409 and "SECRET-CHART-CANARY" not in stale.text
        world.label.type = "text"
        world.db.commit()
    with world.client("manager") as owner:
        assert owner.delete(f"/api/charts/{chart['id']}?revision=1").status_code == 204
    with world.client("reader") as client:
        archived = client.post(root, json={"revision": 1, "widget": spec})
        assert archived.status_code == 409
    world.db.expire_all()
    assert world.db.get(Board, board.id).revision == 1
    assert world.db.scalars(select(BoardWidget).where(BoardWidget.board_id == board.id)).all() == []


def test_board_reference_can_switch_sources_and_read_metadata_after_source_refusal(chart_world):
    world = chart_world
    board = managed_board(world, "reader")
    with world.client("manager") as owner:
        chart = owner.post("/api/charts", json=world.body()).json()
    root = f"/api/boards/{board.id}/widgets"
    reference = {
        "name": "Switch",
        "widget_type": "chart",
        "module_id": str(world.module.id),
        "chart_id": chart["id"],
        "config": None,
        "size": "S",
        "pinned": True,
    }
    with world.client("reader") as client:
        saved = client.post(root, json={"revision": 1, "widget": reference}).json()["widget"]
        inline = {
            **reference,
            "chart_id": None,
            "config": {"version": 1, "chart_type": "bar", "query": world.grouped()},
        }
        changed = client.patch(f"{root}/{saved['id']}", json={"revision": 2, "widget": inline})
        assert changed.status_code == 200 and changed.json()["board_revision"] == 3
        row = world.db.get(BoardWidget, UUID(saved["id"]))
        assert (
            row.chart_id is None
            and row.config is not None
            and row.size == "S"
            and row.pinned is True
        )
        back = client.patch(f"{root}/{saved['id']}", json={"revision": 3, "widget": reference})
        assert back.status_code == 200 and back.json()["board_revision"] == 4
        chart_row = world.db.get(Chart, UUID(chart["id"]))
        chart_row.is_deleted = True
        world.db.commit()  # Owned retained-state fixture; public archive refuses references.
        shown = client.get(root)
        assert shown.status_code == 200 and shown.json()["items"][0]["config"] is None
        refused = client.post(f"{root}/{saved['id']}/duplicate", json={"revision": 4})
        assert refused.status_code == 409
        assert client.delete(f"{root}/{saved['id']}?revision=4").status_code == 204


def test_board_reference_and_normalized_inline_support_each_existing_query_category(chart_world):
    world = chart_world
    board = managed_board(world, "reader")
    definition = {
        "version": 1,
        "columns": [{"field_id": str(world.label.id), "expected_type": "text"}],
    }
    series = {
        "module_id": str(world.module.id),
        "definition": definition,
        "mode": "date_series",
        "date_field": {"field_id": str(world.date.id), "expected_type": "date"},
        "from_date": "2025-01-01",
        "to_date": "2025-12-31",
        "bucket": "year",
        "aggregation": "count",
    }
    records = {"module_id": str(world.module.id), "definition": definition}
    revision = 1
    with world.client("manager") as owner, world.client("reader") as client:
        for kind in ("bar", "line", "pie", "summary", "workload", "records"):
            query = series if kind == "line" else records if kind == "records" else world.grouped()
            chart = owner.post("/api/charts", json=world.body(kind=kind, query=query))
            assert chart.status_code == 201
            category = kind if kind in {"summary", "workload", "records"} else "chart"
            config = {"version": 1, "query": query}
            if category == "chart":
                config["chart_type"] = kind
            base = {
                "name": kind,
                "widget_type": category,
                "module_id": str(world.module.id),
                "size": "S",
                "pinned": False,
            }
            for source in (
                {"chart_id": chart.json()["id"], "config": None},
                {"chart_id": None, "config": config},
            ):
                created = client.post(
                    f"/api/boards/{board.id}/widgets",
                    json={"revision": revision, "widget": {**base, **source}},
                )
                assert created.status_code == 201
                saved = created.json()["widget"]
                assert saved["widget_type"] == category and saved["size"] == "S"
                assert saved["chart_id"] == source["chart_id"]
                if saved["config"] is not None and kind == "line":
                    assert saved["config"]["query"]["bucket"] == "year"
                    assert saved["config"]["query"]["from_date"] == "2025-01-01"
                revision += 1


def test_board_failed_commit_removes_widget_revision_and_audit_changes(chart_world, monkeypatch):
    world = chart_world
    board = managed_board(world, "reader")
    with world.client("manager") as owner:
        chart_id = owner.post("/api/charts", json=world.body()).json()["id"]
    with world.client("reader") as client:
        before = set(world.db.scalars(select(AuditLog.id)).all())

        def failed_commit():
            world.db.flush()
            raise IntegrityError("COMMIT", {}, RuntimeError("owned injected write failure"))

        with monkeypatch.context() as patch:
            patch.setattr(world.db, "commit", failed_commit)
            failed = client.post(
                f"/api/boards/{board.id}/widgets",
                json={
                    "revision": 1,
                    "widget": {
                        "name": "Rollback",
                        "widget_type": "chart",
                        "module_id": str(world.module.id),
                        "chart_id": chart_id,
                        "config": None,
                        "size": "L",
                        "pinned": True,
                    },
                },
            )
        assert failed.status_code == 409 and "owned injected" not in failed.text
        with Session(
            bind=world.db.get_bind(), join_transaction_mode="create_savepoint"
        ) as observer:
            assert observer.get(Board, board.id).revision == 1
            assert (
                observer.scalars(select(BoardWidget).where(BoardWidget.board_id == board.id)).all()
                == []
            )
            assert set(observer.scalars(select(AuditLog.id)).all()) == before
