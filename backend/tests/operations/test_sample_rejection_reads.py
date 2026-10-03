"""Hidden-module reads are refused without sending a mutation."""

from datetime import date

import httpx
import pytest

from operations.sample_client import SampleClient
from operations.sample_packs.types import RejectionCase
from operations.sample_rejections import RejectionContext, run_rejection
from operations.sample_scenario import build_dataset
from tests.operations.test_sample_packs import _TINY_PACK


def test_a_hidden_record_read_records_the_expected_404_without_writing(tmp_path):
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path))
        assert request.method == "GET"
        return httpx.Response(
            404,
            json={"detail": "Module not found"},
            headers={"X-Request-ID": "00000000-0000-4000-8000-00000000d001"},
        )

    client = SampleClient(
        "https://api.example.test",
        "https://ui.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
    with client:
        context = RejectionContext(
            dataset=build_dataset("small", 17, date(2026, 9, 30), organization=_TINY_PACK),
            admin=client,
            clients={"teacher": client},
            new_client=lambda: client,
            roster_path=tmp_path / "unused.json",
            mappings=lambda: {"record": {"requests:000001": "hidden-record"}},
            build_payload=lambda _key: {},
            field_map=lambda _module: {},
            results=[],
        )
        case = RejectionCase(
            "teacher_opens_hidden_module",
            "teacher",
            ("requests:000001",),
            404,
            "Module not found",
            operation="read-record",
            target_record_id="requests:000001",
        )
        run_rejection(context, case)
        assert context.results[0]["outcome"] == "matched"
        assert context.results[0]["request_id"] == "00000000-0000-4000-8000-00000000d001"
    assert calls == [("GET", "/api/records/hidden-record")]


@pytest.mark.parametrize("key", ("teacher_opens_fee_assessment", "teacher_opens_clinic_visit"))
def test_school_hidden_read_expectation_matches_the_real_record_endpoint(key, monkeypatch):
    from types import SimpleNamespace
    from uuid import uuid4

    from fastapi import HTTPException

    from app.systems.sandbox.records import router
    from operations.sample_packs import get_pack

    # The required offline boundary supplies an existing row and no readable grant.
    # Exercise the actual route error path, rather than inventing a response body.
    record = SimpleNamespace(module_id=uuid4())
    database = SimpleNamespace(get=lambda *_args: record)
    monkeypatch.setattr(router, "module_level", lambda *_args: None)
    case = next(case for case in get_pack("school").rejections.activity_cases if case.key == key)
    with pytest.raises(HTTPException) as refusal:
        router.get_record(uuid4(), SimpleNamespace(id=uuid4()), database)
    assert refusal.value.status_code == case.expected_status
    assert refusal.value.detail == case.expected_detail


def test_refused_record_edit_still_sends_the_frontend_revision_header(tmp_path):
    revision = "2026-09-30T09:15:00Z"

    def handler(request):
        if request.url.path == "/api/auth/login":
            return httpx.Response(200, headers={"Set-Cookie": "openslate_csrf=c; Path=/"})
        if request.method == "GET":
            return httpx.Response(200, json={"data": {}, "updated_at": revision})
        assert request.headers.get("If-Match") == f'"{revision}"'
        return httpx.Response(
            403,
            json={"detail": "Insufficient access"},
            headers={"X-Request-ID": "00000000-0000-4000-8000-00000000d002"},
        )

    with SampleClient(
        "https://api.example.test",
        "https://ui.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        client.login("teacher@example.test", "synthetic-password")
        context = RejectionContext(
            dataset=build_dataset("small", 17, date(2026, 9, 30), organization=_TINY_PACK),
            admin=client,
            clients={"teacher": client},
            new_client=lambda: client,
            roster_path=tmp_path / "unused.json",
            mappings=lambda: {"record": {"requests:000001": "read-only-record"}},
            build_payload=lambda _key: {},
            field_map=lambda _module: {},
            results=[],
        )
        case = RejectionCase(
            "read_only_edit",
            "teacher",
            ("requests:000001",),
            403,
            "Insufficient access",
            operation="edit-record",
            target_record_id="requests:000001",
        )
        run_rejection(context, case)
        assert context.results[0]["outcome"] == "matched"
