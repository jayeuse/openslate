"""HTTP authorization and response contracts for Sandbox temporary-input tests."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import Mock

from fastapi import FastAPI
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.sandbox.test_runs.router import router
from app.systems.sandbox.test_runs.schemas import (
    SandboxTestResultResponse,
    SandboxTestRunListResponse,
    SandboxTestRunResponse,
)
from tests.rbac.support import _client, make_user
from tests.sandbox_test_runs.fixtures import option_id


def test_tests_are_administrator_only_for_reads_and_writes(monkeypatch) -> None:
    import app.systems.sandbox.test_runs.router as test_router

    database = Mock(spec=Session)
    application = _application()
    partial = make_user("partial", role="member")
    client = _client(application, partial, database)

    assert client.get("/api/sandbox/tests").status_code == 403
    assert client.post("/api/sandbox/tests", json=_request_body()).status_code == 403

    monkeypatch.setattr(
        test_router,
        "list_runs",
        lambda _db, **_kwargs: SandboxTestRunListResponse(
            items=[], limit=25, offset=0, count=0, total=0, hasMore=False
        ),
    )
    response = _client(application, _user(read=True), database).get("/api/sandbox/tests")

    assert response.status_code == 200
    assert response.json() == {
        "items": [],
        "limit": 25,
        "offset": 0,
        "count": 0,
        "total": 0,
        "hasMore": False,
    }


def test_create_detail_delete_and_validation_follow_the_frontend_contract(monkeypatch) -> None:
    import app.systems.sandbox.test_runs.router as test_router

    database = Mock(spec=Session)
    response_model = _response()
    application = _application()
    writer = _user(write=True)
    create = Mock(return_value=response_model)
    monkeypatch.setattr(test_router, "create_run", create)
    monkeypatch.setattr(test_router, "read_run", lambda *_args, **_kwargs: response_model)
    cleared: list[object] = []
    monkeypatch.setattr(test_router, "clear_runs", lambda *_args, **_kwargs: cleared.append(True))
    client = _client(application, writer, database)

    created = client.post("/api/sandbox/tests", json=_request_body())
    detail = client.get(f"/api/sandbox/tests/{response_model.id}")
    cleared_response = client.delete("/api/sandbox/tests")
    readable_detail = _client(application, _user(read=True), database).get(
        f"/api/sandbox/tests/{response_model.id}"
    )
    client = _client(application, writer, database)
    malformed = client.post(
        "/api/sandbox/tests",
        json={**_request_body(), "event": {"kind": "record-created", "recordId": "made-up"}},
    )

    assert created.status_code == 201
    assert created.headers["location"] == f"/api/sandbox/tests/{response_model.id}"
    assert created.json() == _response_json(response_model)
    assert detail.status_code == 200
    assert readable_detail.status_code == 200
    assert readable_detail.json() == _response_json(response_model)
    assert cleared_response.status_code == 204
    assert cleared_response.content == b""
    assert cleared == [True]
    assert malformed.status_code == 422

    null_threshold = client.post(
        "/api/sandbox/tests",
        json={
            **_request_body(),
            "event": {
                "kind": "threshold-crossed",
                "fieldId": "score",
                "previousValue": None,
            },
        },
    )
    assert null_threshold.status_code == 422
    assert create.call_count == 1


def test_test_result_response_allows_the_bounded_cascade_trace_count() -> None:
    traces = [
        {"triggerId": f"trigger-{index}", "label": "Trigger", "outcome": "Applied"}
        for index in range(501)
    ]

    response = SandboxTestResultResponse.model_validate(
        {"values": {}, "routes": [], "triggerTraces": traces, "issues": []}
    )

    assert len(response.trigger_traces) == 501


def _application() -> FastAPI:
    application = FastAPI()
    application.include_router(router, prefix="/api")
    return application


def _user(*, read: bool = False, write: bool = False):
    """An administrator; the Sandbox has no narrower read or write access."""
    return make_user("test-user")


def _request_body() -> dict[str, object]:
    return {
        "expectedRevision": 1,
        "moduleId": "requests",
        "values": {"priority": option_id("priority", "High"), "status": "", "score": 0},
        "event": {"kind": "record-created"},
    }


def _response() -> SandboxTestRunResponse:
    return SandboxTestRunResponse(
        id=uuid7(),
        createdAt=datetime.now(UTC),
        documentRevision=1,
        input={
            "moduleId": "requests",
            "values": {"priority": option_id("priority", "High"), "status": ""},
        },
        event={"kind": "record-created"},
        triggerIds=None,
        result={
            "values": {"priority": option_id("priority", "High"), "status": "Triaged"},
            "routes": [],
            "triggerTraces": [],
            "issues": [],
        },
    )


def _response_json(response: SandboxTestRunResponse) -> dict[str, object]:
    return response.model_dump(by_alias=True, mode="json")
