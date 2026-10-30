"""Actual offline executor evidence must be accepted by read-only verification."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.phases.actions import PhaseExecutionContext, execute_phase_action
from operations.sample.phases.plan import (
    phase_action_to_manifest,
    phase_version_documents,
    plan_phases,
)
from operations.sample.phases.verification import verify_phases
from tests.operations.sample.phases.sample_phase_verification_helpers import (
    _server_revocation_event,
)
from tests.operations.sample.sample_datasets import sample_dataset


def _page(request: httpx.Request, rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "items": rows,
        "pagination": {
            "offset": int(request.url.params["offset"]),
            "limit": int(request.url.params["limit"]),
            "count": len(rows),
            "total": len(rows),
            "has_more": False,
        },
    }


@pytest.mark.parametrize(
    "kind", ("refuse_role_change", "refuse_board_archive", "board_purge_preview")
)
def test_real_executor_no_audit_evidence_satisfies_verifier_contract(
    tmp_path: Path, kind: str
) -> None:
    dataset = sample_dataset()
    action = next(action for action in plan_phases(dataset) if action.kind == kind)
    user_ids = {
        person.key: str(uuid5(NAMESPACE_URL, "user:" + person.key))
        for person in dataset.organization.actors.people
    }
    user_ids["admin"] = str(uuid5(NAMESPACE_URL, "admin"))
    board_id = str(uuid5(NAMESPACE_URL, "board:" + action.target_key))
    mappings = {
        "user": user_ids,
        "boards": {action.target_key: board_id},
        "phase_boards": {action.target_key: board_id},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        headers = {"X-Request-ID": str(uuid4())}
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                headers={**headers, "Set-Cookie": "openslate_csrf=fixture; Path=/"},
                json={"ok": True},
            )
        if request.url.path == "/api/audit-logs":
            return httpx.Response(200, headers=headers, json=_page(request, []))
        if request.method == "GET":
            return httpx.Response(
                200,
                headers=headers,
                json={"id": board_id, "scope": "project", "status": "active", "revision": 1},
            )
        if request.url.path.endswith("/purge/preview"):
            return httpx.Response(
                200,
                headers=headers,
                json={
                    "token": "private-preview-value",
                    "confirmation_name": "Archived phase Board",
                    "impact": {
                        "target_id": board_id,
                        "operation": "purge",
                        "impact_digest": "a" * 64,
                    },
                },
            )
        return httpx.Response(403, headers=headers, json={"detail": "Forbidden"})

    clients: dict[str, SampleClient] = {}
    try:
        for actor in {"admin", action.actor_key}:
            client = SampleClient(
                "https://api.example.test",
                "https://workspace.example.test",
                tmp_path / f"{actor}.jsonl",
                transport=httpx.MockTransport(handler),
            )
            clients[actor] = client
            assert client.login("operator@example.test", "in-memory-only").status_code == 200
        context = PhaseExecutionContext(
            clients=clients,
            user_ids=user_ids,
            group_ids={},
            department_ids=dataset.department_ids,
            module_ids=dataset.module_ids,
            field_ids={},
            mappings=mappings,
            admin_password="in-memory-only",
        )
        result = execute_phase_action(action, dataset, context)
        manifest = {
            "phase_plan": [phase_action_to_manifest(action)],
            "phase_results": [result],
            "mappings": mappings,
            "actor_ids": user_ids,
            "people": {key: {"user_id": uid} for key, uid in user_ids.items()},
        }
        observed, issues = verify_phases(
            clients["admin"], dataset=dataset, manifest=manifest, admin_id=user_ids["admin"]
        )
        assert issues == []
        assert observed["phase_requests"] == 1
        assert observed["phase_audit_rows"] == 0
    finally:
        for client in clients.values():
            client.close()


def test_real_executor_restore_and_session_evidence_uses_canonical_ids(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dataset = sample_dataset()
    plan = plan_phases(dataset)
    actions = [
        next(action for action in plan if action.kind == kind)
        for kind in ("end_session", "sandbox_restore_publish")
    ]
    session_action, restore_action = actions
    document = phase_version_documents(dataset, plan)["phase_design_open"]
    identifiers = {
        key: str(uuid5(NAMESPACE_URL, "contract:" + key))
        for key in (
            "admin",
            "person",
            "session",
            "document",
            "open",
            "checkpoint",
            "published",
            "publication",
        )
    }
    user_ids = {"admin": identifiers["admin"], session_action.target_key: identifiers["person"]}
    mappings = {
        "user": user_ids,
        "sandbox_versions": {
            str(restore_action.values["restore_version_key"]): identifiers["open"]
        },
    }
    audits: dict[str, list[dict[str, Any]]] = {}
    security_events: list[dict[str, Any]] = []
    restored = False
    verifying = False
    unsafe_reads: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal restored
        path = request.url.path
        request_id = str(uuid4())
        headers = {"X-Request-ID": request_id}
        if path == "/api/auth/login":
            return httpx.Response(
                200,
                headers={**headers, "Set-Cookie": "openslate_csrf=fixture; Path=/"},
                json={"ok": True},
            )
        if path == "/api/audit-logs":
            return httpx.Response(
                200, json=_page(request, audits[request.url.params["request_id"]])
            )
        if path == "/api/security-events":
            assert set(request.url.params) == {"limit", "offset", "occurred_before"}
            return httpx.Response(200, json=_page(request, security_events))
        if request.method == "GET":
            if path == "/api/auth/sessions":
                return httpx.Response(200, json=[{"id": identifiers["session"], "current": True}])
            if path.endswith("/sessions") or path == "/api/records":
                return httpx.Response(200, json=_page(request, []))
            if path == "/api/sandbox/document":
                return httpx.Response(200, json={"document": document, "revision": 8})
            if path == "/api/sandbox/versions":
                rows = [{"id": identifiers["open"], "kind": "published", "label": "Open"}]
                if restored:
                    rows.append(
                        {
                            "id": identifiers["checkpoint"],
                            "kind": "checkpoint",
                            "label": "Before restore",
                        }
                    )
                return httpx.Response(
                    200, json={"items": rows, "total": len(rows), "hasMore": False}
                )
            if path == f"/api/sandbox/versions/{identifiers['checkpoint']}":
                return httpx.Response(
                    200,
                    json={
                        "id": identifiers["checkpoint"],
                        "kind": "checkpoint",
                        "label": "Before restore",
                        "document": document,
                    },
                )
        if verifying:
            unsafe_reads.append(path)
            pytest.fail("Verifier made an unsafe request")
        primary: tuple[str, str, str] | None = None
        if request.method == "DELETE":
            assert path == f"/api/users/{identifiers['person']}/sessions/{identifiers['session']}"
            security_events.append(
                _server_revocation_event(
                    monkeypatch,
                    actor_id=identifiers["admin"],
                    person_id=identifiers["person"],
                    session_id=identifiers["session"],
                    request_id=request_id,
                )
            )
            response = httpx.Response(204, headers=headers)
        elif path == f"/api/sandbox/versions/{identifiers['open']}/restorations":
            assert json.loads(request.content) == {"expectedRevision": 8}
            restored = True
            primary = ("sandbox_documents", identifiers["document"], "update")
            response = httpx.Response(
                201, headers=headers, json={"document": document, "revision": 9}
            )
        elif path == "/api/sandbox/publication-previews":
            assert json.loads(request.content) == {"expectedRevision": 9}
            response = httpx.Response(
                200,
                headers=headers,
                json={
                    "previewToken": "private-preview",
                    "impactDigest": "a" * 64,
                    "documentRevision": 9,
                    "blockers": [],
                },
            )
        elif path == "/api/sandbox/publications":
            primary = ("sandbox_versions", identifiers["published"], "create")
            response = httpx.Response(
                201,
                headers=headers,
                json={"version": {"id": identifiers["published"], "kind": "published"}},
            )
        else:
            pytest.fail(f"Unexpected request: {request.method} {path}")
        audits[request_id] = (
            []
            if primary is None
            else [
                {
                    "entity_type": primary[0],
                    "entity_id": primary[1],
                    "action": primary[2],
                    "performed_by": identifiers["admin"],
                    "request_id": request_id,
                    "request_method": request.method,
                    "request_path": path,
                }
            ]
        )
        if primary is not None and path.endswith("/restorations"):
            audits[request_id].append(
                audits[request_id][0]
                | {
                    "entity_type": "sandbox_versions",
                    "entity_id": identifiers["checkpoint"],
                    "action": "create",
                }
            )
        if path == "/api/sandbox/publications":
            audits[request_id].append(
                audits[request_id][0]
                | {"entity_type": "sandbox_publications", "entity_id": identifiers["publication"]}
            )
        return response

    clients: dict[str, SampleClient] = {}
    try:
        for actor in user_ids:
            client = SampleClient(
                "https://api.example.test",
                "https://workspace.example.test",
                tmp_path / f"{actor}.jsonl",
                transport=httpx.MockTransport(handler),
            )
            clients[actor] = client
            assert client.login("operator@example.test", "in-memory-only").status_code == 200
        context = PhaseExecutionContext(
            clients=clients,
            user_ids=user_ids,
            group_ids={},
            department_ids={},
            module_ids={},
            field_ids={},
            mappings=mappings,
            admin_password="in-memory-only",
        )
        results = [execute_phase_action(action, dataset, context) for action in actions]
        manifest = {
            "phase_plan": [phase_action_to_manifest(action) for action in actions],
            "phase_results": results,
            "mappings": context.runtime_mappings,
            "actor_ids": user_ids,
            "finished_at": "2026-10-29T08:00:00+00:00",
        }
        verifying = True
        observed, issues = verify_phases(
            clients["admin"], dataset=dataset, manifest=manifest, admin_id=identifiers["admin"]
        )
        assert issues == []
        assert observed["phase_requests"] == 4
        assert observed["phase_primary_audits"] == 2
        assert observed["phase_audit_rows"] == 4
        assert observed["phase_security_events"] == 1
        assert observed["phase_state_checks"] == 1
        assert unsafe_reads == []
        assert "private-preview" not in json.dumps(results)
        assert "in-memory-only" not in json.dumps(results)
    finally:
        for client in clients.values():
            client.close()
