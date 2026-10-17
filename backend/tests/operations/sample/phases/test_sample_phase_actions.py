from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleClient, SampleWriteOutcomeUnknown
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    SamplePhaseActionError,
    execute_phase_action,
)
from tests.operations.sample.phases.sample_phase_http_helpers import (
    sample_login_response as _login_response,
)
from tests.operations.sample.phases.sample_phase_http_helpers import sample_phase_context

ADMIN_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
MEMBER_ID = "9ec0d287-ae14-4603-91c2-f9a4d7b73c0a"
TARGET_ID = "e40862a7-fbb7-4e71-a590-90e11f4e893d"
GROUP_ID = "4f10e3a8-6798-4ae8-bf5a-66ef6c54c02e"
BOARD_ID = "aa29e25d-37b3-497c-9dc8-f6faf03f70ca"
VIEW_ID = "637511d1-65ad-4493-bad2-cb30770aa27d"


def _client(
    tmp_path,
    handler,
) -> SampleClient:
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
    login = client.login("sample@example.test", "not-used-by-the-fixture")
    assert login.status_code == 200
    return client


def _context(tmp_path, handlers: Mapping[str, Any], *, mappings=None) -> PhaseExecutionContext:
    clients = {actor: _client(tmp_path / actor, handler) for actor, handler in handlers.items()}
    return sample_phase_context(clients, mappings=mappings)


def test_phase_execution_context_repr_redacts_admin_password(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        assert login is not None
        return login

    context = _context(tmp_path, {"admin": handler})

    assert "fixture-admin-password" not in repr(context)


def _action(
    kind: str,
    *,
    actor: str = "admin",
    target: str = "target",
    values: dict[str, Any] | None = None,
    status: int = 200,
) -> PhaseAction:
    return PhaseAction(
        key=f"test.{kind}",
        phase="admin" if kind.startswith("promote") else "reorganization",
        kind=kind,  # type: ignore[arg-type]
        actor_key=actor,
        target_key=target,
        values=values or {},
        expected_status=status,
        expected_detail="Forbidden" if status == 403 else None,
        expected_end_state={},
    )


def test_promote_user_sends_only_planned_role_change_and_returns_safe_attribution(tmp_path) -> None:
    request_id = str(uuid4())
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        seen.append(request)
        return httpx.Response(
            200,
            headers={"X-Request-ID": request_id},
            json={"id": TARGET_ID, "role": "admin", "status": "active"},
        )

    context = _context(tmp_path, {"admin": handler})
    action = _action("promote_user", target="target", values={"role": "admin"})

    result = execute_phase_action(action, None, context)  # type: ignore[arg-type]

    assert len(seen) == 1
    assert seen[0].method == "PATCH"
    assert seen[0].url.path == f"/api/users/{TARGET_ID}"
    assert json.loads(seen[0].content) == {"role": "admin"}
    assert result["actor_key"] == "admin"
    evidence = result["request_evidence"]
    assert evidence[0]["request_id"] == request_id
    # A role lives on the membership, whose row ID the client cannot see.
    assert evidence[0]["primary_entity_type"] == "memberships"
    assert evidence[0]["primary_entity_id"] is None
    assert evidence[0]["primary_action"] == "update"
    assert evidence[0]["expected_audit_rows"] == 1
    assert "fixture-admin-password" not in repr(result)


def test_group_member_replacement_uses_live_revision_and_complete_member_list(tmp_path) -> None:
    seen: list[httpx.Request] = []
    group_body = {"id": GROUP_ID, "revision": 7, "member_ids": [TARGET_ID, MEMBER_ID]}

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(200, headers={"ETag": f'"{GROUP_ID}:7"'}, json=group_body)
        return httpx.Response(
            200,
            headers={"ETag": f'"{GROUP_ID}:8"', "X-Request-ID": str(uuid4())},
            json={**group_body, "revision": 8, "member_ids": [MEMBER_ID]},
        )

    context = _context(tmp_path, {"admin": handler})
    action = _action(
        "remove_group_member",
        target="target",
        values={"source_group_key": "finance-office", "destination_group_key": "guest-auditors"},
    )

    result = execute_phase_action(action, None, context)  # type: ignore[arg-type]

    assert [request.method for request in seen] == ["GET", "PUT"]
    assert seen[1].url.path == f"/api/access/groups/{GROUP_ID}/members"
    assert seen[1].headers["If-Match"] == f'"{GROUP_ID}:7"'
    assert json.loads(seen[1].content) == {"member_ids": [MEMBER_ID]}
    assert result["request_evidence"][-1]["primary_entity_type"] == "groups"
    assert result["request_evidence"][-1]["primary_action"] == "update"
    assert result["request_evidence"][-1]["expected_audit_rows"] == 1
    assert result["request_evidence"][-1]["related_entity_types"] == ["group_members"]


def test_group_access_replacement_stops_if_live_grant_differs_from_plan(tmp_path) -> None:
    seen: list[httpx.Request] = []
    department_id = "56af8be1-8862-47a8-9906-1717395ccf20"

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(
                200,
                headers={"ETag": f'"{GROUP_ID}:7"'},
                json={
                    "id": GROUP_ID,
                    "revision": 7,
                    "member_ids": [],
                    "access": [
                        {"department_id": department_id, "module_id": None, "level": "manage"}
                    ],
                },
            )
        pytest.fail("A changed live access grant must not be replaced")

    context = _context(tmp_path, {"admin": handler})
    action = _action(
        "replace_group_access",
        target="finance-office",
        values={
            "before_access": [{"department_key": "finance", "module_key": None, "level": "write"}],
            "access": [{"department_key": "finance", "module_key": None, "level": "read"}],
        },
    )

    with pytest.raises(SamplePhaseActionError, match="planned access"):
        execute_phase_action(action, None, context)  # type: ignore[arg-type]

    assert [request.method for request in seen] == ["GET"]


def test_group_access_replacement_uses_planned_baseline_and_current_revision(tmp_path) -> None:
    seen: list[httpx.Request] = []
    department_id = "56af8be1-8862-47a8-9906-1717395ccf20"

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        seen.append(request)
        access = [
            {
                "department_id": department_id,
                "module_id": None,
                "level": "write" if request.method == "GET" else "read",
            }
        ]
        revision = 7 if request.method == "GET" else 8
        return httpx.Response(
            200,
            headers={"ETag": f'"{GROUP_ID}:{revision}"', "X-Request-ID": str(uuid4())},
            json={"id": GROUP_ID, "revision": revision, "member_ids": [], "access": access},
        )

    context = _context(tmp_path, {"admin": handler})
    action = _action(
        "replace_group_access",
        target="finance-office",
        values={
            "before_access": [{"department_key": "finance", "module_key": None, "level": "write"}],
            "access": [{"department_key": "finance", "module_key": None, "level": "read"}],
        },
    )

    result = execute_phase_action(action, None, context)  # type: ignore[arg-type]

    assert seen[1].headers["If-Match"] == f'"{GROUP_ID}:7"'
    assert json.loads(seen[1].content) == {
        "access": [{"department_id": department_id, "module_id": None, "level": "read"}]
    }
    assert result["request_evidence"][0]["primary_entity_type"] == "groups"
    assert result["request_evidence"][0]["primary_action"] == "update"
    assert result["request_evidence"][0]["related_entity_types"] == ["group_access"]


@pytest.mark.parametrize("fault", ("none", "empty_name", "malformed_name", "target", "operation"))
def test_board_purge_preview_and_purge_keep_challenge_and_password_out_of_evidence(
    tmp_path,
    fault: str,
) -> None:
    request_ids = iter(str(uuid4()) for _ in range(3))
    seen: list[httpx.Request] = []
    confirmation_name = "Phase purge Board / Résumé"

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        seen.append(request)
        request_id = next(request_ids)
        if request.method == "GET":
            body = {"id": BOARD_ID, "revision": 3, "scope": "project", "status": "archived"}
            return httpx.Response(200, headers={"X-Request-ID": request_id}, json=body)
        if request.url.path.endswith("/purge/preview"):
            return httpx.Response(
                200,
                headers={"X-Request-ID": request_id},
                json={
                    "token": "do-not-report-preview-token",
                    "confirmation_name": ""
                    if fault == "empty_name"
                    else 42
                    if fault == "malformed_name"
                    else confirmation_name,
                    "impact": {
                        "target_id": TARGET_ID if fault == "target" else BOARD_ID,
                        "operation": "close" if fault == "operation" else "purge",
                        "impact_digest": "digest",
                    },
                },
            )
        return httpx.Response(
            200,
            headers={"X-Request-ID": request_id},
            json={
                "operation_id": str(uuid4()),
                "impact": {"target_id": BOARD_ID, "operation": "purge"},
            },
        )

    context = _context(
        tmp_path,
        {"admin": handler},
        mappings={"phase_boards": {"phase-purge-board": BOARD_ID}},
    )
    preview = _action("board_purge_preview", target="phase-purge-board")
    purge = _action("board_purge", target="phase-purge-board")

    if fault != "none":
        with pytest.raises(SamplePhaseActionError, match="preview did not match its target"):
            execute_phase_action(preview, None, context)  # type: ignore[arg-type]
        assert "board_purge_previews" not in context.private_values
        assert not any(request.url.path.endswith("/purge") for request in seen)
        return

    preview_result = execute_phase_action(preview, None, context)  # type: ignore[arg-type]
    purge_result = execute_phase_action(purge, None, context)  # type: ignore[arg-type]

    assert seen[-1].url.path == f"/api/boards/{BOARD_ID}/purge"
    assert json.loads(seen[-1].content) == {
        "token": "do-not-report-preview-token",
        "confirmation_name": confirmation_name,
        "password": "fixture-admin-password",
    }
    evidence = preview_result["request_evidence"] + purge_result["request_evidence"]
    serialized = json.dumps({"preview": preview_result, "purge": purge_result})
    assert preview_result["request_evidence"][0]["primary_entity_type"] is None
    assert preview_result["request_evidence"][0]["primary_action"] is None
    assert preview_result["request_evidence"][0]["expected_audit_rows"] == 0
    assert purge_result["request_evidence"][0]["primary_action"] == "delete"
    assert purge_result["request_evidence"][0]["expected_audit_rows"] == 1
    assert all("token" not in item for item in evidence)
    assert "do-not-report-preview-token" not in serialized
    assert "fixture-admin-password" not in serialized


def test_board_creation_rejects_non_string_server_id_as_safe_phase_error(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        return httpx.Response(
            201,
            headers={"X-Request-ID": str(uuid4())},
            json={"id": 42, "scope": "project", "name": "Planned Board"},
        )

    context = _context(tmp_path, {"admin": handler})
    action = _action(
        "board_create_purge_target",
        target="phase-purge-board",
        values={"display_name": "Planned Board", "description": "Fixture"},
        status=201,
    )

    with pytest.raises(SamplePhaseActionError, match="Board mapping is missing or invalid"):
        execute_phase_action(action, None, context)  # type: ignore[arg-type]


def test_unknown_write_outcome_is_not_replayed(tmp_path) -> None:
    write_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal write_count
        login = _login_response(request)
        if login is not None:
            return login
        if request.method == "GET":
            return httpx.Response(
                200, json={"id": BOARD_ID, "revision": 3, "scope": "project", "status": "active"}
            )
        write_count += 1
        raise httpx.ConnectError("private connection detail", request=request)

    context = _context(
        tmp_path, {"admin": handler}, mappings={"boards": {"existing-board": BOARD_ID}}
    )
    action = _action("board_archive", target="existing-board", values={"scope": "project"})

    with pytest.raises(SampleWriteOutcomeUnknown):
        execute_phase_action(action, None, context)  # type: ignore[arg-type]

    assert write_count == 1
