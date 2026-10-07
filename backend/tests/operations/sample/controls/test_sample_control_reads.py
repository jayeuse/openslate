from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

import operations.sample.controls.reads as control_reads
from operations.sample.client import SampleClient
from operations.sample.controls.account import plan_account_controls
from operations.sample.controls.reads import CONTROL_ROUTES, plan_read_controls
from operations.sample.episodes import plan_sessions
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.phases.plan import plan_phases
from operations.sample.scenario import build_dataset

ADMIN_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
TARGET_ID = "e40862a7-fbb7-4e71-a590-90e11f4e893d"
SESSION_ID = "9ec0d287-ae14-4603-91c2-f9a4d7b73c0a"


def _dataset(pack_key: str):
    return build_dataset(
        "small", seed=42, anchor_date=date(2026, 10, 1), organization=get_pack(pack_key)
    )


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_read_control_plan_contains_only_the_final_pack_safe_bulk_revocation(pack_key: str) -> None:
    dataset = _dataset(pack_key)
    actions = plan_read_controls(dataset)
    people = {person.key: person for person in dataset.organization.actors.people}
    work_actors = {session.creator_key for session in plan_sessions(dataset)}
    phase_actors = {
        key
        for action in plan_phases(dataset)
        for key in (action.actor_key, action.target_key)
        if key in people
    }
    excluded = phase_actors | {plan_account_controls(dataset)[0].actor_key}
    expected_candidates = sorted(
        key
        for key in work_actors
        if key in people
        and people[key].role == "member"
        and people[key].status == "active"
        and key not in excluded
    )

    assert actions == plan_read_controls(dataset)
    assert len(actions) == 1
    action = actions[0]
    assert action.key == "control:revoke-user-sessions"
    assert action.kind == "read_controls"
    assert action.phase == "reorganization"
    assert action.values == {"operation": "revoke_user_sessions"}
    assert action.actor_key == "admin"
    assert action.target_key == expected_candidates[0]
    assert action.expected_status == 204
    assert action.expected_end_state == {"sessions_revoked": True}
    assert CONTROL_ROUTES == frozenset(
        {
            ("GET", "/api/users/{user_id}/sessions"),
            ("DELETE", "/api/users/{user_id}/sessions"),
        }
    )


def test_read_control_plan_is_empty_without_pack_lifecycle_anchors() -> None:
    from dataclasses import replace

    dataset = _dataset("harbor")
    without_phases = replace(dataset, organization=replace(dataset.organization, phases=None))

    assert plan_read_controls(without_phases) == ()


def _client(tmp_path: Path, handler) -> SampleClient:
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "control-reads.jsonl",
        transport=httpx.MockTransport(handler),
    )
    assert client.login("admin@example.test", "fixture-only").status_code == 200
    return client


def _context(tmp_path: Path, dataset, handler, *, duplicate_target: bool = False):
    target_key = plan_read_controls(dataset)[0].target_key
    users = {"admin": ADMIN_ID, target_key: TARGET_ID}
    if duplicate_target:
        users["another-person"] = TARGET_ID
    return PhaseExecutionContext(
        clients={"admin": _client(tmp_path, handler)},
        user_ids=users,
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings={},
        admin_password="fixture-only",
    )


def _page(session: bool) -> dict[str, object]:
    items = [{"id": SESSION_ID}] if session else []
    return {
        "items": items,
        "pagination": {
            "limit": 100,
            "offset": 0,
            "count": len(items),
            "total": len(items),
            "has_more": False,
        },
    }


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


def test_bulk_session_control_lists_before_and_after_and_sends_exact_delete(
    tmp_path: Path,
) -> None:
    dataset = _dataset("harbor")
    target_key = plan_read_controls(dataset)[0].target_key
    seen: list[httpx.Request] = []
    revoked = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal revoked
        login = _login_response(request)
        if login is not None:
            return login
        seen.append(request)
        if request.method == "GET" and request.url.path == f"/api/users/{TARGET_ID}/sessions":
            assert dict(request.url.params) == {"limit": "100", "offset": "0"}
            return httpx.Response(200, json=_page(not revoked))
        if request.method == "DELETE" and request.url.path == f"/api/users/{TARGET_ID}/sessions":
            assert request.content == b""
            assert request.url.query == b""
            revoked = True
            return httpx.Response(204, headers={"X-Request-ID": str(uuid4())})
        return httpx.Response(404)

    context = _context(tmp_path, dataset, handler)
    execute = getattr(control_reads, "execute_read_control", None)
    assert callable(execute), "The bulk session control executor must be implemented"
    result = execute(plan_read_controls(dataset)[0], dataset, context)

    assert [(request.method, request.url.path) for request in seen] == [
        ("GET", f"/api/users/{TARGET_ID}/sessions"),
        ("DELETE", f"/api/users/{TARGET_ID}/sessions"),
        ("GET", f"/api/users/{TARGET_ID}/sessions"),
    ]
    assert result["action_key"] == "control:revoke-user-sessions"
    assert result["actor_key"] == "admin"
    assert result["target_key"] == target_key
    assert result["outcome"] == "completed"
    assert result["read_checks"] == 2
    assert result["sessions_revoked"] is True
    evidence = result["request_evidence"]
    assert isinstance(evidence, list) and len(evidence) == 1
    assert evidence[0]["step"] == "revoke_user_sessions"
    assert evidence[0]["actor_key"] == "admin"
    assert evidence[0]["actor_id"] == ADMIN_ID
    assert evidence[0]["method"] == "DELETE"
    assert evidence[0]["path"] == f"/api/users/{TARGET_ID}/sessions"
    assert evidence[0]["expected_status"] == 204
    assert evidence[0]["status_code"] == 204
    assert evidence[0]["expected_audit_rows"] == 0
    assert isinstance(evidence[0]["request_id"], str)


def test_bulk_session_control_refuses_missing_live_sessions_before_delete(
    tmp_path: Path,
) -> None:
    dataset = _dataset("harbor")
    seen_methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        seen_methods.append(request.method)
        return httpx.Response(200, json=_page(False))

    context = _context(tmp_path, dataset, handler)
    execute = getattr(control_reads, "execute_read_control", None)
    assert callable(execute), "The bulk session control executor must be implemented"

    with pytest.raises(SamplePhaseActionError, match="no active sessions") as error:
        execute(plan_read_controls(dataset)[0], dataset, context)

    assert error.value.step == "list_user_sessions_before"
    assert seen_methods == ["GET"]


def test_bulk_session_control_refuses_ambiguous_target_mapping_before_read(
    tmp_path: Path,
) -> None:
    dataset = _dataset("harbor")
    seen_methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        seen_methods.append(request.method)
        return httpx.Response(404)

    context = _context(tmp_path, dataset, handler, duplicate_target=True)
    execute = getattr(control_reads, "execute_read_control", None)
    assert callable(execute), "The bulk session control executor must be implemented"

    with pytest.raises(SamplePhaseActionError, match="target mapping is ambiguous") as error:
        execute(plan_read_controls(dataset)[0], dataset, context)

    assert error.value.step == "session_target"
    assert seen_methods == []


def test_bulk_session_control_refuses_missing_target_mapping_before_read(tmp_path: Path) -> None:
    dataset = _dataset("harbor")
    action = plan_read_controls(dataset)[0]

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        return login if login is not None else httpx.Response(404)

    context = _context(tmp_path, dataset, handler)
    context.user_ids = {"admin": ADMIN_ID}
    execute = getattr(control_reads, "execute_read_control", None)
    assert callable(execute), "The bulk session control executor must be implemented"

    with pytest.raises(SamplePhaseActionError, match="mapping is missing") as error:
        execute(action, dataset, context)

    assert error.value.step == "session_target"


def test_bulk_session_control_fails_when_post_readback_is_not_empty(tmp_path: Path) -> None:
    dataset = _dataset("harbor")
    seen_methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        seen_methods.append(request.method)
        if request.method == "DELETE":
            return httpx.Response(204, headers={"X-Request-ID": str(uuid4())})
        return httpx.Response(200, json=_page(True))

    context = _context(tmp_path, dataset, handler)
    execute = getattr(control_reads, "execute_read_control", None)
    assert callable(execute), "The bulk session control executor must be implemented"

    with pytest.raises(SamplePhaseActionError, match="remain after revocation") as error:
        execute(plan_read_controls(dataset)[0], dataset, context)

    assert error.value.step == "list_user_sessions_after"
    assert seen_methods == ["GET", "DELETE", "GET"]


@pytest.mark.parametrize(
    "problem",
    (
        "missing_credential",
        "credential_identity",
        "bulk_unknown",
        "reauth_denied",
        "mfa_identity",
        "policy_not_saved",
        "pagination",
        "remaining_page",
        "session_retention_ignored",
        "event_retention_ignored",
        "retention_restore_lost",
    ),
)
def test_manage_controls_stop_at_invalid_dependency_or_end_state(tmp_path, problem):
    from operations.sample.client import SampleWriteOutcomeUnknown
    from operations.sample.controls.actions import execute_control_action
    from tests.operations.sample.controls.sample_manage_wire import _manage_run

    dataset, actions, context, state = _manage_run(tmp_path, "harbor", problem)
    if problem == "credential_identity":
        from operations.sample.population.people import SampleActorCredential

        credentials = context.private_values["credentials"]
        key, other = list(credentials)[:2]
        original = credentials[key]
        credentials[key] = SampleActorCredential(
            original.user_id, credentials[other].email, original.password
        )
    operation = (
        "review_mfa_status"
        if problem == "mfa_identity"
        else "update_workspace_security"
        if problem
        in {
            "policy_not_saved",
            "session_retention_ignored",
            "event_retention_ignored",
            "retention_restore_lost",
        }
        else "review_admin_sessions"
        if problem == "pagination"
        else "revoke_admin_sessions"
    )
    action = next(a for a in actions if a.values["operation"] == operation)
    messages = {
        "missing_credential": "Primary actor credential binding is invalid",
        "credential_identity": "Primary actor credential binding is invalid",
        "bulk_unknown": "DELETE outcome is unknown",
        "reauth_denied": "Manage write did not match its planned result",
        "mfa_identity": "Sample MFA status differs from the unenrolled actor",
        "policy_not_saved": "Workspace security update was not persisted",
        "pagination": "Administrator session pagination is incomplete or ambiguous",
        "remaining_page": "Administrator session pagination is incomplete or ambiguous",
        "session_retention_ignored": "Workspace security update was not persisted",
        "event_retention_ignored": "Workspace security update was not persisted",
        "retention_restore_lost": "Workspace security policy was not restored",
    }
    expected_error = (
        SampleWriteOutcomeUnknown if problem == "bulk_unknown" else SamplePhaseActionError
    )
    try:
        with pytest.raises(expected_error, match=messages[problem]) as error:
            execute_control_action(action, dataset, context)
        if isinstance(error.value, SamplePhaseActionError):
            if problem == "reauth_denied":
                assert error.value.step.startswith("reauth:")
                assert error.value.status_code == 401
            else:
                assert error.value.step == action.key
        else:
            assert error.value.status_code == 503
            assert error.value.attempt_id is not None
            assert error.value.request_id is not None
        deletes = [row for row in state["seen"] if row == ("DELETE", "/api/auth/admin-sessions")]
        assert len(deletes) == (problem in {"bulk_unknown", "reauth_denied", "remaining_page"})
        if problem == "remaining_page":
            assert len(state["logins"]) == len(context.clients)
        if "retention" in problem:
            assert len(state["patches"]) == (2 if problem == "retention_restore_lost" else 1)
        if problem == "bulk_unknown":
            journal = [
                json.loads(line) for line in (tmp_path / "manage.jsonl").read_text().splitlines()
            ]
            assert [
                row["status_code"]
                for row in journal
                if row["event"] == "request_finished" and row["status_code"] >= 500
            ] == [503]
    finally:
        for client in context.clients.values():
            client.close()
