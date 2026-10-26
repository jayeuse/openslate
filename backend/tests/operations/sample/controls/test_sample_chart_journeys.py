"""Real-client rich source preservation and bounded executor failure journeys."""

import json
from copy import deepcopy

import httpx
import pytest

from operations.sample.board_text import dashboard_name, report_names, view_name
from operations.sample.client import SampleAuthenticationError, SampleWriteOutcomeUnknown
from operations.sample.controls.openview import execute_openview_control
from operations.sample.controls.openview_queries import select_openview_target
from operations.sample.phases.actions import SamplePhaseActionError
from tests.operations.sample.controls import test_sample_control_charts as chart_tests
from tests.operations.sample.controls.sample_chart_query_wire import (
    boundary_reply_fault,
    rich_setup,
)
from tests.operations.sample.controls.sample_chart_wire import identity, page

chart_setup = chart_tests.chart_setup


def test_rich_dashboard_sources_keep_queries_windows_and_layout(chart_setup):
    dataset, action, context, wire, _ = rich_setup(chart_setup)
    result = execute_openview_control(action, dataset, context)
    created = next(
        row["request_body"]["widgets"]
        for row in result["read_receipts"]
        if row["step"] == "create_chart_dashboard"
    )
    source = wire.source_before[wire.source_dashboard_id]["widgets"]
    assert [row["config"] for row in created] == [row["config"] for row in source]
    assert [(row["grid_column"], row["grid_row"]) for row in created] == [(0, 0), (2, 0), (2, 2)]
    assert wire.source_before == {
        wire.source_dashboard_id: wire.dashboards[wire.source_dashboard_id]
    }


def test_rich_owned_copy_corruption_stops_before_completion(chart_setup):
    dataset, action, context, wire, _ = rich_setup(chart_setup)
    wire.corrupt = "dashboard_copy"
    with pytest.raises(SamplePhaseActionError) as failure:
        execute_openview_control(action, dataset, context)
    assert failure.value.step == "create_chart_dashboard"
    assert wire.source_before == {
        wire.source_dashboard_id: wire.dashboards[wire.source_dashboard_id]
    }


@pytest.mark.parametrize("failure", [500, 401, 409, "transport"])
def test_chart_create_failure_never_replays_or_returns_completed(chart_setup, failure):
    dataset, action, context, wire, directory = chart_setup
    wire.fault = (
        ("POST", "/api/charts"),
        httpx.ReadError("owned transport") if failure == "transport" else failure,
    )
    expected = (
        SampleWriteOutcomeUnknown
        if failure in {500, "transport"}
        else (SampleAuthenticationError if failure == 401 else SamplePhaseActionError)
    )
    with pytest.raises(expected):
        execute_openview_control(action, dataset, context)
    assert wire.seen.count(("POST", "/api/charts")) == 1 and wire.chart is None
    events = [
        json.loads(line)
        for path in directory.glob("*.jsonl")
        for line in path.read_text().splitlines()
    ]
    assert (
        sum(
            row.get("event") == "request_started"
            and row.get("method") == "POST"
            and row.get("route_template") == "/api/charts"
            for row in events
        )
        == 1
    )


@pytest.mark.parametrize("fault", ["null_template", "finish_reuse", "status_type"])
def test_native_chart_provenance_requires_exact_unique_attempts(chart_setup, fault):
    from operations.sample.controls.charts_verification import certify_retained_chart_dashboards
    from tests.operations.sample.controls.test_sample_control_charts import _manifest

    dataset, action, context, wire, directory = chart_setup
    result = execute_openview_control(action, dataset, context)
    request_id = next(
        row["request_id"] for row in result["read_receipts"] if row["step"] == "create_chart"
    )
    for path in directory.glob("*.jsonl"):
        events = [json.loads(line) for line in path.read_text().splitlines()]
        finish = next((row for row in events if row.get("request_id") == request_id), None)
        if finish is not None:
            start = next(
                row
                for row in events
                if row.get("attempt_id") == finish["attempt_id"]
                and row["event"] == "request_started"
            )
            if fault == "null_template":
                start["route_template"] = None
            elif fault == "status_type":
                finish["status_code"] = 201.0
            else:
                events.append({**finish, "request_id": identity("extra finish same attempt")})
            path.write_text("".join(json.dumps(row) + "\n" for row in events))
    identifiers, issues = certify_retained_chart_dashboards(
        context.clients["admin"],
        dataset,
        _manifest(context, result),
        context.user_ids["admin"],
        directory,
    )
    assert identifiers == () and issues


@pytest.mark.parametrize("stage", ["attach", "cleanup"])
def test_later_failure_stops_owned_journey_without_replay(chart_setup, stage):
    dataset, action, context, wire, _ = chart_setup
    usage = ("GET", f"/api/charts/{identity('chart')}/usage")
    source = ("GET", f"/api/dashboards/{wire.source_dashboard_id}")
    # The dependent request comes after the failing one; its count must not grow.
    method, path, failure, dependent, dependent_count = {
        "attach": ("PATCH", "/api/dashboards/" + wire.dashboard_id, 409, usage, 0),
        "cleanup": ("DELETE", "/api/dashboards/" + wire.dashboard_id, 500, source, 1),
    }[stage]
    wire.fault = ((method, path), failure)
    expected = SampleWriteOutcomeUnknown if stage == "cleanup" else SamplePhaseActionError
    with pytest.raises(expected):
        execute_openview_control(action, dataset, context)
    assert wire.seen.count((method, path)) == 1
    assert wire.seen.count(dependent) == dependent_count
    assert wire.source_before == {
        wire.source_dashboard_id: wire.dashboards[wire.source_dashboard_id]
    }


@pytest.mark.parametrize(
    "fault",
    [
        None,
        "duplicate",
        "ownership",
        "empty",
        "name",
        "chart_type",
        "revision",
        "is_deleted",
        "query",
        "created_at",
    ],
)
def test_chart_list_reads_later_pages_and_refuses_bad_pages(chart_setup, fault):
    dataset, action, context, wire, _ = chart_setup
    original = wire.__call__

    def paged(request):
        response = original(request)
        if request.method == "GET" and request.url.path == "/api/charts":
            offset = int(request.url.params["offset"])
            row = deepcopy(wire.chart)
            if offset == 0:
                row["id"] = identity("other matching chart")
            elif fault == "duplicate":
                row["id"] = identity("other matching chart")
            elif fault == "ownership":
                row["module_id"] = identity("other module")
            elif fault == "query":
                row["query"]["definition"]["deleted"] = "only"
            elif fault in {"name", "chart_type", "revision", "is_deleted", "created_at"}:
                row[fault] = {
                    "name": "Wrong listed name",
                    "chart_type": "pie",
                    "revision": 2,
                    "is_deleted": True,
                    "created_at": "2026-10-01T12:00:00Z",
                }[fault]
            body = page([] if offset and fault == "empty" else [row], offset)
            body["pagination"].update(total=2, has_more=offset == 0)
            return httpx.Response(200, headers=response.headers, json=body)
        return response

    for client in context.clients.values():
        client._client._transport = httpx.MockTransport(paged)
    if fault:
        with pytest.raises(SamplePhaseActionError):
            execute_openview_control(action, dataset, context)
    else:
        result = execute_openview_control(action, dataset, context)
        assert result["outcome"] == "completed"
        from operations.sample.controls.charts_verification import certify_retained_chart_dashboards

        assert certify_retained_chart_dashboards(
            context.clients["admin"],
            dataset,
            chart_tests._manifest(context, result),
            context.user_ids["admin"],
            chart_setup[-1],
        ) == ((wire.dashboard_id,), [])
    assert wire.seen.count(("GET", "/api/charts")) == 2


@pytest.mark.parametrize("owner", ["authored", "owned"])
def test_consumer_alias_refuses_all_dependent_writes(chart_setup, owner):
    dataset, action, context, wire, _ = chart_setup
    foreign = identity("unrelated " + owner + " dashboard")
    mappings = context.mappings if owner == "authored" else context.runtime_mappings
    mappings.setdefault("dashboards" if owner == "authored" else "control_dashboards", {})[
        "unrelated identity"
    ] = foreign
    wire.dashboards[foreign] = wire.dashboard(foreign, "Owned Chart control dashboard")
    before = deepcopy(wire.dashboards[foreign])
    original = wire.__call__

    def alias(request):
        response = original(request)
        if request.method == "POST" and request.url.path == "/api/dashboards":
            body = response.json()
            body["id"] = foreign
            headers = {**response.headers, "location": f"/api/dashboards/{foreign}"}
            return httpx.Response(201, headers=headers, json=body)
        return response

    for client in context.clients.values():
        client._client._transport = httpx.MockTransport(alias)
    with pytest.raises(SamplePhaseActionError) as failure:
        execute_openview_control(action, dataset, context)
    assert failure.value.step == "create_chart_dashboard"
    assert not [
        (method, path)
        for method, path in wire.seen
        if method != "GET" and path.startswith(f"/api/dashboards/{foreign}")
    ]
    assert wire.dashboards[foreign] == before


@pytest.mark.parametrize(
    "fault",
    [
        None,
        "populated_name",
        "populated_size",
        "manager_name",
        "admin_name",
        "blocked_name",
        "restore_query",
        "restore_name",
        "restore_revision",
        "restore_state",
        "restore_type",
    ],
)
def test_full_consumer_and_restore_response_boundaries(chart_setup, fault):
    dataset, action, context, wire, _ = chart_setup
    for client in context.clients.values():
        client._client._transport = httpx.MockTransport(boundary_reply_fault(wire, fault))
    if fault:
        with pytest.raises(SamplePhaseActionError) as failure:
            execute_openview_control(action, dataset, context)
        assert failure.value.step == (
            "read_populated_dashboard"
            if fault.startswith("populated")
            else "restore_chart"
            if fault.startswith("restore")
            else "archive_in_use_chart"
            if fault == "blocked_name"
            else "usage_chart"
        )
        if fault.startswith("populated"):
            assert not any(path.endswith("/usage") for _, path in wire.seen)
    else:
        result = execute_openview_control(action, dataset, context)
        assert any(row["step"] == "read_populated_dashboard" for row in result["read_receipts"])
        append = wire.seen.index(("PATCH", f"/api/dashboards/{wire.dashboard_id}"))
        usage = next(index for index, (_, path) in enumerate(wire.seen) if path.endswith("/usage"))
        assert ("GET", f"/api/dashboards/{wire.dashboard_id}") in wire.seen[append + 1 : usage]


@pytest.mark.parametrize("corrupt", [False, True])
def test_openview_final_boundary_certifies_current_chart_sources(chart_setup, monkeypatch, corrupt):
    from operations.sample.controls import openview_verification as boundary
    from tests.operations.sample.controls.test_sample_control_charts import _manifest

    dataset, action, context, wire, _ = chart_setup
    result = execute_openview_control(action, dataset, context)
    manifest = _manifest(context, result)
    queries = [
        "record_query",
        "grouped_query",
        "window_query",
        "aggregate_groups",
        "aggregate_scalar",
        "aggregate_date_series",
        "aggregate_snapshot_groups",
        "aggregate_snapshot_date_series",
        "aggregate_snapshots",
    ]
    manifest["control_results"].extend(
        {
            "action_key": "control:" + operation,
            "query_total": 0,
            **({"query_totals": [0, 0]} if operation == "aggregate_snapshots" else {}),
        }
        for operation in queries
    )
    department, module, _ = select_openview_target(dataset)
    group = next((field.name for field in module.fields if field.type == "Select"), None)
    pages = {
        "/api/records": [{} for _ in dataset.records],
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
        "/api/dashboards": [
            {
                "name": dashboard_name(department, organization=dataset.organization),
                "is_deleted": False,
            }
        ],
        "/api/reports": [
            {
                "id": identity("report"),
                "name": report_names(module.key, "daily", group, organization=dataset.organization)[
                    0
                ],
                "is_deleted": False,
            }
        ],
    }
    monkeypatch.setattr(boundary, "list_all_rows", lambda client, path, **kwargs: pages[path])
    original = wire.__call__

    def schedule(request):
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
        return original(request)

    context.clients["admin"]._client._transport = httpx.MockTransport(schedule)
    if corrupt:
        wire.chart["query"]["definition"]["deleted"] = "only"
    counts, issues = boundary.verify_openview_controls(
        context.clients["admin"], dataset, manifest, admin_id=context.user_ids["admin"]
    )
    if corrupt:
        assert any("Chart" in issue for issue in issues) and not counts.get("charts_archived")
    else:
        assert issues == [] and counts["charts_archived"] == counts["chart_sources_preserved"] == 1
