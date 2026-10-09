"""Lossless Board reference exports/imports through the existing HTTP commands."""

import json
from uuid import UUID

import pytest
from sqlalchemy import select

from app.core.base_model import utc_now
from app.systems.boards.models import BoardWidget
from app.systems.openview.charts.models import Chart
from app.systems.sandbox.departments.models import Department
from tests.boards.portable_chart_support import (
    alternate_source,
    chart_board,
    complete_query,
    family_query,
    multi_source_board,
    reference,
)
from tests.charts.chart_route_support import chart_world as chart_world
from tests.charts.widget_reference_support import managed_board

pytestmark = pytest.mark.integration


def test_reference_exports_complete_named_query_and_imports_inline_with_presentation(chart_world):
    world = chart_world
    query, selected, option_ids = complete_query(world)
    board = managed_board(world, "reader")
    with world.client("manager") as owner:
        chart = owner.post("/api/charts", json=world.body(query=query)).json()
    with world.client("reader") as manager:
        created = manager.post(
            f"/api/boards/{board.id}/widgets",
            json={
                "revision": 1,
                "widget": {
                    "name": "Portable reference",
                    "widget_type": "chart",
                    "module_id": str(world.module.id),
                    "chart_id": chart["id"],
                    "config": None,
                    "size": "S",
                    "pinned": True,
                },
            },
        )
        assert created.status_code == 201
        exported = manager.get(f"/api/boards/{board.id}/configuration")
        assert exported.status_code == 200
        bundle = exported.json()
        assert bundle["kind"] == "openslate-board" and bundle["version"] == 3
        config = bundle["configuration"]["widgets"][0]["config"]
        assert config["size"] == "S" and config["pinned"] is True and config["refresh"] == "manual"
        portable = config["query"]
        assert "module_id" not in portable and "chart_id" not in exported.text
        assert portable["dimension"] == {"name": "Label", "expected_type": "text"}
        assert portable["measure"] == {"name": "Amount", "expected_type": "number"}
        assert portable["date_field"] == {"name": "Date", "expected_type": "date"}
        assert portable["aggregation"] == "average" and portable["from_date"] == "2025-01-01"
        definition = portable["definition"]
        assert len(definition["filters"]) == 9 and definition["filters"][0]["value"] == [
            "Open",
            "Closed",
        ]
        assert definition["sort"] == [
            {"name": "Amount", "expected_type": "number", "direction": "desc"}
        ]
        assert (
            definition["search"] == "owned canary"
            and definition["deleted"] == "include"
            and definition["logic"] == "or"
        )
        for identifier in [
            chart["id"],
            str(world.module.id),
            str(world.label.id),
            str(world.amount.id),
            str(selected.id),
            *option_ids,
        ]:
            assert identifier not in exported.text
    with world.client("admin") as admin:
        imported = admin.post(
            "/api/boards/import",
            content=json.dumps(bundle).encode(),
            headers={"Content-Type": "application/octet-stream"},
        )
        assert imported.status_code == 201
        widgets = admin.get(f"/api/boards/{imported.json()['id']}/widgets").json()["items"]
        assert (
            widgets[0]["chart_id"] is None
            and widgets[0]["size"] == "S"
            and widgets[0]["pinned"] is True
        )
        assert widgets[0]["config"]["query"] == chart["query"]
        stored = world.db.scalar(
            select(BoardWidget).where(BoardWidget.board_id == UUID(imported.json()["id"]))
        )
        assert stored.chart_id is None and stored.config == widgets[0]["config"]
        assert "refresh" not in stored.config


@pytest.mark.parametrize(
    ("family", "kind", "size", "pinned"),
    [
        ("count", "summary", "S", False),
        ("sum", "workload", "M", True),
        ("average", "bar", "L", False),
        ("min", "pie", "S", True),
        ("max", "bar", "M", False),
        ("distinct", "pie", "L", True),
        ("day", "line", "S", False),
        ("week", "line", "M", True),
        ("month", "line", "L", False),
        ("quarter", "line", "S", True),
        ("year", "line", "M", False),
        ("records", "records", "L", True),
    ],
)
def test_query_families_round_trip_inline_with_layout(chart_world, family, kind, size, pinned):
    world = chart_world
    query, selected, options = family_query(world, family)
    board, chart = chart_board(world, query, kind, size, pinned)
    with world.client("reader") as reader:
        exported = reader.get(f"/api/boards/{board.id}/configuration")
        assert exported.status_code == 200
        bundle = exported.json()
        config = bundle["configuration"]["widgets"][0]["config"]
        assert (config["size"], config["pinned"], config["refresh"]) == (size, pinned, "manual")
        portable = config["query"]
        definition = portable["definition"]
        assert len(definition["filters"]) == 10
        assert definition["filters"][0]["value"] == ["Open", "Closed"]
        assert definition["filters"][-1] == {
            "name": "Person",
            "expected_type": "user",
            "operator": "empty",
            "value": None,
        }
        assert definition["columns"] == [
            {"name": "Label", "expected_type": "text"},
            {"name": "Person", "expected_type": "user"},
        ]
        assert definition["sort"] == [
            {"name": "Amount", "expected_type": "number", "direction": "desc"}
        ]
        assert definition["search_fields"] == [{"name": "Label", "expected_type": "text"}]
        assert (
            definition["version"],
            definition["logic"],
            definition["deleted"],
            definition["search"],
        ) == (1, "or", "include", "owned canary")
        assert "module_id" not in portable
        if family in {"day", "week", "month", "quarter", "year"}:
            assert (
                portable["mode"],
                portable["bucket"],
                portable["from_date"],
                portable["to_date"],
            ) == ("date_series", family, query["from_date"], query["to_date"])
        elif family != "records":
            assert portable["aggregation"] == family
            assert (
                portable["measure"] is None
                if family == "count"
                else portable["measure"] is not None
            )
        for identifier in [
            chart["id"],
            str(world.module.id),
            str(world.label.id),
            str(world.amount.id),
            str(world.date.id),
            str(world.person.id),
            str(selected.id),
            *options,
        ]:
            assert identifier not in exported.text
    with world.client("admin") as admin:
        imported = admin.post(
            "/api/boards/import",
            content=json.dumps(bundle).encode(),
            headers={"Content-Type": "application/octet-stream"},
        )
        duplicated = admin.post(f"/api/boards/{board.id}/duplicate")
        assert imported.status_code == duplicated.status_code == 201
        for result in (imported, duplicated):
            widgets = admin.get(f"/api/boards/{result.json()['id']}/widgets").json()["items"]
            assert len(widgets) == 1
            assert (widgets[0]["size"], widgets[0]["pinned"], widgets[0]["chart_id"]) == (
                size,
                pinned,
                None,
            )
            assert widgets[0]["config"]["query"] == query == chart["query"]
            stored = world.db.get(BoardWidget, UUID(widgets[0]["id"]))
            assert stored.config == widgets[0]["config"] and "refresh" not in stored.config


def test_named_query_import_resolves_an_alternate_owned_graph(chart_world):
    world = chart_world
    query, selected, options = complete_query(world)
    query["definition"]["search"] = "f48ea338-893b-447f-b4cb-adc5b83aee92"
    board, chart = chart_board(world, query)
    with world.client("reader") as reader:
        exported = reader.get(f"/api/boards/{board.id}/configuration")
        assert exported.status_code == 200
        bundle = exported.json()
    module, fields, new_options = alternate_source(world)
    with world.client("admin") as admin:
        imported = admin.post(
            "/api/boards/import",
            content=json.dumps(bundle).encode(),
            headers={"Content-Type": "application/octet-stream"},
        )
        assert imported.status_code == 201
        widget = admin.get(f"/api/boards/{imported.json()['id']}/widgets").json()["items"][0]
        copied = widget["config"]["query"]
        assert copied["module_id"] == widget["module_id"] == str(module.id)
        assert copied["dimension"] == reference(fields["Label"], "text")
        assert copied["measure"] == reference(fields["Amount"], "number")
        assert copied["date_field"] == reference(fields["Date"], "date")
        definition = copied["definition"]
        assert definition["columns"] == [
            reference(fields["Label"], "text"),
            reference(fields["Person"], "user"),
        ]
        assert definition["sort"] == [
            {**reference(fields["Amount"], "number"), "direction": "desc"}
        ]
        assert definition["search_fields"] == [reference(fields["Label"], "text")]
        assert definition["search"] == query["definition"]["search"]
        assert all(
            item["field_id"] == str(fields["Status"].id) and item["value"] == new_options
            for item in definition["filters"]
        )
        assert (copied["aggregation"], copied["from_date"], copied["to_date"]) == (
            "average",
            "2025-01-01",
            "2025-02-28",
        )
        assert selected.id != fields["Status"].id and options != new_options
        assert world.module.id != module.id and chart["id"] != widget["chart_id"]


@pytest.mark.parametrize(("size", "expected"), [("half", "M"), ("full", "L"), ("S", "S")])
def test_legacy_layout_input_maps_without_coercing_small(chart_world, size, expected):
    world = chart_world
    department = world.db.get(Department, world.module.department_id)
    bundle = {
        "kind": "openslate-board",
        "version": 3,
        "configuration": {
            "name": "Legacy layout",
            "description": None,
            "widgets": [
                {
                    "name": "Legacy",
                    "widget_type": "records",
                    "source": {
                        "department_name": department.department_name,
                        "module_name": world.module.module_name,
                    },
                    "config": {
                        "fields": [{"name": "Label", "expected_type": "text"}],
                        "filters": [],
                        "logic": "and",
                        "metric": None,
                        "visualization": "bar",
                        "size": size,
                        "refresh": "five-minutes",
                        "pinned": True,
                    },
                }
            ],
        },
    }
    with world.client("admin") as admin:
        result = admin.post(
            "/api/boards/import",
            content=json.dumps(bundle).encode(),
            headers={"Content-Type": "application/octet-stream"},
        )
        assert result.status_code == 201
        widget = admin.get(f"/api/boards/{result.json()['id']}/widgets").json()["items"][0]
        assert (widget["size"], widget["pinned"], widget["chart_id"]) == (expected, True, None)
        assert "refresh" not in world.db.get(BoardWidget, UUID(widget["id"])).config
        output = admin.get(f"/api/boards/{result.json()['id']}/configuration")
        assert output.status_code == 200
        assert output.json()["configuration"]["widgets"][0]["config"]["size"] == expected


def test_multi_source_bundle_round_trip_resolves_only_selected_pairs(chart_world):
    world = chart_world
    board, sources = multi_source_board(world)
    with world.client("reader") as reader:
        exported = reader.get(f"/api/boards/{board.id}/configuration")
        assert exported.status_code == 200
        bundle = exported.json()
        assert [item["source"] for item in bundle["configuration"]["widgets"]] == [
            {"department_name": department.department_name, "module_name": module.module_name}
            for department, module, _, _ in sources
        ]
    with world.client("admin") as admin:
        imported = admin.post(
            "/api/boards/import",
            content=json.dumps(bundle).encode(),
            headers={"Content-Type": "application/octet-stream"},
        )
        duplicated = admin.post(f"/api/boards/{board.id}/duplicate")
        assert imported.status_code == duplicated.status_code == 201
        for result in (imported, duplicated):
            items = admin.get(f"/api/boards/{result.json()['id']}/widgets").json()["items"]
            assert [item["module_id"] for item in items] == [str(row[1].id) for row in sources]
            assert [(item["name"], item["size"], item["pinned"]) for item in items] == [
                ("Legacy selected", "M", False),
                ("Normalized selected", "L", True),
            ]
            assert items[0]["config"]["fields"] == [reference(sources[0][2], "text")]
            assert items[1]["config"]["query"]["dimension"] == reference(sources[1][3], "number")


@pytest.mark.parametrize("source", ["reference", "inline"])
def test_board_manager_without_source_read_gets_generic_unavailable(chart_world, source):
    world = chart_world
    query, _, _ = complete_query(world)
    board, chart = chart_board(world, query)
    if source == "inline":
        with world.client("reader") as reader:
            result = reader.patch(
                f"/api/boards/{board.id}/widgets/"
                + reader.get(f"/api/boards/{board.id}/widgets").json()["items"][0]["id"],
                json={
                    "revision": 2,
                    "widget": {
                        "name": "Inline private source",
                        "widget_type": "chart",
                        "module_id": str(world.module.id),
                        "config": {"version": 1, "chart_type": "bar", "query": query},
                        "size": "S",
                        "pinned": True,
                    },
                },
            )
            assert result.status_code == 200
    with world.client("stranger") as manager:
        result = manager.get(f"/api/boards/{board.id}/configuration")
        assert result.status_code == 409
        assert result.json()["detail"]["code"] == "board_source_unavailable"
        assert result.headers["Cache-Control"] == "private, no-store"
        for hidden in [chart["id"], str(world.module.id), chart["name"], "owned canary"]:
            assert hidden not in result.text


@pytest.mark.parametrize("state", ["chart", "module", "field", "type", "option"])
def test_committed_unavailable_source_refuses_export_and_duplicate(chart_world, state):
    world = chart_world
    query, selected, _ = complete_query(world)
    board, chart = chart_board(world, query)
    row = world.db.get(Chart, UUID(chart["id"]))
    if state == "chart":
        row.is_deleted, row.deleted_at = True, utc_now()
    elif state == "module":
        world.module.is_deleted, world.module.deleted_at = True, utc_now()
    elif state == "field":
        world.label.is_deleted, world.label.deleted_at = True, utc_now()
    elif state == "type":
        world.label.type = "number"
    else:
        selected.config = {"options": []}
    world.db.commit()
    with world.client("reader") as reader, world.client("admin") as admin:
        for response in (
            reader.get(f"/api/boards/{board.id}/configuration"),
            admin.post(f"/api/boards/{board.id}/duplicate"),
        ):
            assert response.status_code == 409
            assert response.json()["detail"]["code"] == "board_source_unavailable"
            assert response.headers["Cache-Control"] == "private, no-store"
            assert chart["id"] not in response.text and "owned canary" not in response.text
    world.db.expire_all()
    retained = world.db.scalar(select(BoardWidget).where(BoardWidget.board_id == board.id))
    assert retained.config is None and str(retained.chart_id) == chart["id"]
    assert world.db.get(Chart, UUID(chart["id"])).query == chart["query"]


def test_saved_reference_duplicate_is_inline_and_leaves_usage_unchanged(chart_world):
    world = chart_world
    query, _, _ = complete_query(world)
    board, chart = chart_board(world, query, size="L", pinned=False)
    with world.client("admin") as admin:
        before = admin.get(f"/api/charts/{chart['id']}/usage").json()
        duplicated = admin.post(f"/api/boards/{board.id}/duplicate")
        assert duplicated.status_code == 201
        after = admin.get(f"/api/charts/{chart['id']}/usage").json()
        assert after == before and len(after["items"]) == 1
        source = admin.get(f"/api/boards/{board.id}/widgets").json()
        assert source["board_revision"] == 2 and source["items"][0]["config"] is None
        assert source["items"][0]["chart_id"] == chart["id"]
        copied = admin.get(f"/api/boards/{duplicated.json()['id']}/widgets").json()["items"][0]
        assert (copied["chart_id"], copied["size"], copied["pinned"]) == (None, "L", False)
        assert copied["config"]["query"] == chart["query"] and "refresh" not in copied["config"]
        assert admin.get(f"/api/charts/{chart['id']}").json()["revision"] == chart["revision"]
