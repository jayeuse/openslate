"""Real session-revocation writer evidence must satisfy the offline operator verifier."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.phases.actions import PhaseExecutionContext, execute_phase_action
from operations.sample.phases.plan import phase_action_to_manifest, plan_phases
from operations.sample.phases.verification import verify_phases
from operations.sample.scenario import build_dataset
from tests.operations.sample.phases.sample_phase_verification_helpers import (
    _list_payload,
    _server_revocation_event,
)


@pytest.mark.parametrize(
    "fault",
    (
        None,
        "missing",
        "duplicate",
        "event_reuse",
        "invalid_id",
        "missing_id",
        "labels",
        "actor_id",
        "subject_id",
        "request_id",
        "request_method",
        "request_path",
        "event_type",
        "source",
        "outcome",
        "scope",
        "application_audit",
        "http_error",
        "network_error",
        "invalid_json",
        "pagination",
        "page_read_error",
        "changed_total",
        "still_active",
        "session_mapping",
    ),
)
def test_real_session_revocation_security_evidence_is_required_and_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fault: str | None
) -> None:
    dataset = build_dataset("small", 42, date(2026, 9, 30))
    action = next(action for action in plan_phases(dataset) if action.kind == "end_session")
    admin_id, person_id, session_id, other_session_id = (str(uuid4()) for _ in range(4))
    user_ids = {"admin": admin_id, action.target_key: person_id}
    rows: list[dict[str, Any]] = []
    emitted: dict[str, Any] = {}
    requests: list[tuple[str, str]] = []
    verifying = False

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        requests.append((request.method, path))
        if path == "/api/auth/login":
            return httpx.Response(
                200, headers={"Set-Cookie": "openslate_csrf=fixture; Path=/"}, json={"ok": True}
            )
        if not verifying and request.method == "GET" and path == "/api/auth/sessions":
            return httpx.Response(
                200,
                json=[
                    {"id": other_session_id, "current": False},
                    {"id": session_id, "current": True},
                ],
            )
        if not verifying and request.method == "DELETE":
            assert path == f"/api/users/{person_id}/sessions/{session_id}"
            request_id = str(uuid4())
            emitted.update(
                _server_revocation_event(
                    monkeypatch,
                    actor_id=admin_id,
                    person_id=person_id,
                    session_id=session_id,
                    request_id=request_id,
                )
            )
            # Full first page of unrelated, valid response rows; target is on page two.
            rows.extend(
                emitted | {"id": str(uuid4()), "request_id": str(uuid4())} for _ in range(100)
            )
            if fault != "missing":
                rows.append(dict(emitted))
            if fault == "duplicate":
                rows.append(dict(emitted))
            if fault == "event_reuse":
                rows[0]["id"] = emitted["id"]
            altered: dict[str, tuple[str, object]] = {
                "invalid_id": ("id", "invalid"),
                "missing_id": ("id", None),
                "labels": ("labels", []),
                "actor_id": ("actor_id", str(uuid4())),
                "subject_id": ("subject_id", str(uuid4())),
                "request_id": ("request_id", str(uuid4())),
                "request_method": ("request_method", "POST"),
                "request_path": (
                    "request_path",
                    f"/api/users/{person_id}/sessions/{other_session_id}",
                ),
                "event_type": ("event_type", "identity.session_expired"),
                "source": ("source", "auth"),
                "outcome": ("outcome", "denied"),
                "scope": ("labels", {"scope": "all"}),
            }
            if fault in altered:
                key, value = altered[fault]
                rows[-1][key] = value
            return httpx.Response(204, headers={"X-Request-ID": request_id})
        assert request.method == "GET", "Verification must never write"
        if path == "/api/audit-logs":
            audit_rows: list[dict[str, object]] = (
                [{"id": str(uuid4())}] if fault == "application_audit" else []
            )
            return httpx.Response(200, json=_list_payload(request, audit_rows))
        if path == "/api/security-events":
            assert set(request.url.params) == {"limit", "offset"}
            assert "request_id" not in request.url.params
            if fault == "http_error" or (
                fault == "page_read_error" and request.url.params["offset"] == "100"
            ):
                return httpx.Response(503)
            if fault == "network_error":
                raise httpx.ConnectError("private transport detail", request=request)
            if fault == "invalid_json":
                return httpx.Response(200, content=b"invalid")
            page = _list_payload(request, rows)
            if fault == "pagination":
                page["pagination"]["count"] = 0  # type: ignore[index]
            if fault == "changed_total" and request.url.params["offset"] == "100":
                page["pagination"]["total"] = 102  # type: ignore[index]
                page["pagination"]["has_more"] = True  # type: ignore[index]
            return httpx.Response(200, json=page)
        if path == f"/api/users/{person_id}/sessions":
            sessions: list[dict[str, object]] = [{"id": other_session_id}]
            if fault == "still_active":
                sessions.append({"id": session_id})
            return httpx.Response(200, json=_list_payload(request, sessions))
        pytest.fail(f"Unexpected request: {request.method} {path}")

    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        assert client.login("operator@example.test", "in-memory-only").status_code == 200
        context = PhaseExecutionContext(
            clients={actor: client for actor in user_ids},
            user_ids=user_ids,
            group_ids={},
            department_ids={},
            module_ids={},
            field_ids={},
            mappings={"user": user_ids},
            admin_password="in-memory-only",
        )
        result = execute_phase_action(action, dataset, context)
        assert result["session_id"] == session_id
        if fault == "session_mapping":
            result["session_id"] = other_session_id
        manifest = {
            "phase_plan": [phase_action_to_manifest(action)],
            "phase_results": [result],
            "actor_ids": user_ids,
            "mappings": context.runtime_mappings,
        }
        verifying = True
        observed, issues = verify_phases(
            client, dataset=dataset, manifest=manifest, admin_id=admin_id
        )
    if fault is None:
        assert issues == []
        assert observed["phase_security_events"] == 1
        assert observed["phase_primary_audits"] == 0
        assert observed["phase_state_checks"] == 1
        descriptor = result["request_evidence"][0]  # type: ignore[index]
        assert descriptor["primary_entity_type"] is None
        assert descriptor["primary_entity_id"] is None
        assert descriptor["primary_action"] is None
        assert descriptor["expected_audit_rows"] == 0
    else:
        assert issues, f"Invalid {fault} evidence must fail verification"
        if fault == "still_active":
            assert any("explicitly ended session remains active" in issue for issue in issues)
        elif fault == "session_mapping":
            assert any("ended session mapping differs" in issue for issue in issues)
        elif fault == "application_audit":
            assert any("unexpectedly created application audit rows" in issue for issue in issues)
        else:
            assert any("security event" in issue for issue in issues)
    assert observed["phase_audit_rows"] == (1 if fault == "application_audit" else 0)
    assert emitted["id"] not in json.dumps(result)
    assert emitted["id"] not in (tmp_path / "requests.jsonl").read_text()
    assert requests.count(("DELETE", f"/api/users/{person_id}/sessions/{session_id}")) == 1
