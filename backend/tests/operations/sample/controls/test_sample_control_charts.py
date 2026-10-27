"""Real-client Chart sample journey, source survival and native receipt accounting."""

import json
from copy import deepcopy
from dataclasses import replace
from datetime import date

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.controls.charts import plan_chart_control
from operations.sample.controls.openview import execute_openview_control
from operations.sample.controls.openview_queries import select_openview_target
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext
from operations.sample.phases.planning import _manager_key
from operations.sample.scenario import build_dataset
from tests.operations.sample.controls.sample_chart_query_wire import corrupt_boundary_receipts
from tests.operations.sample.controls.sample_chart_wire import ChartWire, identity


@pytest.fixture
def chart_setup(tmp_path, request):
    pack_key = getattr(request, "param", "harbor")
    dataset = build_dataset(
        "small",
        42,
        date(2026, 9, 30),
        organization=get_pack("harbor" if pack_key == "neutral" else pack_key),
    )
    if pack_key == "neutral":
        pack = dataset.organization
        _, selected, manager = select_openview_target(dataset)
        actor = next(row for row in pack.actors.people if row.key == manager)
        pack = replace(
            pack,
            identity=replace(pack.identity, key="unregistered-neutral-chart-pack"),
            catalog=replace(
                pack.catalog,
                departments=(("neutral", "Neutral department"),),
                modules=(
                    replace(
                        selected, key="neutral-source", name="Neutral module", department="neutral"
                    ),
                ),
            ),
            actors=replace(
                pack.actors,
                department_keys=("neutral",),
                people=(replace(actor, key="neutral-manager", groups=("neutral-group",)),),
                team_keys={"neutral": ("neutral-manager",)},
                group_access={"neutral-group": (("neutral", None, "manage"),)},
            ),
            content=replace(
                pack.content, data=replace(pack.content.data, leads={"neutral": "neutral-manager"})
            ),
            phases=replace(
                pack.phases,
                openview_department_candidates=("neutral",),
                existing_project_board=("Neutral source", "neutral"),
            ),
        )
        dataset = replace(dataset, organization=pack)
    department, module, _ = select_openview_target(dataset)
    manager = _manager_key(dataset.organization, department, module.key, department_scope=True)
    source_dashboard = f"department:{department}:dashboard"
    action = plan_chart_control(dataset)
    wire = ChartWire()
    clients = {}
    try:
        for key in ("admin", manager):
            client = SampleClient(
                "http://sample.test",
                "http://localhost",
                tmp_path / (key + ".jsonl"),
                transport=httpx.MockTransport(wire),
            )
            assert client.login(key + "@sample.test", "fixture-password").status_code == 200
            clients[key] = client
        context = PhaseExecutionContext(
            clients,
            {key: identity("actor:" + key) for key in clients},
            {},
            {department: identity("department")},
            {module.key: identity("module")},
            {f"{module.key}:name": identity("field:title")},
            {"dashboards": {source_dashboard: identity("source:dashboard")}},
            "fixture-password",
        )
        yield dataset, action, context, wire, tmp_path
    finally:
        for client in clients.values():
            client.close()


@pytest.mark.parametrize("chart_setup", ["harbor", "school", "neutral"], indirect=True)
def test_chart_lifecycle_uses_real_client_and_preserves_owned_sources(chart_setup):
    dataset, action, context, wire, tmp_path = chart_setup
    result = execute_openview_control(action, dataset, context)
    assert result["outcome"] == "completed"
    assert result["chart_archived"] is True and result["authored_sources_preserved"] is True
    from operations.sample.controls.request_verification import verify_request_evidence

    manifest = _manifest(context, result)
    issues, observed = [], {"control_requests_verified": 0}
    verify_request_evidence(
        dataset,
        manifest,
        action,
        result,
        context.user_ids,
        context.user_ids["admin"],
        set(),
        observed,
        issues,
    )
    assert issues == []
    from operations.sample.verification.route_coverage import route_template

    assert {
        (method, route_template(method, path))
        for method, path in wire.seen
        if path.startswith("/api/charts")
    } == {
        ("POST", "/api/charts"),
        ("GET", "/api/charts"),
        ("GET", "/api/charts/{chart_id}"),
        ("PATCH", "/api/charts/{chart_id}"),
        ("GET", "/api/charts/{chart_id}/usage"),
        ("DELETE", "/api/charts/{chart_id}"),
        ("POST", "/api/charts/{chart_id}/restore"),
    }
    assert wire.chart["revision"] == 5 and wire.chart["is_deleted"] is True
    assert (
        wire.dashboards[wire.dashboard_id]["revision"] == 4
        and wire.dashboards[wire.dashboard_id]["widgets"] == []
    )
    assert wire.source_before == {
        wire.source_dashboard_id: wire.dashboards[wire.source_dashboard_id]
    }


def _manifest(context, result):
    return {
        "control_results": [result],
        # A real manifest lists sample people only; the administrator is admin_id.
        "actor_ids": {k: v for k, v in context.user_ids.items() if k != "admin"},
        "mappings": {
            **context.runtime_mappings,
            "departments": context.department_ids,
            "modules": context.module_ids,
            "fields": context.field_ids,
        },
    }


def test_retained_chart_dashboard_accounting_requires_verified_identity(chart_setup):
    from operations.sample.controls.charts_verification import certify_retained_chart_dashboards

    dataset, action, context, wire, directory = chart_setup
    result = execute_openview_control(action, dataset, context)
    manifest = _manifest(context, result)
    before = deepcopy(manifest)
    identifiers, issues = certify_retained_chart_dashboards(
        context.clients["admin"], dataset, manifest, context.user_ids["admin"], directory
    )
    assert identifiers == (wire.dashboard_id,) and issues == []
    assert manifest == before


@pytest.mark.parametrize(
    "fault",
    [
        "identity",
        "revision",
        "widgets",
        "archived",
        "receipt",
        "native",
        "duplicate",
        "alias",
        "native_write",
        "current_request",
        "populated_receipt",
        "populated_native",
        "populated_order",
        "populated_native_order",
    ],
)
def test_retained_dashboard_corruption_grants_zero_credit(chart_setup, fault):
    from operations.sample.controls.charts_verification import certify_retained_chart_dashboards

    dataset, action, context, wire, directory = chart_setup
    result = execute_openview_control(action, dataset, context)
    manifest = _manifest(context, result)
    if fault == "identity":
        wire.dashboards[wire.dashboard_id]["id"] = identity("foreign dashboard")
    elif fault == "revision":
        wire.dashboards[wire.dashboard_id]["revision"] = 5
    elif fault == "widgets":
        wire.dashboards[wire.dashboard_id]["widgets"] = [{"unexpected": True}]
    elif fault == "archived":
        wire.dashboards[wire.dashboard_id]["is_deleted"] = False
    elif fault in {"receipt", "populated_receipt"}:
        result["read_receipts"] = [
            row
            for row in result["read_receipts"]
            if row["step"]
            != ("create_chart_dashboard" if fault == "receipt" else "read_populated_dashboard")
        ]
    elif fault == "native":
        for path in directory.glob("*.jsonl"):
            path.write_text("")
    elif fault == "populated_order":
        row = next(
            row for row in result["read_receipts"] if row["step"] == "read_populated_dashboard"
        )
        result["read_receipts"].remove(row)
        result["read_receipts"].insert(0, row)
    elif fault in {"native_write", "populated_native", "populated_native_order"}:
        rows = result["request_evidence" if fault == "native_write" else "read_receipts"]
        receipt = next(
            (
                row
                for row in rows
                if row["step"]
                == ("create_chart" if fault == "native_write" else "read_populated_dashboard")
            ),
            None,
        )
        assert receipt is not None, "Populated Dashboard must have an actual retained GET receipt"
        request_id = receipt["request_id"]
        for path in directory.glob("*.jsonl"):
            events = [json.loads(line) for line in path.read_text().splitlines()]
            if fault == "populated_native_order":
                finish = next((row for row in events if row.get("request_id") == request_id), None)
                if finish is not None:
                    moved = [row for row in events if row.get("attempt_id") == finish["attempt_id"]]
                    events = moved + [row for row in events if row not in moved]
            else:
                events = [row for row in events if row.get("request_id") != request_id]
            path.write_text("".join(json.dumps(row) + "\n" for row in events))
    elif fault == "current_request":
        original = wire.__call__

        def missing_request(request):
            response = original(request)
            if request.url.path == "/api/dashboards/" + wire.dashboard_id:
                del response.headers["X-Request-ID"]
            return response

        context.clients["admin"]._client._transport = httpx.MockTransport(missing_request)
    elif fault == "duplicate":
        manifest["control_results"].append(deepcopy(result))
    else:
        manifest["mappings"]["dashboards"]["forged authored copy"] = wire.dashboard_id
    identifiers, issues = certify_retained_chart_dashboards(
        context.clients["admin"], dataset, manifest, context.user_ids["admin"], directory
    )
    assert identifiers == () and issues


@pytest.mark.parametrize(
    "fault",
    [
        "request_id",
        "actor",
        "path",
        "wrong_409",
        "hidden_usage",
        "source",
        "read_actor",
        "read_path",
        "read_status",
        "create_body",
        "clear_body",
        "write_read_id",
        "append_body",
        "audit_entity",
        "clear_state",
        "append_state",
        "list_missing",
        "list_gap",
        "list_query",
        "list_params",
        "list_total",
        "usage_name",
        "restore_response",
    ],
)
def test_chart_verifier_rejects_corrupt_receipts_or_final_state(chart_setup, fault):
    from operations.sample.controls.request_verification import verify_request_evidence

    dataset, action, context, wire, _ = chart_setup
    result = execute_openview_control(action, dataset, context)
    manifest = _manifest(context, result)
    if fault.startswith("list_") or fault in {"usage_name", "restore_response"}:
        corrupt_boundary_receipts(result, fault)
    elif fault == "request_id":
        result["request_evidence"][1]["request_id"] = result["request_evidence"][0]["request_id"]
    elif fault == "actor":
        result["request_evidence"][0]["actor_id"] = context.user_ids["admin"]
    elif fault == "path":
        result["request_evidence"][1]["path"] = "/api/charts/" + identity("unowned")
    elif fault == "wrong_409":
        result["request_evidence"][0]["status_code"] = 409
    elif fault == "hidden_usage":
        row = next(row for row in result["read_receipts"] if row["step"] == "usage_manager")
        row["response"]["items"].append(
            {"kind": "dashboard", "id": identity("hidden dashboard"), "name": "Hidden canary"}
        )
    elif fault == "source":
        next(row for row in result["read_receipts"] if row["step"] == "final_authored_dashboard")[
            "response"
        ]["name"] = "Changed authored"
    elif fault == "read_actor":
        row = next(
            row for row in result["read_receipts"] if row["step"] == "final_authored_dashboard"
        )
        row["actor_key"], row["actor_id"] = action.actor_key, context.user_ids[action.actor_key]
    elif fault == "read_path":
        next(row for row in result["read_receipts"] if row["step"] == "read_created_chart")[
            "path"
        ] = "/api/charts/" + identity("unowned read")
    elif fault == "read_status":
        next(row for row in result["read_receipts"] if row["step"] == "read_created_chart")[
            "status_code"
        ] = 409
    elif fault == "create_body":
        next(row for row in result["read_receipts"] if row["step"] == "create_chart_dashboard")[
            "request_body"
        ]["department_id"] = identity("unowned department")
    elif fault == "clear_body":
        next(row for row in result["read_receipts"] if row["step"] == "clear_chart_dashboard")[
            "request_body"
        ]["revision"] = 99
    elif fault == "write_read_id":
        result["request_evidence"][0]["request_id"] = identity("unrelated native write")
    elif fault == "append_body":
        row = next(
            row for row in result["read_receipts"] if row["step"] == "attach_dashboard_chart"
        )
        row["request_body"]["widgets"][-1]["chart_id"] = identity("unowned chart")
    elif fault == "audit_entity":
        result["request_evidence"][0]["primary_entity_id"] = identity("unowned audit target")
    else:
        step = "read_cleared_dashboard" if fault == "clear_state" else "attach_dashboard_chart"
        next(row for row in result["read_receipts"] if row["step"] == step)["response"][
            "department_id"
        ] = identity("unowned response department")
    issues, observed = [], {"control_requests_verified": 0}
    verify_request_evidence(
        dataset,
        manifest,
        action,
        result,
        context.user_ids,
        context.user_ids["admin"],
        set(),
        observed,
        issues,
    )
    assert issues and observed["control_requests_verified"] == 0


@pytest.mark.parametrize("fault", [None, "uncertified", "missing_authored", "other_count"])
def test_run_count_boundary_credits_only_native_certified_dashboard(
    chart_setup, monkeypatch, fault
):
    import operations.sample.verification.run as boundary

    dataset, action, context, wire, directory = chart_setup
    result = execute_openview_control(action, dataset, context)
    manifest = {
        **_manifest(context, result),
        "status": "populated",
        "profile": "small",
        "seed": 42,
        "anchor_date": "2026-09-30",
        "content_counts": {"dashboards": 1, "dashboard_widgets": 0},
        "started_at": "2026-09-30T12:00:00Z",
        "finished_at": "2026-09-30T13:00:00Z",
        "people": [],
    }
    before = deepcopy(manifest)
    if fault == "uncertified":
        wire.dashboards[wire.dashboard_id]["id"] = identity("uncertified copy")
    elif fault == "missing_authored":
        del wire.dashboards[wire.source_dashboard_id]
    elif fault == "other_count":
        wire.dashboards[wire.source_dashboard_id]["widgets"] = [{"unplanned": True}]
    monkeypatch.setattr(boundary, "read_run_manifest", lambda *args: manifest)
    monkeypatch.setattr(
        boundary, "_manifest_plan", lambda *args: (dataset.organization, dataset.module_counts)
    )
    monkeypatch.setattr(boundary, "build_dataset", lambda *args, **kwargs: dataset)
    monkeypatch.setattr(boundary, "SampleClient", lambda *args, **kwargs: context.clients["admin"])
    for name in (
        "verify_records_and_relationships",
        "verify_history",
        "verify_rejections",
        "_people_issues",
        "verify_configuration",
        "verify_phases",
        "_verify_triggers",
    ):
        monkeypatch.setattr(boundary, name, lambda *args, **kwargs: ({}, []))
    monkeypatch.setattr(boundary, "read_phase_plan", lambda *args: ())
    seen = []

    def content(client, *, run_manifest, **kwargs):
        seen.append(deepcopy(run_manifest["expected"]))
        rows = client.request("GET", "/api/dashboards", params={"deleted": "include"}).json()[
            "items"
        ]
        return {
            "content_complete": int(
                run_manifest["expected"]
                == {
                    "dashboards": len(rows),
                    "dashboard_widgets": sum(len(row["widgets"]) for row in rows),
                }
            )
        }

    monkeypatch.setattr(boundary, "verify_content", content)
    original = wire.__call__

    def with_identity(request):
        if request.url.path == "/api/dashboards":
            assert request.url.params["deleted"] == "include"
            return httpx.Response(
                200,
                headers={"X-Request-ID": identity("count read")},
                json={"items": list(wire.dashboards.values())},
            )
        if request.url.path == "/api/auth/me":
            return httpx.Response(
                200,
                headers={"X-Request-ID": identity("verify identity")},
                json={"id": context.user_ids["admin"]},
            )
        if request.url.path == "/api/auth/logout":
            return httpx.Response(204, headers={"X-Request-ID": identity("verify logout")})
        return original(request)

    context.clients["admin"]._client._transport = httpx.MockTransport(with_identity)
    report = boundary.verify_sample_data(
        api_url="http://sample.test",
        origin="http://localhost",
        admin_email="admin@sample.test",
        expected_admin_id=context.user_ids["admin"],
        admin_password="fixture-password",
        run_directory=directory,
    )
    assert report.status == ("complete" if fault is None else "incomplete")
    assert seen == [{"dashboards": 1 if fault == "uncertified" else 2, "dashboard_widgets": 0}]
    assert manifest == before
