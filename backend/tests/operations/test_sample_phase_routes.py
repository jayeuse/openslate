from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

import httpx

from operations.sample_client import SampleClient
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_phase_actions import PhaseExecutionContext, execute_phase_action

ADMIN_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
MEMBER_ID = "9ec0d287-ae14-4603-91c2-f9a4d7b73c0a"
TARGET_ID = "e40862a7-fbb7-4e71-a590-90e11f4e893d"
GROUP_ID = "4f10e3a8-6798-4ae8-bf5a-66ef6c54c02e"
VIEW_ID = "637511d1-65ad-4493-bad2-cb30770aa27d"
SESSION_ID = "afcbdbaf-debe-407b-9a4b-1400dd8f3696"


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


def _client(tmp_path, handler) -> SampleClient:
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
    assert client.login("sample@example.test", "not-used-by-the-fixture").status_code == 200
    return client


def _context(tmp_path, handlers: Mapping[str, Any], *, mappings=None) -> PhaseExecutionContext:
    clients = {actor: _client(tmp_path / actor, handler) for actor, handler in handlers.items()}
    return PhaseExecutionContext(
        clients=clients,
        user_ids={"admin": ADMIN_ID, "member": MEMBER_ID, "target": TARGET_ID},
        group_ids={"finance-office": GROUP_ID},
        department_ids={"finance": "56af8be1-8862-47a8-9906-1717395ccf20"},
        module_ids={},
        field_ids={},
        mappings=mappings or {},
        admin_password="fixture-admin-password",
    )


def _action(
    kind: str,
    *,
    actor: str,
    target: str,
    values: dict[str, Any],
    status: int = 200,
) -> PhaseAction:
    return PhaseAction(
        key=f"reorganization:{kind}",
        phase="reorganization",
        kind=kind,  # type: ignore[arg-type]
        actor_key=actor,
        target_key=target,
        values=values,
        expected_status=status,
        expected_detail="Forbidden" if status == 403 else None,
        expected_end_state={},
    )


def test_openview_archive_and_restore_use_owner_revision_and_real_audit_actions(tmp_path) -> None:
    seen: list[httpx.Request] = []
    is_deleted = False
    revision = 9

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal is_deleted, revision
        login = _login_response(request)
        if login is not None:
            return login
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(
                200,
                json={"id": VIEW_ID, "revision": revision, "is_deleted": is_deleted},
            )
        if request.method == "DELETE":
            assert request.url.params["revision"] == str(revision)
            is_deleted = True
            revision += 1
            return httpx.Response(204, headers={"X-Request-ID": str(uuid4())})
        assert request.method == "POST"
        assert json.loads(request.content) == {"revision": revision}
        is_deleted = False
        revision += 1
        return httpx.Response(
            200,
            headers={"X-Request-ID": str(uuid4())},
            json={"id": VIEW_ID, "revision": revision, "is_deleted": False},
        )

    context = _context(
        tmp_path,
        {"member": handler},
        mappings={"views": {"saved-view": VIEW_ID}},
    )
    values = {"resource_kind": "view", "department_key": "finance", "module_key": "sales"}
    archive = _action(
        "openview_archive", actor="member", target="saved-view", values=values, status=204
    )
    restore = _action("openview_restore", actor="member", target="saved-view", values=values)

    archived_result = execute_phase_action(archive, None, context)  # type: ignore[arg-type]
    restored_result = execute_phase_action(restore, None, context)  # type: ignore[arg-type]

    assert [(request.method, request.url.path) for request in seen] == [
        ("GET", f"/api/views/{VIEW_ID}"),
        ("DELETE", f"/api/views/{VIEW_ID}"),
        ("GET", f"/api/views/{VIEW_ID}"),
        ("POST", f"/api/views/{VIEW_ID}/restore"),
    ]
    assert seen[1].url.params["revision"] == "9"
    assert json.loads(seen[3].content) == {"revision": 10}
    assert archived_result["request_evidence"][0]["primary_entity_type"] == "saved_views"
    assert archived_result["request_evidence"][0]["primary_action"] == "delete"
    assert restored_result["request_evidence"][0]["primary_action"] == "update"


def test_end_session_reads_the_target_client_and_revokes_only_its_current_session(tmp_path) -> None:
    seen: list[tuple[str, httpx.Request]] = []

    def target_handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        seen.append(("target", request))
        assert request.method == "GET" and request.url.path == "/api/auth/sessions"
        return httpx.Response(
            200,
            json=[
                {"id": str(uuid4()), "current": False},
                {"id": SESSION_ID, "current": True},
            ],
        )

    def admin_handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        seen.append(("admin", request))
        return httpx.Response(204, headers={"X-Request-ID": str(uuid4())})

    context = _context(tmp_path, {"target": target_handler, "admin": admin_handler})
    action = _action(
        "end_session",
        actor="admin",
        target="target",
        values={"person_key": "target", "current_session": True},
        status=204,
    )

    result = execute_phase_action(action, None, context)  # type: ignore[arg-type]

    assert seen[0][0] == "target"
    assert seen[1][0] == "admin"
    assert seen[1][1].method == "DELETE"
    assert seen[1][1].url.path == f"/api/users/{TARGET_ID}/sessions/{SESSION_ID}"
    assert result["session_id"] == SESSION_ID
    assert result["request_evidence"][0]["primary_entity_type"] is None
    assert result["request_evidence"][0]["primary_entity_id"] is None
    assert result["request_evidence"][0]["primary_action"] is None
    assert result["request_evidence"][0]["expected_audit_rows"] == 0


def test_expected_role_refusal_records_no_primary_audit(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        return httpx.Response(
            403,
            headers={"X-Request-ID": str(uuid4())},
            json={"detail": "Forbidden"},
        )

    context = _context(tmp_path, {"member": handler})
    action = _action(
        "refuse_role_change",
        actor="member",
        target="target",
        values={"role": "admin"},
        status=403,
    )

    result = execute_phase_action(action, None, context)  # type: ignore[arg-type]

    assert result["outcome"] == "refused"
    evidence = result["request_evidence"][0]
    assert evidence["method"] == "PATCH"
    assert evidence["primary_entity_type"] is None
    assert evidence["primary_action"] is None
    assert evidence["expected_audit_rows"] == 0
