"""Bound structural lifecycle within the existing authenticated Sandbox journey."""

from __future__ import annotations

import copy
import json
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest

from operations.sample_client import SampleWriteOutcomeUnknown
from operations.sample_control_sandbox import (
    CONTROL_ROUTES,
    execute_sandbox_control,
    plan_sandbox_controls,
    verify_sandbox_controls,
)
from operations.sample_phase_actions import SamplePhaseActionError
from tests.operations.sample_lifecycle_wire import _LifecycleWire
from tests.operations.test_sample_control_sandbox import (
    ADMIN_ID,
    IMPORT_VERSION_ID,
    TEMP_VERSION_ID,
    _context,
    _dataset,
    _login_response,
)


def _route(request: httpx.Request) -> tuple[str, str]:
    path = request.url.path
    if re.fullmatch(r"/api/sandbox/versions/[0-9a-f-]{36}", path):
        path = "/api/sandbox/versions/{version_id}"
    if re.fullmatch(r"/api/sandbox/tests/[0-9a-f-]{36}", path):
        path = "/api/sandbox/tests/{run_id}"
    for resource, parameter in (
        ("fields", "field"),
        ("modules", "module"),
        ("departments", "department"),
        ("boards", "board"),
    ):
        path = re.sub(
            rf"/api/{resource}/[0-9a-f-]{{36}}", f"/api/{resource}/{{{parameter}_id}}", path
        )
    return request.method, path


@pytest.mark.parametrize(
    "pack_key,fault",
    [
        ("school", "none"),
        *(
            ("harbor", fault)
            for fault in (
                "none",
                "stale_bindings",
                "duplicate_binding",
                "internal_field_id",
                "wrong_parent",
                "invalid_live_id",
                "missing_binding",
                "alias_binding",
                "bad_snapshot",
                "publication_503",
                "wrong_preview_target",
                "empty_confirmation",
                "preview_blocker",
                "no_document_sync",
                "wrong_revision",
                "live_unsynced",
                "wrong_mutation_actor",
                "purge_disabled",
                "purge_draft_remains",
                "board_page_types",
                "final_binding",
                "final_live",
                "final_board",
                "final_snapshot",
                "final_request",
                "final_document_shape",
                "final_mapping_shape",
            )
        ),
    ],
)
def test_sandbox_controls_use_ui_shapes_and_recreate_exact_test_vectors(
    tmp_path: Path, pack_key: str, fault: str
) -> None:
    dataset = _dataset(pack_key)
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
    lifecycle = _LifecycleWire(dataset, versions, lambda: revision, fault)

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
        lifecycle_response = lifecycle.handle(request)
        if lifecycle_response is not None:
            return lifecycle_response
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
    if fault not in {
        "none",
        "final_binding",
        "final_live",
        "final_board",
        "final_snapshot",
        "final_request",
        "final_document_shape",
        "final_mapping_shape",
    }:
        expected_steps = {
            "bad_snapshot": "read_lifecycle_snapshot",
            "wrong_preview_target": "preview_close_field",
            "empty_confirmation": "preview_close_field",
            "preview_blocker": "preview_close_field",
            "wrong_mutation_actor": "close_field",
            "no_document_sync": "read_after_close_field",
            "wrong_revision": "read_after_close_field",
            "live_unsynced": "bindings_after_close_field",
            "purge_disabled": "preview_purge_field",
            "purge_draft_remains": "read_after_purge_field",
            "board_page_types": "read_lifecycle_department_board",
        }
        with pytest.raises((SamplePhaseActionError, SampleWriteOutcomeUnknown)) as raised:
            for action in actions:
                execute_sandbox_control(action, dataset, context)
        if fault == "publication_503":
            assert raised.value.status_code == 503
            assert requests[-1].url.path == "/api/sandbox/publications"
            journal = (tmp_path / "requests.jsonl").read_text()
            assert '"status_code":503' in journal.replace(" ", "")
            from operations.sample_route_coverage import read_route_evidence

            assert (
                sum(read_route_evidence(tmp_path / "requests.jsonl")["failures_5xx"].values()) == 1
            )
        else:
            assert raised.value.step == expected_steps.get(fault, "read_fixture_bindings")
        context.clients["admin"].close()
        return
    results = [execute_sandbox_control(action, dataset, context) for action in actions]
    lifecycle.final_mode = True
    if fault == "final_request":
        next(result for result in results if result["action_key"].endswith(":reopen_field"))[
            "request_evidence"
        ][0]["path"] = f"/api/fields/{str(uuid4())}/reopen"
    manifest = {
        "control_plan": [asdict(action) for action in actions],
        "control_results": results,
        "mappings": copy.deepcopy(context.runtime_mappings),
    }
    if fault == "final_mapping_shape":
        manifest["mappings"] = None

    counts, issues = verify_sandbox_controls(
        context.clients["admin"], dataset, manifest, admin_id=ADMIN_ID
    )

    if fault.startswith("final_"):
        assert any("lifecycle" in issue.lower() for issue in issues), issues
        return
    assert not issues
    assert counts["sandbox_test_runs_verified"] == len(dataset.test_vectors)
    assert counts["sandbox_temporary_versions_removed"] == 2
    assert import_checkpoint_id is not None and import_checkpoint_id not in versions
    assert len(created_test_ids) == len(dataset.test_vectors)
    observed = {_route(request) for request in requests}
    assert CONTROL_ROUTES <= observed
    assert lifecycle.document == dataset.document
    assert not lifecycle.live
    assert lifecycle.board["purged"] is True
    assert counts["sandbox_lifecycle_targets_purged"] == 4
    assert counts["sandbox_lifecycle_boards_purged"] == 1
    assert counts["sandbox_lifecycle_versions_verified"] == 1
    assert {
        row["server_id"] for row in results[7]["mappings"] if row["kind"] == "sandbox_lifecycle"
    } == {*lifecycle.identities.values(), lifecycle.board_id}
    assert all(
        "expected_audit_rows" not in row
        for result in results[7:]
        for row in result["request_evidence"]
    )
    from operations.sample_route_coverage import read_route_evidence

    covered = {
        (row["method"], row["path"])
        for row in read_route_evidence(tmp_path / "requests.jsonl")["covered"]
    }
    lifecycle_routes = {("GET", "/api/sandbox/bindings")}
    lifecycle_routes.update(
        ("POST", f"/api/{kind}s/{{{kind}_id}}/{operation}")
        for kind in ("department", "module", "field")
        for operation in ("close/preview", "close", "reopen", "purge/preview", "purge")
    )
    assert lifecycle_routes <= covered
    journal = (tmp_path / "requests.jsonl").read_text()
    assert "fixture-admin-password" not in journal and "publication-fixture" not in journal
