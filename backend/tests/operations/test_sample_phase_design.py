from __future__ import annotations

import copy
import json
from datetime import date
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.packs import get_pack
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.phases.design import execute_design_phase_action
from operations.sample.phases.plan import phase_version_documents, plan_phases
from operations.sample.scenario import build_dataset

ADMIN_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
NEW_MODULE_ID = "912c1dce-6bee-4d26-9e62-c6b9c7bba36b"
OPEN_VERSION_ID = "dc10c8cb-1c5a-4b99-a79e-a95e7897bc70"
CHECKPOINT_ID = "fc550514-f60a-4e3b-b483-880eed498014"
LIVE_NEW_MODULE_ID = "b28882a9-4d5d-4542-8da9-2cd540dd98c5"
LIVE_TITLE_FIELD_ID = "99125bd9-da1f-4916-a361-1e14251ae113"
LIVE_ADDED_FIELD_ID = "7008e198-fd42-4881-836e-4d6303b6537b"


def _login_response(request: httpx.Request) -> httpx.Response | None:
    if request.url.path != "/api/auth/login":
        return None
    return httpx.Response(
        200,
        headers=[
            ("Set-Cookie", "openslate_csrf=fixture-csrf; Path=/; SameSite=Lax"),
            ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly; SameSite=Lax"),
        ],
        json={"ok": True},
    )


def _dataset():
    return build_dataset(
        "small", seed=42, anchor_date=date(2026, 9, 30), organization=get_pack("harbor")
    )


def _context(tmp_path, handler, *, mappings=None, module_ids=None):
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
    assert client.login("admin@example.test", "fixture-password").status_code == 200
    return PhaseExecutionContext(
        clients={"admin": client},
        user_ids={"admin": ADMIN_ID},
        group_ids={},
        department_ids={},
        module_ids=module_ids or {},
        field_ids={},
        mappings=mappings or {},
        admin_password="fixture-admin-password",
    )


def _action(kind: str, values: dict[str, object]) -> PhaseAction:
    return PhaseAction(
        key=f"reorganization.{kind}",
        phase="reorganization",
        kind=kind,  # type: ignore[arg-type]
        actor_key="admin",
        target_key="sandbox:design",
        values=values,
        expected_status=201,
        expected_detail=None,
        expected_end_state={},
    )


def test_edit_publish_then_add_module_publish_records_only_planned_mappings(tmp_path) -> None:
    dataset = _dataset()
    actions = plan_phases(dataset)
    planned = next(action for action in actions if action.kind == "sandbox_edit_publish")
    close_action = next(
        action for action in actions if action.kind == "sandbox_close_empty_publish"
    )
    reopen_action = next(
        action for action in actions if action.kind == "sandbox_reopen_empty_publish"
    )
    live_document = copy.deepcopy(dataset.document)
    revision = 1
    publish_sequence = 1
    seen: list[httpx.Request] = []
    target_module_live_id = "e2e6d540-7f69-4f3a-9980-53f2472dcd2a"

    def page(items: list[dict[str, object]], request: httpx.Request) -> dict[str, object]:
        return {
            "items": items,
            "pagination": {
                "limit": 100,
                "offset": int(request.url.params["offset"]),
                "count": len(items),
                "total": len(items),
                "has_more": False,
            },
        }

    def json_response(status_code: int, body: dict[str, object]) -> httpx.Response:
        return httpx.Response(
            status_code,
            headers={"X-Request-ID": str(uuid4())},
            json=body,
        )

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal live_document, revision, publish_sequence
        login = _login_response(request)
        if login is not None:
            return login
        seen.append(request)
        if request.method == "GET" and request.url.path == "/api/sandbox/document":
            return json_response(200, {"document": live_document, "revision": revision})
        if request.method == "PUT" and request.url.path == "/api/sandbox/document":
            body = json.loads(request.content)
            assert body["expectedRevision"] == revision
            live_document = body["document"]
            revision += 1
            return json_response(200, {"document": live_document, "revision": revision})
        if request.method == "POST" and request.url.path == "/api/sandbox/publication-previews":
            body = json.loads(request.content)
            assert body == {"expectedRevision": revision}
            return json_response(
                200,
                {
                    "previewToken": f"preview-secret-{revision}",
                    "impactDigest": f"{revision:064x}",
                    "documentRevision": revision,
                    "blockers": [],
                },
            )
        if request.method == "POST" and request.url.path == "/api/sandbox/publications":
            body = json.loads(request.content)
            assert body["expectedRevision"] == revision
            assert body["previewToken"] == f"preview-secret-{revision}"
            version_id = str(uuid4())
            publish_sequence += 1
            return json_response(
                201,
                {
                    "id": str(uuid4()),
                    "version": {
                        "id": version_id,
                        "sequence": publish_sequence,
                        "kind": "published",
                        "label": f"Version {publish_sequence}",
                    },
                },
            )
        if request.method == "GET" and request.url.path == "/api/records":
            assert request.url.params["module_id"] == LIVE_NEW_MODULE_ID
            return httpx.Response(
                200,
                json={"items": [], "pagination": {"total": 0}},
            )
        if request.method == "GET" and request.url.path == "/api/modules":
            target_spec = next(
                module
                for module in dataset.organization.catalog.modules
                if module.key == planned.values["module_key"]
            )
            rows = [
                {
                    "id": target_module_live_id,
                    "module_name": planned.values["renamed_module_name"],
                    "department_id": context.department_ids[target_spec.department],
                    "is_deleted": False,
                },
                {
                    "id": LIVE_NEW_MODULE_ID,
                    "module_name": planned.values["new_module_name"],
                    "department_id": context.department_ids[
                        str(planned.values["new_module_department_key"])
                    ],
                    "is_deleted": False,
                },
            ]
            return httpx.Response(200, json=page(rows, request))
        if request.method == "GET" and request.url.path == "/api/fields":
            rows = [
                row
                for row in [
                    {
                        "id": LIVE_ADDED_FIELD_ID,
                        "name": planned.values["added_field_name"],
                        "module_id": target_module_live_id,
                        "is_deleted": False,
                    },
                    {
                        "id": LIVE_TITLE_FIELD_ID,
                        "name": planned.values["title_field_name"],
                        "module_id": LIVE_NEW_MODULE_ID,
                        "is_deleted": False,
                    },
                ]
                if row["module_id"] == request.url.params["module_id"]
            ]
            return httpx.Response(200, json=page(rows, request))
        pytest.fail(f"Unexpected request: {request.method} {request.url.path}")

    context = _context(
        tmp_path,
        handler,
        mappings={"modules": {str(planned.values["module_key"]): target_module_live_id}},
        module_ids={str(planned.values["module_key"]): target_module_live_id},
    )
    context.department_ids.update(
        {key: str(uuid4()) for key, _ in dataset.organization.catalog.departments}
    )

    result = execute_design_phase_action(planned, dataset, context)
    closed_result = execute_design_phase_action(close_action, dataset, context)
    reopened_result = execute_design_phase_action(reopen_action, dataset, context)

    put_documents = [
        json.loads(request.content)["document"] for request in seen if request.method == "PUT"
    ]
    assert len(put_documents) == 4
    assert len(put_documents[0]["design"]["modules"]) == len(dataset.document["design"]["modules"])
    assert (
        len(put_documents[1]["design"]["modules"]) == len(dataset.document["design"]["modules"]) + 1
    )
    assert put_documents[2]["design"]["modules"][-1]["closed"] is True
    assert put_documents[3]["design"]["modules"][-1]["closed"] is False
    mappings = {(row["kind"], row["logical_id"], row["server_id"]) for row in result["mappings"]}
    assert {(kind, logical_id) for kind, logical_id, _server_id in mappings} >= {
        ("sandbox_versions", "phase_design_edited"),
        ("sandbox_versions", "phase_design_open"),
        ("modules", str(planned.values["new_module_key"])),
        ("fields", f"{planned.values['module_key']}:{planned.values['added_field_key']}"),
        ("fields", f"{planned.values['new_module_key']}:name"),
    }
    assert ("modules", str(planned.values["new_module_key"]), LIVE_NEW_MODULE_ID) in mappings
    assert (
        "fields",
        f"{planned.values['module_key']}:{planned.values['added_field_key']}",
        LIVE_ADDED_FIELD_ID,
    ) in mappings
    assert (
        "fields",
        f"{planned.values['new_module_key']}:name",
        LIVE_TITLE_FIELD_ID,
    ) in mappings
    assert "preview-secret-" not in json.dumps(result)
    assert "fixture-admin-password" not in json.dumps(result)
    assert closed_result["mappings"][0]["logical_id"] == "phase_design_closed"
    assert reopened_result["mappings"][0]["logical_id"] == "phase_design_reopened"


def test_close_empty_module_stops_before_document_write_when_records_exist(tmp_path) -> None:
    dataset = _dataset()
    actions = plan_phases(dataset)
    doc = phase_version_documents(dataset, actions)["phase_design_open"]
    close_action = next(
        action for action in actions if action.kind == "sandbox_close_empty_publish"
    )
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        seen.append(request)
        if request.url.path == "/api/sandbox/document":
            return httpx.Response(200, json={"document": doc, "revision": 4})
        if request.url.path == "/api/records":
            assert request.url.params["module_id"] == LIVE_NEW_MODULE_ID
            return httpx.Response(
                200,
                json={"items": [{"id": str(uuid4())}], "pagination": {"total": 1}},
            )
        pytest.fail(
            f"Unexpected request after non-empty module check: {request.method} {request.url.path}"
        )

    context = _context(
        tmp_path,
        handler,
        mappings={"modules": {"phase_checklist": LIVE_NEW_MODULE_ID}},
        module_ids={"phase_checklist": LIVE_NEW_MODULE_ID},
    )

    with pytest.raises(SamplePhaseActionError, match="empty"):
        execute_design_phase_action(close_action, dataset, context)

    assert [(request.method, request.url.path) for request in seen] == [
        ("GET", "/api/sandbox/document"),
        ("GET", "/api/records"),
    ]


def test_restore_published_version_uses_checkpoint_restore_preview_publish_and_redacts_secrets(
    tmp_path,
) -> None:
    dataset = _dataset()
    actions = plan_phases(dataset)
    document = phase_version_documents(dataset, actions)["phase_design_open"]
    seen: list[httpx.Request] = []
    preview_token = "private-preview-token"
    request_ids = iter(str(uuid4()) for _ in range(12))

    def response(status_code: int, body: dict[str, object]) -> httpx.Response:
        return httpx.Response(
            status_code,
            headers={"X-Request-ID": next(request_ids)},
            json=body,
        )

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        seen.append(request)
        if request.method == "GET" and request.url.path == "/api/sandbox/document":
            return response(200, {"document": document, "revision": 8})
        if request.method == "GET" and request.url.path == "/api/sandbox/versions":
            if (
                request.url.params["offset"] == "0"
                and len([item for item in seen if item.url.path == "/api/sandbox/versions"]) == 1
            ):
                return response(
                    200,
                    {
                        "items": [{"id": OPEN_VERSION_ID, "kind": "published", "label": "Open"}],
                        "limit": 100,
                        "offset": 0,
                        "count": 1,
                        "total": 1,
                        "hasMore": False,
                    },
                )
            return response(
                200,
                {
                    "items": [
                        {"id": CHECKPOINT_ID, "kind": "checkpoint", "label": "Before restore"},
                        {"id": OPEN_VERSION_ID, "kind": "published", "label": "Open"},
                    ],
                    "limit": 100,
                    "offset": 0,
                    "count": 2,
                    "total": 2,
                    "hasMore": False,
                },
            )
        if request.method == "GET" and request.url.path == f"/api/sandbox/versions/{CHECKPOINT_ID}":
            return response(
                200,
                {
                    "id": CHECKPOINT_ID,
                    "kind": "checkpoint",
                    "label": "Before restore",
                    "document": document,
                },
            )
        if request.method == "POST" and request.url.path.endswith(
            f"/{OPEN_VERSION_ID}/restorations"
        ):
            assert json.loads(request.content) == {"expectedRevision": 8}
            return response(201, {"document": document, "revision": 9})
        if request.method == "POST" and request.url.path == "/api/sandbox/publication-previews":
            assert json.loads(request.content) == {"expectedRevision": 9}
            return response(
                200,
                {
                    "previewToken": preview_token,
                    "impactDigest": "a" * 64,
                    "documentRevision": 9,
                    "blockers": [],
                    "counts": {
                        "departments": 0,
                        "modules": 0,
                        "fields": 0,
                        "relationships": 0,
                        "triggers": 0,
                    },
                },
            )
        if request.method == "POST" and request.url.path == "/api/sandbox/publications":
            body = json.loads(request.content)
            assert body == {
                "expectedRevision": 9,
                "previewToken": preview_token,
                "impactDigest": "a" * 64,
                "password": "fixture-admin-password",
                "note": "Publish the planned restored design.",
            }
            assert request.headers["Idempotency-Key"]
            return response(
                201,
                {
                    "id": str(uuid4()),
                    "version": {
                        "id": str(uuid4()),
                        "sequence": 8,
                        "kind": "published",
                        "label": "Restored",
                    },
                },
            )
        pytest.fail(f"Unexpected request: {request.method} {request.url.path}")

    context = _context(
        tmp_path,
        handler,
        mappings={"sandbox_versions": {"phase_design_open": OPEN_VERSION_ID}},
    )
    action = next(action for action in actions if action.kind == "sandbox_restore_publish")

    result = execute_design_phase_action(action, dataset, context)

    assert [request.url.path for request in seen] == [
        "/api/sandbox/document",
        "/api/sandbox/versions",
        "/api/sandbox/versions/" + OPEN_VERSION_ID + "/restorations",
        "/api/sandbox/versions",
        "/api/sandbox/versions/" + CHECKPOINT_ID,
        "/api/sandbox/publication-previews",
        "/api/sandbox/publications",
    ]
    assert not any("rollbacks" in request.url.path for request in seen)
    serialized = json.dumps(result)
    assert preview_token not in serialized
    assert "fixture-admin-password" not in serialized
    assert result["mappings"][0] == {
        "kind": "sandbox_versions",
        "logical_id": "phase_before_restore_checkpoint",
        "server_id": CHECKPOINT_ID,
    }
    assert result["mappings"][1]["kind"] == "sandbox_versions"
    assert result["mappings"][1]["logical_id"] == "phase_design_restored"
