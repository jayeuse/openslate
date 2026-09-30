from __future__ import annotations

from datetime import date
from pathlib import Path

import httpx
import pytest

from operations.sample_client import SampleClient
from operations.sample_population import SamplePopulationError
from operations.sample_scenario import build_dataset
from operations.sample_trigger_population import (
    _wait_trigger,
    validate_record_trigger_candidates,
)


def test_generated_small_dataset_has_real_records_for_created_triggers() -> None:
    dataset = build_dataset("small", 42, date(2026, 9, 29))

    validate_record_trigger_candidates(dataset)


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

    from operations import sample_trigger_population

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
