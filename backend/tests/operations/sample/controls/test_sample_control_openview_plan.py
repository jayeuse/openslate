from __future__ import annotations

from datetime import date
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import httpx
import pytest

from operations.sample.board_text import report_names, view_name
from operations.sample.client import SampleClient
from operations.sample.controls.openview_queries import select_openview_target
from operations.sample.controls.openview_verification import verify_openview_controls
from operations.sample.packs.registry import get_pack, pack_keys
from operations.sample.packs.types import SampleProfile
from operations.sample.scenario import build_dataset

INCUMBENT_OPENVIEW_ROUTES = frozenset(
    {
        ("POST", "/api/records/query"),
        ("POST", "/api/records/grouped-query"),
        ("POST", "/api/records/window-query"),
        ("POST", "/api/records/aggregate-query"),
        ("POST", "/api/records/aggregate-snapshot"),
        ("POST", "/api/records/aggregate-snapshots"),
        ("GET", "/api/records/{record_id}"),
        ("POST", "/api/records"),
        ("PATCH", "/api/records/{record_id}"),
        ("DELETE", "/api/records/{record_id}"),
        ("POST", "/api/records/{record_id}/restore"),
        ("POST", "/api/records/{record_id}/purge/preview"),
        ("POST", "/api/records/{record_id}/purge"),
        ("POST", "/api/relationships"),
        ("DELETE", "/api/relationships/{relationship_id}"),
        ("GET", "/api/views/{view_id}"),
        ("PATCH", "/api/views/{view_id}"),
        ("GET", "/api/dashboards/{dashboard_id}"),
        ("PATCH", "/api/dashboards/{dashboard_id}"),
        ("GET", "/api/reports/{report_id}"),
        ("PATCH", "/api/reports/{report_id}"),
        ("GET", "/api/reports/{report_id}/schedule"),
        ("PATCH", "/api/reports/{report_id}/schedule"),
        ("POST", "/api/reports"),
        ("DELETE", "/api/reports/{report_id}"),
        ("POST", "/api/reports/{report_id}/purge/preview"),
        ("POST", "/api/reports/{report_id}/purge"),
    }
)


@pytest.mark.parametrize("pack_key", pack_keys())
@pytest.mark.parametrize("profile", ("small", "standard"))
def test_openview_control_plan_is_pack_derived_and_covers_query_and_edit_controls(
    pack_key: str,
    profile: SampleProfile,
) -> None:
    from operations.sample.controls.openview import plan_openview_controls

    dataset = build_dataset(
        profile, seed=42, anchor_date=date(2026, 9, 30), organization=get_pack(pack_key)
    )

    actions = plan_openview_controls(dataset)
    operations = [action.values.get("operation") for action in actions]
    assert operations == [
        "record_query",
        "grouped_query",
        "window_query",
        "aggregate_groups",
        "aggregate_scalar",
        "aggregate_date_series",
        "aggregate_snapshot_groups",
        "aggregate_snapshot_date_series",
        "aggregate_snapshots",
        "view_patch",
        "dashboard_patch",
        "report_patch",
        "schedule_patch",
        "report_purge",
        "record_lifecycle",
        "relationship_delete",
        "chart_lifecycle",
    ]
    from operations.sample.controls.openview import CHART_ROUTES, CONTROL_ROUTES

    expected_chart = frozenset(
        {
            ("POST", "/api/charts"),
            ("GET", "/api/charts"),
            ("GET", "/api/charts/{chart_id}"),
            ("PATCH", "/api/charts/{chart_id}"),
            ("GET", "/api/charts/{chart_id}/usage"),
            ("DELETE", "/api/charts/{chart_id}"),
            ("POST", "/api/charts/{chart_id}/restore"),
        }
    )
    assert CHART_ROUTES == expected_chart and CHART_ROUTES.isdisjoint(INCUMBENT_OPENVIEW_ROUTES)
    assert CONTROL_ROUTES == INCUMBENT_OPENVIEW_ROUTES | expected_chart
    chart = actions[-1]
    assert chart.actor_key != "admin" and chart.values["department_key"] in dict(
        dataset.organization.catalog.departments
    )

    assert set(operations) >= {
        "record_query",
        "grouped_query",
        "window_query",
        "aggregate_groups",
        "aggregate_scalar",
        "aggregate_date_series",
        "aggregate_snapshot_groups",
        "aggregate_snapshot_date_series",
        "aggregate_snapshots",
        "view_patch",
        "dashboard_patch",
        "report_patch",
        "schedule_patch",
        "record_lifecycle",
        "relationship_delete",
        "report_purge",
    }
    assert len(operations) == len(set(operations))
    batch = next(
        action for action in actions if action.values["operation"] == "aggregate_snapshots"
    )
    singles = [
        action
        for action in actions
        if action.values["operation"]
        in {"aggregate_snapshot_groups", "aggregate_snapshot_date_series"}
    ]
    assert batch.actor_key == singles[0].actor_key == singles[1].actor_key
    assert batch.values["queries"] == [action.values["query"] for action in singles]
    purge = next(action for action in actions if action.values["operation"] == "report_purge")
    source = next(action for action in actions if action.values["operation"] == "report_patch")
    assert purge.actor_key == "admin" and purge.expected_status == 200
    assert purge.target_key != source.target_key
    assert purge.values["source_report_key"] == source.target_key
    assert purge.values["module_key"] == source.values["module_key"]
    assert 0 < len(purge.values["temporary_name"]) <= 80
    assert purge.values["temporary_name"] != source.values["report_name"]
    assert all(action.kind == "openview_controls" for action in actions)
    assert all(action.phase == "reorganization" for action in actions)
    assert all(action.key.startswith("control:") for action in actions)
    module_keys = {module.key for module in dataset.organization.catalog.modules}
    for action in actions:
        module_key = action.values.get("module_key")
        if module_key is not None:
            assert module_key in module_keys
    temporary_names: dict[str, set[str]] = {}
    for action in actions:
        pairs = (
            ((action.values["module_key"], action.values["temporary_name"]),)
            if action.values.get("operation") == "record_lifecycle"
            else (
                (action.values["source_module_key"], action.values["source_temporary_name"]),
                (action.values["target_module_key"], action.values["target_temporary_name"]),
            )
            if action.values.get("operation") == "relationship_delete"
            else ()
        )
        for key, name in pairs:
            assert isinstance(key, str) and isinstance(name, str) and name.strip()
            name_field = dataset.field_ids[key]["name"]
            existing = {
                record.data[name_field] for record in dataset.records if record.module_key == key
            }
            assert name not in existing
            assert name not in temporary_names.setdefault(key, set())
            temporary_names[key].add(name)


def test_openview_verifier_checks_actual_authored_dashboard_title(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "operations.sample.controls.charts_verification.verify_chart_controls",
        lambda *args: ({}, []),
    )
    dataset = build_dataset("small", 290504089, date(2026, 10, 2), organization=get_pack("harbor"))
    _, module, _ = select_openview_target(dataset)
    dashboard_id = str(uuid5(NAMESPACE_URL, "dashboard"))
    department_id = str(uuid5(NAMESPACE_URL, "department"))
    # The real catalogue API labels departments with department_name, not name.
    # Consequently population authors these exact logical-key titles, observed in Harbor.
    dashboard = {
        "id": dashboard_id,
        "department_id": department_id,
        "name": "finance overview",
        "is_deleted": False,
        "revision": 3,
    }
    group_name = next((field.name for field in module.fields if field.type == "Select"), None)
    report_name = report_names(module.key, "daily", group_name, organization=dataset.organization)[
        0
    ]
    pages = {
        "/api/records": [
            {"id": str(uuid5(NAMESPACE_URL, row.logical_id))} for row in dataset.records
        ],
        "/api/relationships": [{"is_deleted": False} for _ in dataset.edges],
        "/api/views": [
            {
                "name": view_name(
                    module.key,
                    dataset.organization.content.data.layouts[0],
                    organization=dataset.organization,
                ),
                "is_deleted": False,
            }
        ],
        "/api/dashboards": [dashboard],
        "/api/reports": [
            {"id": str(uuid5(NAMESPACE_URL, "report")), "name": report_name, "is_deleted": False}
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        if request.url.path.endswith("/schedule"):
            return httpx.Response(
                200,
                json={
                    "enabled": False,
                    "cadence": "daily",
                    "timezone_name": dataset.organization.identity.timezone,
                    "local_time": "09:00",
                    "weekday": None,
                    "month_day": None,
                },
            )
        all_rows = pages[request.url.path]
        offset = int(request.url.params["offset"])
        rows = all_rows[offset : offset + 100]
        return httpx.Response(
            200,
            json={
                "items": rows,
                "pagination": {
                    "limit": 100,
                    "offset": offset,
                    "count": len(rows),
                    "total": len(all_rows),
                    "has_more": offset + len(rows) < len(all_rows),
                },
            },
        )

    manifest = {
        "control_results": [
            {
                "action_key": f"control:{operation}",
                "query_total": 0,
                **({"query_totals": [0, 0]} if operation == "aggregate_snapshots" else {}),
            }
            for operation in (
                "record_query",
                "grouped_query",
                "window_query",
                "aggregate_groups",
                "aggregate_scalar",
                "aggregate_date_series",
                "aggregate_snapshot_groups",
                "aggregate_snapshot_date_series",
                "aggregate_snapshots",
            )
        ]
    }
    with SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        counts, issues = verify_openview_controls(
            client, dataset, manifest, admin_id=str(uuid5(NAMESPACE_URL, "admin"))
        )
    assert not issues
    assert counts["dashboards_restored"] == 1
