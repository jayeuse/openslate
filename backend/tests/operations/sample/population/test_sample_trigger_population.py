from __future__ import annotations

from dataclasses import replace
from datetime import date
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.history import plan_history
from operations.sample.packs.registry import pack_keys
from operations.sample.population.activity import rule_candidates
from operations.sample.population.run import SamplePopulationError
from operations.sample.population.triggers import (
    _candidate_records,
    _trigger_by_key,
    _wait_trigger,
    validate_record_trigger_candidates,
)
from tests.operations.sample.sample_datasets import sample_dataset


def test_trigger_record_edit_uses_the_read_revision_like_the_frontend(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from operations.sample.population import triggers as workflow

    dataset = sample_dataset()
    blueprint = dataset.organization.blueprint
    key = blueprint.patch_trigger_keys[0]
    dataset = replace(
        dataset,
        organization=replace(
            dataset.organization,
            blueprint=replace(
                blueprint,
                record_created_trigger_keys=(),
                patch_trigger_keys=(key,),
                schedule_trigger_keys=(),
            ),
        ),
    )
    logical_id, changed_field, _ = workflow._trigger_mutation(dataset, key)
    sample = next(row for row in dataset.records if row.logical_id == logical_id)
    record_id, actor_id = str(uuid4()), str(uuid4())
    revision = "2026-10-02T02:15:30.987654Z"
    data = dict(sample.data)
    data[changed_field] = None
    current = {
        "id": record_id,
        "module_id": dataset.module_ids[sample.module_key],
        "updated_at": revision,
        "data": data,
    }
    edits: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(200, headers={"Set-Cookie": "openslate_csrf=fixture; Path=/"})
        if request.method == "GET":
            return httpx.Response(200, json=current)
        assert request.method == "PATCH"
        assert request.headers.get("If-Match") == f'"{revision}"'
        edits.append(request)
        return httpx.Response(200, json=current, headers={"X-Request-ID": str(uuid4())})

    monkeypatch.setattr(workflow, "_wait_trigger", lambda *args, **kwargs: {"trigger_key": key})
    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        client.login("operator@example.test", "fixture-password-only")
        _, mutations = workflow.exercise_record_triggers(
            client,
            dataset,
            {logical_id: current},
            {sample.module_key: {"id": current["module_id"]}},
            {
                f"{module}:{field}": field_id
                for module, fields in dataset.field_ids.items()
                for field, field_id in fields.items()
            },
            {sample.creator_key: actor_id},
            {sample.creator_key: client},
        )
    assert len(edits) == 1
    assert mutations[0]["actor_id"] == actor_id


@pytest.mark.parametrize("organization", pack_keys())
def test_generated_small_dataset_has_real_records_for_created_triggers(organization: str) -> None:
    dataset = sample_dataset("small", 42, date(2026, 9, 29), organization)

    validate_record_trigger_candidates(dataset)


@pytest.mark.parametrize("operator", ("all", "any"))
def test_unconditional_school_rule_candidates_match_engine_group_semantics(operator: str) -> None:
    dataset = sample_dataset(pack="school")
    trigger = _trigger_by_key(dataset, "academic-alert-parent-contact")
    trigger["conditionGroup"]["operator"] = operator
    academic_ids = {
        record.logical_id for record in dataset.records if record.module_key == "academic_alerts"
    }
    # The engine's empty all group matches every record; its empty any group matches none.
    expected = academic_ids if operator == "all" else set()
    assert {record.logical_id for record in _candidate_records(dataset, trigger)} == expected
    assert set(rule_candidates(dataset, plan_history(dataset))) & academic_ids == expected


def test_trigger_readback_requires_succeeded_run_and_action_result(tmp_path: Path) -> None:
    record_id = "00000000-0000-0000-0000-000000000001"
    trigger_id = "00000000-0000-0000-0000-000000000002"
    list_snapshots = 0
    page_reads = 0

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/sandbox/trigger-runs":
            nonlocal list_snapshots, page_reads
            page_reads += 1
            offset = int(request.url.params["offset"])
            if offset == 0:
                list_snapshots += 1
                total = 51
                items = [
                    {
                        "id": trigger_id,
                        "triggerName": "Qualified sales order",
                        "state": "succeeded",
                        "details": {"actionsApplied": 1},
                    }
                ] + [
                    {"triggerName": "Other rule", "state": "skipped", "details": {}}
                    for _ in range(49)
                ]
            elif list_snapshots == 1:
                total = 53
                items = [{"state": "skipped"}] * 3
            else:
                total = 51
                items = [{"state": "skipped"}]
            return httpx.Response(
                200,
                json={
                    "items": items,
                    "limit": 50,
                    "offset": offset,
                    "count": len(items),
                    "total": total,
                    "hasMore": offset + len(items) < total,
                },
            )
        if request.url.path == f"/api/records/{record_id}":
            return httpx.Response(200, json={"id": record_id, "data": {"flag-id": True}})
        raise AssertionError(f"unexpected request: {request.url.path}")

    with SampleClient(
        "http://api.example.test",
        "http://app.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        evidence = _wait_trigger(
            client,
            "order-created-confirmation",
            {"name": "Qualified sales order"},
            target_logical_ids=["sales_orders:000001"],
            target_field_id="flag-id",
            expected_value=True,
            records={"sales_orders:000001": {"id": record_id}},
            timeout=1.0,
        )

    assert evidence["run_ids"] == [trigger_id]
    assert evidence["successful_runs"] == 1
    assert evidence["actions_applied"] == 1
    assert page_reads == 4


def test_matching_record_value_without_succeeded_run_is_not_completion(tmp_path: Path) -> None:
    record_id = "00000000-0000-0000-0000-000000000001"
    record_reads = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal record_reads
        if request.url.path == "/api/sandbox/trigger-runs":
            return httpx.Response(
                200,
                json={
                    "items": [],
                    "limit": 50,
                    "offset": 0,
                    "count": 0,
                    "total": 0,
                    "hasMore": False,
                },
            )
        if request.url.path == f"/api/records/{record_id}":
            record_reads += 1
            return httpx.Response(200, json={"id": record_id, "data": {"flag-id": True}})
        raise AssertionError(f"unexpected request: {request.url.path}")

    with SampleClient(
        "http://api.example.test",
        "http://app.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        with pytest.raises(SamplePopulationError, match="did not produce"):
            _wait_trigger(
                client,
                "order-created-confirmation",
                {"name": "Qualified sales order"},
                target_logical_ids=["sales_orders:000001"],
                target_field_id="flag-id",
                expected_value=True,
                records={"sales_orders:000001": {"id": record_id}},
                timeout=0.01,
            )

    assert record_reads == 0


def test_run_evidence_is_journaled_once_even_when_new_runs_arrive_between_polls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json

    from operations.sample.population import triggers as sample_trigger_population

    monkeypatch.setattr(sample_trigger_population.time, "sleep", lambda _seconds: None)
    record_id = "00000000-0000-0000-0000-000000000011"
    older, newer = "00000000-0000-0000-0000-000000000012", "00000000-0000-0000-0000-000000000013"
    polls = 0

    def run(run_id: str) -> dict[str, object]:
        return {"id": run_id, "triggerName": "Follow up", "state": "succeeded",
                "details": {"actionsApplied": 1}}  # fmt: skip

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal polls
        if request.url.path == "/api/sandbox/trigger-runs":
            polls += 1
            # A history run already exists; the checked record's run arrives next poll.
            items = [run(older)] if polls == 1 else [run(newer), run(older)]
            body = {"items": items, "limit": 50, "offset": 0, "count": len(items),
                    "total": len(items), "hasMore": False}  # fmt: skip
            return httpx.Response(200, json=body)
        value = polls >= 2
        return httpx.Response(200, json={"id": record_id, "data": {"flag-id": value}})

    journal = tmp_path / "requests.jsonl"
    with SampleClient(
        "http://api.example.test",
        "http://app.example.test",
        journal,
        transport=httpx.MockTransport(handler),
    ) as client:
        _wait_trigger(
            client,
            "work-order-state-changed",
            {"name": "Follow up"},
            target_logical_ids=["work_orders:000001"],
            target_field_id="flag-id",
            expected_value=True,
            records={"work_orders:000001": {"id": record_id}},
            timeout=5.0,
        )
    mappings = [
        json.loads(line) for line in journal.read_text().splitlines() if '"id_mapping"' in line
    ]
    by_key: dict[str, set[str]] = {}
    for row in mappings:
        by_key.setdefault(row["logical_id"], set()).add(row["server_id"])
    assert all(len(ids) == 1 for ids in by_key.values()), by_key
