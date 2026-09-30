"""Linking stays safe when the API reports a busy relationship write."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from operations import sample_activity
from operations.sample_activity import _link, _RuleWaits
from operations.sample_client import SampleClient, SampleWriteOutcomeUnknown
from operations.sample_population import SamplePopulationError

ORIGIN = "https://workspace.example.test"
FIELD = {"id": "00000000-0000-4000-8000-00000000f001", "relationship_multiple_targets": True}
BUSY = {"detail": "Relationship operation is temporarily unavailable"}


def _client(tmp_path: Path, handler: object) -> SampleClient:
    client = SampleClient(
        "https://api.example.test",
        ORIGIN,
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
    )
    client.login("person@example.test", "not-a-real-password")
    return client


def _login() -> httpx.Response:
    return httpx.Response(
        200,
        json={"authenticated": True},
        headers=[
            ("set-cookie", "openslate_access=opaque; Path=/"),
            ("set-cookie", "openslate_csrf=csrf; Path=/"),
        ],
    )


def _handler(
    posts: list[int], listed: list[dict[str, object]], post_responses: list[httpx.Response]
):
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login()
        if request.method == "GET":
            return httpx.Response(200, json={"items": listed, "pagination": {}})
        posts.append(1)
        return post_responses.pop(0)

    return handle


def test_a_busy_link_that_was_saved_is_not_written_twice(tmp_path: Path) -> None:
    posts: list[int] = []
    handler = _handler(
        posts, [{"id": "00000000-0000-4000-8000-00000000e001"}], [httpx.Response(503, json=BUSY)]
    )
    with _client(tmp_path, handler) as client:
        assert (
            _link(
                client,
                FIELD,
                "00000000-0000-4000-8000-00000000a001",
                "00000000-0000-4000-8000-00000000b001",
            )
            == "00000000-0000-4000-8000-00000000e001"
        )
    assert len(posts) == 1


def test_a_busy_link_that_was_not_saved_is_retried_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sample_activity.time, "sleep", lambda _seconds: None)
    posts: list[int] = []
    responses = [
        httpx.Response(503, json=BUSY),
        httpx.Response(201, json={"id": "00000000-0000-4000-8000-00000000e002"}),
    ]
    with _client(tmp_path, _handler(posts, [], responses)) as client:
        assert (
            _link(
                client,
                FIELD,
                "00000000-0000-4000-8000-00000000a001",
                "00000000-0000-4000-8000-00000000b001",
            )
            == "00000000-0000-4000-8000-00000000e002"
        )
    assert len(posts) == 2


def test_any_other_unavailable_response_stops_without_a_retry(tmp_path: Path) -> None:
    posts: list[int] = []
    other = httpx.Response(503, json={"detail": "Database unavailable"})
    with _client(tmp_path, _handler(posts, [], [other])) as client:
        with pytest.raises(SampleWriteOutcomeUnknown):
            _link(
                client,
                FIELD,
                "00000000-0000-4000-8000-00000000a001",
                "00000000-0000-4000-8000-00000000b001",
            )
    assert len(posts) == 1


def test_repeated_automation_timeouts_stop_the_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sample_activity, "_RULE_WAIT_SECONDS", 0.0)
    record = {"data": {"status-field": "Draft"}}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login()
        return httpx.Response(200, json=record)

    waits = _RuleWaits()
    with _client(tmp_path, handler) as client:
        waits.wait(client, "record-1", "status-field", "Confirmed")
        waits.wait(client, "record-2", "status-field", "Confirmed")
        with pytest.raises(SamplePopulationError, match="automation"):
            waits.wait(client, "record-3", "status-field", "Confirmed")
    assert json.dumps(waits.timeouts) == '["record-1", "record-2", "record-3"]'


def test_records_created_early_in_their_life_cycle_wait_for_create_automations() -> None:
    from datetime import date

    from operations.sample_activity import create_data, rule_candidates
    from operations.sample_history import plan_history, status_label
    from operations.sample_scenario import build_dataset

    dataset = build_dataset("small", seed=42, anchor_date=date(2026, 9, 30))
    histories = plan_history(dataset)
    records = {record.logical_id: record for record in dataset.records}
    total_id = dataset.field_ids["sales_orders"]["total"]
    history_drafts = [
        logical_id
        for logical_id, history in histories.items()
        if logical_id.startswith("sales_orders:")
        and history.initial_status == "Draft"
        and float(records[logical_id].data.get(total_id) or 0) >= 5_000
    ]
    assert history_drafts, "the small profile must exercise this case"
    candidates = rule_candidates(dataset, histories)
    for logical_id in history_drafts:
        assert logical_id in candidates
        data = create_data(dataset, records[logical_id], histories[logical_id])
        assert status_label(dataset, "sales_orders", data) == "Draft"


@pytest.mark.parametrize("already_there", [False, True])
def test_a_history_step_updates_the_whole_record_or_skips_when_already_done(
    tmp_path: Path, already_there: bool
) -> None:
    from operations.sample_activity import _apply_step

    record_id = "00000000-0000-4000-8000-00000000c001"
    current = {
        "status": "done" if already_there else "open",
        "owner": "person-a",
        "name": "Keep me",
    }
    patches: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login()
        if request.method == "GET":
            return httpx.Response(200, json={"id": record_id, "data": dict(current)})
        patches.append(json.loads(request.content))
        return httpx.Response(200, json={"id": record_id, "data": {}})

    with _client(tmp_path, handler) as client:
        changed = _apply_step(client, record_id, {"status": "done", "owner": "person-b"})
    if already_there:
        assert changed is True  # the owner still differs, so the step writes
        assert patches == [{"data": {"status": "done", "owner": "person-b", "name": "Keep me"}}]
    else:
        assert changed is True
        assert patches == [{"data": {"status": "done", "owner": "person-b", "name": "Keep me"}}]


def test_a_history_step_that_is_fully_done_writes_nothing(tmp_path: Path) -> None:
    from operations.sample_activity import _apply_step

    record_id = "00000000-0000-4000-8000-00000000c002"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login()
        assert request.method == "GET", "no write is expected"
        return httpx.Response(200, json={"id": record_id, "data": {"status": "done"}})

    with _client(tmp_path, handler) as client:
        assert _apply_step(client, record_id, {"status": "done"}) is False
