"""Plural caller correlation uses real singular receipts and independent fixtures."""

import json
from dataclasses import replace
from datetime import date
from uuid import NAMESPACE_URL, uuid5

import httpx
import pytest

from operations.sample.client import SampleClient, SampleWriteOutcomeUnknown
from operations.sample.controls.openview import execute_openview_control
from operations.sample.controls.openview_queries import plan_openview_query_controls
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.scenario import build_dataset
from tests.operations.sample.controls.sample_openview_snapshots import snapshot_response


def _uuid(value):
    return str(uuid5(NAMESPACE_URL, value))


def _journey(tmp_path, pack_key, *, fault="none", neutral=False):
    dataset = build_dataset("small", 42, date(2026, 9, 30), organization=get_pack(pack_key))
    if neutral:
        dataset = replace(
            dataset,
            organization=replace(
                dataset.organization,
                identity=replace(dataset.organization.identity, key="unrecognized-reference-pack"),
            ),
        )
    actions = plan_openview_query_controls(dataset)
    singles = [
        action
        for action in actions
        if action.values["operation"]
        in {
            "aggregate_snapshot_groups",
            "aggregate_snapshot_date_series",
        }
    ]
    batch = next(
        (action for action in actions if action.values["operation"] == "aggregate_snapshots"),
        replace(
            singles[0],
            key="control:aggregate_snapshots",
            target_key="control:aggregate_snapshots",
            values={
                "operation": "aggregate_snapshots",
                "queries": [action.values["query"] for action in singles],
            },
        ),
    )
    requests = []

    def handler(request):
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200, headers={"Set-Cookie": "openslate_csrf=fixture; Path=/"}, json={"ok": True}
            )
        requests.append(request)
        return snapshot_response(request, fault=fault)

    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
    assert client.login("fixture@example.test", "fixture-password").status_code == 200
    actor = batch.actor_key
    context = PhaseExecutionContext(
        clients={actor: client},
        user_ids={actor: _uuid("actor")},
        group_ids={},
        department_ids={},
        module_ids={
            module.key: _uuid(module.key) for module in dataset.organization.catalog.modules
        },
        field_ids={
            f"{module.key}:{field.key}": _uuid(f"{module.key}:{field.key}")
            for module in dataset.organization.catalog.modules
            for field in module.fields
        },
        mappings={},
        admin_password="fixture-private-password",
    )
    return dataset, singles, batch, context, requests


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
@pytest.mark.parametrize("neutral", (False, True))
def test_plural_snapshots_reuse_owned_singular_receipts_without_extra_requests(
    tmp_path, pack_key, neutral
):
    dataset, singles, batch, context, requests = _journey(tmp_path, pack_key, neutral=neutral)
    with context.clients[batch.actor_key]:
        for action in singles:
            execute_openview_control(action, dataset, context)
        result = execute_openview_control(batch, dataset, context)
    assert [request.url.path for request in requests] == [
        "/api/records/aggregate-snapshot",
        "/api/records/aggregate-snapshot",
        "/api/records/aggregate-snapshots",
    ]
    body = json.loads(requests[-1].content)
    assert [query["mode"] for query in body["queries"]] == ["groups", "date_series"]
    assert body["queries"] == [json.loads(request.content) for request in requests[:2]]
    assert result["outcome"] == "completed" and result["query_totals"] == [0, 15]
    assert result["query_total"] == 15
    assert [row["path"] for row in result["request_evidence"]] == [
        "/api/records/aggregate-snapshots"
    ]
    assert (
        "fixture-private-password"
        not in json.dumps(result) + (tmp_path / "requests.jsonl").read_text()
    )


@pytest.mark.parametrize(
    "fault",
    (
        "denied",
        "unavailable",
        "malformed",
        "missing",
        "extra",
        "reversed",
        "partial",
        "offset",
        "wrong_total",
        "wrong_limit",
        "duplicate_key",
        "wrong_key",
        "wrong_label",
        "bool_count",
        "bool_value",
        "null_count",
        "nonfinite",
        "altered",
        "shape",
        "cache",
        "nosniff",
        "size",
    ),
)
def test_plural_snapshots_refuse_unconfirmed_or_mismatched_results(tmp_path, fault):
    dataset, singles, batch, context, requests = _journey(tmp_path, "harbor", fault=fault)
    with context.clients[batch.actor_key]:
        for action in singles:
            execute_openview_control(action, dataset, context)
        with pytest.raises((SamplePhaseActionError, SampleWriteOutcomeUnknown)) as caught:
            execute_openview_control(batch, dataset, context)
    assert len(requests) == 3 and requests[-1].url.path.endswith("/aggregate-snapshots")
    assert "private-canary" not in str(caught.value)


@pytest.mark.parametrize("fault", ("missing", "actor", "query"))
def test_plural_snapshots_require_exact_actor_and_query_bound_singular_receipts(tmp_path, fault):
    dataset, singles, batch, context, requests = _journey(tmp_path, "harbor")
    with context.clients[batch.actor_key]:
        if fault != "missing":
            for action in singles:
                execute_openview_control(action, dataset, context)
        if fault == "actor":
            context.user_ids = {batch.actor_key: _uuid("other-actor")}
        elif fault == "query":
            queries = [dict(query) for query in batch.values["queries"]]
            queries[1]["from_date"] = "2026-09-24"
            batch = replace(batch, values={**batch.values, "queries": queries})
        with pytest.raises(SamplePhaseActionError):
            execute_openview_control(batch, dataset, context)
    assert not any(request.url.path.endswith("/aggregate-snapshots") for request in requests)
