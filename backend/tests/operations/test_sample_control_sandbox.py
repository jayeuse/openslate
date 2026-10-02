from __future__ import annotations

import json
import re
from dataclasses import asdict
from datetime import date
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest

from operations.sample_blueprint import SampleDataset
from operations.sample_client import SampleClient
from operations.sample_control_sandbox import (
    CONTROL_ROUTES,
    execute_sandbox_control,
    plan_sandbox_controls,
    verify_sandbox_controls,
)
from operations.sample_packs import get_pack
from operations.sample_phase_actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample_scenario import build_dataset

ADMIN_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
TEMP_VERSION_ID = "fc550514-f60a-4e3b-b483-880eed498014"
IMPORT_VERSION_ID = "dc10c8cb-1c5a-4b99-a79e-a95e7897bc70"


def _dataset(pack_key: str = "harbor") -> SampleDataset:
    return build_dataset(
        "small", seed=42, anchor_date=date(2026, 9, 30), organization=get_pack(pack_key)
    )


def _login_response(request: httpx.Request) -> httpx.Response | None:
    if request.url.path != "/api/auth/login":
        return None
    return httpx.Response(
        200,
        headers=[
            ("Set-Cookie", "openslate_csrf=fixture-csrf; Path=/; SameSite=Lax"),
            ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly; SameSite=Lax"),
        ],
        json={"authenticated": True},
    )


def _client(tmp_path: Path, handler) -> SampleClient:
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
    assert client.login("sample@example.test", "fixture-only").status_code == 200
    return client


def _context(tmp_path: Path, handler) -> PhaseExecutionContext:
    return PhaseExecutionContext(
        clients={"admin": _client(tmp_path, handler)},
        user_ids={"admin": ADMIN_ID},
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings={},
        admin_password="fixture-admin-password",
    )


def _route(request: httpx.Request) -> tuple[str, str]:
    path = request.url.path
    if re.fullmatch(r"/api/sandbox/versions/[0-9a-f-]{36}", path):
        path = "/api/sandbox/versions/{version_id}"
    if re.fullmatch(r"/api/sandbox/tests/[0-9a-f-]{36}", path):
        path = "/api/sandbox/tests/{run_id}"
    return request.method, path


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_sandbox_control_plan_is_stable_and_preserves_dataset(pack_key: str) -> None:
    dataset = _dataset(pack_key)
    before = (dataset.document.copy(), dataset.test_vectors)

    actions = plan_sandbox_controls(dataset)

    assert actions == plan_sandbox_controls(dataset)
    assert [action.values["operation"] for action in actions] == [
        "create_checkpoint",
        "update_checkpoint",
        "delete_checkpoint",
        "export_import_document",
        "delete_import_checkpoint",
        "clear_test_history",
        "restore_test_history",
    ]
    assert actions[0].expected_status == 201
    assert actions[1].expected_status == 200
    assert actions[2].expected_status == 204
    assert actions[3].expected_status == 200
    assert actions[4].expected_status == 204
    assert actions[5].expected_status == 204
    assert actions[6].expected_status == 201
    assert dataset.document == before[0]
    assert dataset.test_vectors == before[1]


def test_sandbox_controls_use_ui_shapes_and_recreate_exact_test_vectors(tmp_path: Path) -> None:
    dataset = _dataset()
    actions = plan_sandbox_controls(dataset)
    requests: list[httpx.Request] = []
    document = dataset.document
    revision = 12
    versions: dict[str, dict[str, Any]] = {
        "initial": {
            "id": "b28882a9-4d5d-4542-8da9-2cd540dd98c5",
            "label": "Initial",
            "kind": "checkpoint",
        },
        "published": {
            "id": "99125bd9-da1f-4916-a361-1e14251ae113",
            "label": "Published",
            "kind": "published",
        },
    }
    tests: dict[str, dict[str, Any]] = {
        f"old-{index}": {"id": str(uuid4())} for index, _vector in enumerate(dataset.test_vectors)
    }
    import_checkpoint_id: str | None = None
    created_test_ids: list[str] = []

    def doc_response() -> httpx.Response:
        return httpx.Response(200, json={"document": document, "revision": revision})

    def version_page(request: httpx.Request) -> httpx.Response:
        assert dict(request.url.params) == {"limit": "100", "offset": "0"}
        items = list(versions.values())
        return httpx.Response(
            200,
            json={
                "items": items,
                "limit": 100,
                "offset": 0,
                "count": len(items),
                "total": len(items),
                "hasMore": False,
            },
        )

    def test_page(request: httpx.Request) -> httpx.Response:
        assert dict(request.url.params) == {"limit": "100", "offset": "0"}
        items = list(tests.values())
        return httpx.Response(
            200,
            json={
                "items": items,
                "limit": 100,
                "offset": 0,
                "count": len(items),
                "total": len(items),
                "hasMore": False,
            },
        )

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal revision, import_checkpoint_id
        login = _login_response(request)
        if login is not None:
            return login
        requests.append(request)
        method, path = request.method, request.url.path
        request_id = {"X-Request-ID": str(uuid4())}
        if method == "GET" and path == "/api/sandbox/document":
            return doc_response()
        if method == "POST" and path == "/api/sandbox/versions":
            body = json.loads(request.content)
            assert body == {
                "expectedRevision": revision,
                "kind": "checkpoint",
                "label": actions[0].values["label"],
                "note": actions[0].values["note"],
            }
            revision += 1
            versions[TEMP_VERSION_ID] = {
                "id": TEMP_VERSION_ID,
                "label": body["label"],
                "kind": "checkpoint",
            }
            return httpx.Response(201, headers=request_id, json=versions[TEMP_VERSION_ID])
        if method == "GET" and path == "/api/sandbox/versions":
            return version_page(request)
        if path == f"/api/sandbox/versions/{TEMP_VERSION_ID}" and method == "GET":
            return (
                httpx.Response(200, json=versions[TEMP_VERSION_ID])
                if TEMP_VERSION_ID in versions
                else httpx.Response(404, json={"detail": "Version not found"})
            )
        if path == f"/api/sandbox/versions/{IMPORT_VERSION_ID}" and method == "GET":
            return (
                httpx.Response(200, json=versions[IMPORT_VERSION_ID])
                if IMPORT_VERSION_ID in versions
                else httpx.Response(404, json={"detail": "Version not found"})
            )
        if path == f"/api/sandbox/versions/{TEMP_VERSION_ID}" and method == "PATCH":
            body = json.loads(request.content)
            assert body == {"expectedRevision": revision, "label": actions[1].values["label"]}
            revision += 1
            versions[TEMP_VERSION_ID]["label"] = body["label"]
            return httpx.Response(200, headers=request_id, json=versions[TEMP_VERSION_ID])
        if path == f"/api/sandbox/versions/{TEMP_VERSION_ID}" and method == "DELETE":
            assert json.loads(request.content) == {"expectedRevision": revision}
            revision += 1
            del versions[TEMP_VERSION_ID]
            return httpx.Response(204, headers=request_id)
        if method == "GET" and path == "/api/sandbox/export":
            assert dict(request.url.params) == {"includeVersions": "false"}
            return httpx.Response(
                200,
                headers={"Content-Type": "application/json"},
                json=document,
            )
        if method == "POST" and path == "/api/sandbox/imports":
            body = json.loads(request.content)
            assert body == {"expectedRevision": revision, "bundle": document}
            revision += 1
            import_checkpoint_id = IMPORT_VERSION_ID
            versions[IMPORT_VERSION_ID] = {
                "id": IMPORT_VERSION_ID,
                "label": "Before import",
                "kind": "checkpoint",
            }
            return httpx.Response(
                200, headers=request_id, json={"document": document, "revision": revision}
            )
        if path == f"/api/sandbox/versions/{IMPORT_VERSION_ID}" and method == "DELETE":
            assert json.loads(request.content) == {"expectedRevision": revision}
            revision += 1
            del versions[IMPORT_VERSION_ID]
            return httpx.Response(204, headers=request_id)
        if method == "DELETE" and path == "/api/sandbox/tests":
            assert tests
            tests.clear()
            return httpx.Response(204, headers=request_id)
        if method == "POST" and path == "/api/sandbox/tests":
            body = json.loads(request.content)
            vector = dataset.test_vectors[len(created_test_ids)]
            assert body == {
                "expectedRevision": revision,
                "moduleId": dataset.module_ids[vector.module_key],
                "values": vector.values,
                "event": vector.event,
                "triggerIds": list(vector.trigger_ids),
            }
            test_id = str(uuid4())
            created_test_ids.append(test_id)
            tests[test_id] = {
                "id": test_id,
                "input": {"moduleId": body["moduleId"], "values": body["values"]},
                "event": body["event"],
                "triggerIds": body["triggerIds"],
                "result": {"values": {}, "routes": [], "triggerTraces": [], "issues": []},
            }
            return httpx.Response(201, headers=request_id, json=tests[test_id])
        if method == "GET" and path == "/api/sandbox/tests":
            return test_page(request)
        if method == "GET" and path.startswith("/api/sandbox/tests/"):
            test_id = path.rsplit("/", 1)[1]
            return httpx.Response(200, json=tests[test_id])
        if method == "GET" and path.startswith("/api/sandbox/versions/"):
            return httpx.Response(404, json={"detail": "Version not found"})
        pytest.fail(f"Unexpected request: {method} {path}")

    context = _context(tmp_path, handler)
    results = [execute_sandbox_control(action, dataset, context) for action in actions]
    manifest = {"control_plan": [asdict(action) for action in actions], "control_results": results}

    counts, issues = verify_sandbox_controls(
        context.clients["admin"], dataset, manifest, admin_id=ADMIN_ID
    )

    assert not issues
    assert counts["sandbox_test_runs_verified"] == len(dataset.test_vectors)
    assert counts["sandbox_temporary_versions_removed"] == 2
    assert import_checkpoint_id is not None and import_checkpoint_id not in versions
    assert len(created_test_ids) == len(dataset.test_vectors)
    observed = {_route(request) for request in requests}
    assert CONTROL_ROUTES <= observed


def test_sandbox_verifier_reports_malformed_recorded_plan(tmp_path: Path) -> None:
    dataset = _dataset()

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        pytest.fail(f"Unexpected request while rejecting malformed plan: {request.url.path}")

    counts, issues = verify_sandbox_controls(
        _client(tmp_path, handler),
        dataset,
        {"control_plan": [{}], "control_results": []},
        admin_id=ADMIN_ID,
    )

    assert counts == {
        "sandbox_test_runs_verified": 0,
        "sandbox_temporary_versions_removed": 0,
    }
    assert "Sandbox control plan is invalid" in issues


@pytest.mark.parametrize("has_more,total", ((True, 1), (False, 2)))
def test_sandbox_page_readers_refuse_incomplete_serialized_pages(
    tmp_path: Path, has_more: bool, total: int
) -> None:
    from operations.sample_control_sandbox import _version_list
    from operations.sample_control_sandbox_verification import _read_final_page

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        assert request.method == "GET"
        assert dict(request.url.params) == {"limit": "100", "offset": "0"}
        return httpx.Response(
            200,
            json={
                "items": [{"id": TEMP_VERSION_ID}],
                "limit": 100,
                "offset": 0,
                "count": 1,
                "total": total,
                "hasMore": has_more,
            },
        )

    dataset = _dataset()
    context = _context(tmp_path, handler)
    try:
        action = plan_sandbox_controls(dataset)[3]
        with pytest.raises(SamplePhaseActionError, match="version list was incomplete"):
            _version_list(action, context, [], step="read_versions", on_substep=None)
        for path in ("/api/sandbox/versions", "/api/sandbox/tests"):
            assert _read_final_page(context.clients["admin"], path) is None
    finally:
        context.clients["admin"].close()
