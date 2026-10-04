"""Planned rejections: requests the API must refuse before it writes anything."""

from __future__ import annotations

from datetime import date
from functools import cache
from pathlib import Path

import pytest

from operations.sample.blueprint import SampleDataset
from operations.sample.episodes import plan_sessions
from operations.sample.scenario import build_dataset
from operations.sample.verification.rejections import (
    ACTIVITY_CASES,
    CLOSING_CASES,
    invalid_record_data,
    outcome_matches,
)


@cache
def _dataset(profile: str) -> SampleDataset:
    return build_dataset(profile, seed=42, anchor_date=date(2026, 9, 30))  # type: ignore[arg-type]


def test_every_activity_case_is_planned_once_after_the_records_it_needs() -> None:
    dataset = _dataset("small")
    created: set[str] = set()
    seen: list[str] = []
    for session in plan_sessions(dataset):
        if session.kind == "create":
            created.update(session.record_ids)
        elif session.kind == "reject":
            case = next(item for item in ACTIVITY_CASES if item.key == session.case_key)
            assert set(case.needs) <= created, case.key
            assert session.creator_key == case.actor_key
            seen.append(case.key)
    assert sorted(seen) == sorted(case.key for case in ACTIVITY_CASES)


def test_cases_cover_each_kind_of_refusal() -> None:
    statuses = {case.expected_status for case in (*ACTIVITY_CASES, *CLOSING_CASES)}
    assert statuses == {401, 403, 404, 409, 412, 422, 428}
    actors = {case.actor_key for case in ACTIVITY_CASES}
    assert {"guest_01", "internal_sales_04", "internal_sales_02", "admin"} <= actors


@pytest.mark.parametrize(
    ("case_key", "problem"),
    [
        ("missing_required_field", "missing"),
        ("unknown_select_option", "option"),
        ("wrong_value_type", "type"),
        ("unknown_field", "unknown"),
    ],
)
def test_invalid_payloads_break_exactly_one_rule(case_key: str, problem: str) -> None:
    dataset = _dataset("small")
    valid = next(record for record in dataset.records if record.logical_id == "customers:000002")
    fields = dataset.field_ids["customers"]
    data = invalid_record_data(dataset, case_key, dict(valid.data))
    if problem == "missing":
        assert fields["name"] not in data
    elif problem == "option":
        assert data[fields["segment"]] not in dataset.document.__str__()
    elif problem == "type":
        assert isinstance(data[fields["credit_limit"]], str)
    else:
        extra = set(data) - set(valid.data)
        assert len(extra) == 1
        assert not extra & {
            value for module in dataset.field_ids.values() for value in module.values()
        }


def test_outcomes_match_on_status_and_detail_not_status_alone() -> None:
    case = next(item for item in ACTIVITY_CASES if item.key == "duplicate_link")
    assert outcome_matches(case, 409, {"detail": "Relationship already exists"})
    assert not outcome_matches(case, 409, {"detail": "Target already has a relationship source"})
    coded = next(item for item in ACTIVITY_CASES if item.key == "unknown_field")
    body = {"detail": {"code": "record_validation_failed", "errors": [{"code": "unknown_field"}]}}
    assert outcome_matches(coded, 422, body)
    assert not outcome_matches(coded, 201, {"id": "created"})


def test_rejection_evidence_requires_every_case_matched_and_no_audit_trace() -> None:
    from operations.sample.verification.rejections import check_rejections

    results = [
        {"case": case.key, "outcome": "matched", "request_id": f"req-{index}"}
        for index, case in enumerate((*ACTIVITY_CASES, *CLOSING_CASES))
    ]
    clean = [{"request_id": "other-request", "entity_type": "records"}]
    assert check_rejections(results, clean) == []
    assert check_rejections(results[:-1], clean)  # a case never ran
    mismatched = [{**results[0], "outcome": "mismatch"}, *results[1:]]
    assert check_rejections(mismatched, clean)
    traced = [*clean, {"request_id": "req-3", "entity_type": "records"}]
    assert check_rejections(results, traced)  # a refused request left an audit row


def test_plan_reports_the_planned_rejections() -> None:
    from operations.seed_sample_data import build_plan_summary

    summary = build_plan_summary(_dataset("small"))
    assert summary["planned_rejections"] == len(ACTIVITY_CASES) + len(CLOSING_CASES) == 15


def test_stale_post_edit_reads_the_published_post_and_sends_its_previous_revision(
    tmp_path: Path,
) -> None:
    import json

    import httpx

    from operations.sample.client import SampleClient
    from operations.sample.verification.rejections import RejectionContext, run_rejection

    board_id, post_id = "b" * 8, "p" * 8
    sent: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200, json={}, headers=[("set-cookie", "openslate_csrf=c; Path=/")]
            )
        if request.method == "GET" and request.url.path == f"/api/boards/{board_id}":
            return httpx.Response(200, json={"id": board_id, "revision": 7})
        if request.method == "GET":
            if request.url.params.get("view") != "editable":
                return httpx.Response(404, json={"detail": "Post not found"})
            return httpx.Response(200, json={"id": post_id, "post_revision": 3, "title": "Q4"})
        sent.append(json.loads(request.content))
        detail = {"code": "stale_post_revision", "current_revision": 3}
        return httpx.Response(
            409,
            json={"detail": detail},
            headers={"X-Request-ID": "00000000-0000-4000-8000-0000000000aa"},
        )

    transport = httpx.MockTransport(handler)
    client = SampleClient(
        "http://api.example.test",
        "http://app.example.test",
        tmp_path / "j.jsonl",
        transport=transport,
    )
    client.login("lead@example.test", "not-a-real-password")
    context = RejectionContext(
        dataset=_dataset("small"), admin=client, clients={"internal_sales_lead": client},
        new_client=lambda: client, roster_path=tmp_path / "unused.json",
        mappings=lambda: {"boards": {"department:sales": board_id},
                          "posts": {"department:sales:post:03": post_id}},
        build_payload=lambda _logical: {}, field_map=lambda _module: {}, results=[],
    )  # fmt: skip
    case = next(item for item in CLOSING_CASES if item.key == "stale_post_edit")
    run_rejection(context, case)
    client.close()
    assert sent == [{"board_revision": 7, "post_revision": 2, "title": "Q4"}]
    assert context.results[0]["outcome"] == "matched"
