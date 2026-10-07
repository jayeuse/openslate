from __future__ import annotations

import json
import re
from dataclasses import asdict, replace
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest

import operations.sample.controls.access as access_controls
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.controls.access import (
    CONTROL_ROUTES,
    execute_access_control,
    plan_access_controls,
    verify_access_controls,
)
from operations.sample.packs import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.phases.plan import plan_phases
from operations.sample.scenario import build_dataset

ADMIN_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
GUEST_ID = "e40862a7-fbb7-4e71-a590-90e11f4e893d"
PENDING_ID = "9ec0d287-ae14-4603-91c2-f9a4d7b73c0a"
GROUP_ID = "4f10e3a8-6798-4ae8-bf5a-66ef6c54c02e"


def _dataset(pack_key: str = "harbor") -> SampleDataset:
    from datetime import date

    return build_dataset(
        "small", seed=42, anchor_date=date(2026, 9, 30), organization=get_pack(pack_key)
    )


def _pending_key(dataset: SampleDataset) -> str:
    return min(
        person.key
        for person in dataset.organization.actors.people
        if person.status == "pending" and person.role == "member"
    )


def _guest_key(dataset: SampleDataset) -> str:
    return min(
        person.key
        for person in dataset.organization.actors.people
        if person.status == "active" and person.role == "guest"
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


def _context(tmp_path: Path, dataset: SampleDataset, handler) -> PhaseExecutionContext:
    return PhaseExecutionContext(
        clients={"admin": _client(tmp_path, handler)},
        user_ids={
            "admin": ADMIN_ID,
            _guest_key(dataset): GUEST_ID,
            _pending_key(dataset): PENDING_ID,
        },
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings={},
        admin_password="fixture-admin-password",
    )


def _user(*, status: str, deleted: bool = False, role: str = "guest") -> dict[str, object]:
    return {
        "id": GUEST_ID if role == "guest" else PENDING_ID,
        "email": "person@example.test",
        "username": "person_sample",
        "display_name": "Sample Person",
        "job_title": "External reviewer",
        "role": role,
        "status": status,
        "is_deleted": deleted,
        "invitation_sent_at": None if role == "member" else None,
    }


def _route(request: httpx.Request) -> tuple[str, str]:
    path = request.url.path
    if re.fullmatch(r"/api/access/groups/[0-9a-f-]{36}", path):
        path = "/api/access/groups/{group_id}"
    if re.fullmatch(r"/api/users/[0-9a-f-]{36}(?:/access)?", path):
        path = path.replace(path.split("/")[3], "{user_id}", 1)
        path = path.replace("/access", "/access")
    if re.fullmatch(r"/api/users/[0-9a-f-]{36}/restore", path):
        path = "/api/users/{user_id}/restore"
    if re.fullmatch(r"/api/auth/invitations/[0-9a-f-]{36}(?:/resend)?", path):
        path = "/api/auth/invitations/{user_id}" + ("/resend" if path.endswith("/resend") else "")
    return request.method, path


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_access_control_plan_is_repeatable_and_restores_people(pack_key: str) -> None:
    dataset = _dataset(pack_key)

    actions = plan_access_controls(dataset)

    assert actions == plan_access_controls(dataset)
    assert [action.values["operation"] for action in actions] == [
        "create_temporary_group",
        "rename_temporary_group",
        "delete_temporary_group",
        "delete_user",
        "restore_user",
        "resend_invitation",
        "revoke_invitation",
    ]
    people = {person.key: person for person in dataset.organization.actors.people}
    deleted_user = people[actions[3].target_key]
    assert deleted_user.role == "guest" and deleted_user.status == "active"
    assert actions[3].target_key == actions[4].target_key
    assert actions[5].target_key == actions[6].target_key
    assert people[actions[5].target_key].status == "pending"
    assert all(action.actor_key == "admin" for action in actions)
    assert all(action.expected_end_state for action in actions)


@pytest.mark.parametrize("phase_person_field", ("actor_key", "target_key"))
def test_guest_cleanup_leaves_people_needed_by_later_phases_available(
    monkeypatch: pytest.MonkeyPatch, phase_person_field: str
) -> None:
    dataset = _dataset()
    guests = sorted(
        person.key
        for person in dataset.organization.actors.people
        if person.status == "active" and person.role == "guest"
    )
    future_action = replace(plan_phases(dataset)[0], **{phase_person_field: guests[0]})
    monkeypatch.setattr(access_controls, "plan_phases", lambda _: (future_action,), raising=False)

    actions = plan_access_controls(dataset)

    assert actions[3].target_key == guests[1]
    assert actions[4].target_key == guests[1]


def test_guest_cleanup_refuses_when_every_guest_is_needed_by_later_phases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset = _dataset()
    guests = [
        person.key
        for person in dataset.organization.actors.people
        if person.status == "active" and person.role == "guest"
    ]
    future_actions = tuple(replace(plan_phases(dataset)[0], target_key=key) for key in guests)
    monkeypatch.setattr(access_controls, "plan_phases", lambda _: future_actions, raising=False)

    with pytest.raises(ValueError, match="active guest"):
        plan_access_controls(dataset)


def test_access_controls_call_ui_routes_and_restore_the_planned_state(tmp_path: Path) -> None:
    dataset = _dataset()
    actions = plan_access_controls(dataset)
    requests: list[httpx.Request] = []
    group: dict[str, Any] | None = None
    group_revision = 0
    group_deleted = False
    guest_deleted = False
    invitation_revoked = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal group, group_revision, group_deleted, guest_deleted, invitation_revoked
        login = _login_response(request)
        if login is not None:
            return login
        requests.append(request)
        method, path = request.method, request.url.path
        request_id = {"X-Request-ID": str(uuid4())}
        if method == "POST" and path == "/api/access/groups":
            body = json.loads(request.content)
            assert body == {
                "name": actions[0].values["name"],
                "description": actions[0].values["description"],
            }
            group = {"id": GROUP_ID, "name": body["name"], "description": body["description"]}
            group_revision = 1
            return httpx.Response(
                201,
                headers={**request_id, "ETag": f'"{GROUP_ID}:1"'},
                json={**group, "revision": group_revision, "member_ids": [], "access": []},
            )
        if path == f"/api/access/groups/{GROUP_ID}" and method == "GET":
            assert group is not None
            body = {
                **group,
                "revision": group_revision,
                "member_ids": [],
                "access": [],
                "is_deleted": group_deleted,
                "deleted_at": "2026-10-02T11:44:20Z" if group_deleted else None,
            }
            return httpx.Response(
                200,
                headers={"ETag": f'"{GROUP_ID}:{group_revision}"'},
                json=body,
            )
        if path == f"/api/access/groups/{GROUP_ID}" and method == "PATCH":
            assert request.headers["If-Match"] == f'"{GROUP_ID}:{group_revision}"'
            body = json.loads(request.content)
            assert set(body) == {"name"} and body["name"] == actions[1].values["name"]
            assert group is not None
            group["name"] = body["name"]
            group_revision += 1
            return httpx.Response(
                200,
                headers={**request_id, "ETag": f'"{GROUP_ID}:{group_revision}"'},
                json={**group, "revision": group_revision, "member_ids": [], "access": []},
            )
        if path == f"/api/access/groups/{GROUP_ID}" and method == "DELETE":
            assert request.headers["If-Match"] == f'"{GROUP_ID}:{group_revision}"'
            group_deleted = True
            group_revision += 1
            return httpx.Response(204, headers=request_id)
        if path == f"/api/users/{GUEST_ID}" and method == "DELETE":
            guest_deleted = True
            return httpx.Response(204, headers=request_id)
        if path == f"/api/users/{GUEST_ID}/restore" and method == "POST":
            assert guest_deleted
            guest_deleted = False
            return httpx.Response(200, headers=request_id, json=_user(status="active"))
        if path == f"/api/auth/invitations/{PENDING_ID}/resend" and method == "POST":
            assert json.loads(request.content) == {}
            return httpx.Response(
                200,
                headers=request_id,
                json={"user": _user(status="pending", role="member"), "delivery": "email"},
            )
        if path == f"/api/auth/invitations/{PENDING_ID}" and method == "DELETE":
            invitation_revoked = True
            return httpx.Response(204, headers=request_id)
        if path == f"/api/users/{GUEST_ID}" and method == "GET":
            return httpx.Response(200, json=_user(status="active", deleted=guest_deleted))
        if path == f"/api/users/{GUEST_ID}/access" and method == "GET":
            return httpx.Response(
                200,
                json={"user_id": GUEST_ID, "role": "guest", "unrestricted": False, "entries": []},
            )
        if path == f"/api/users/{PENDING_ID}" and method == "GET":
            return httpx.Response(
                200,
                json={
                    "id": PENDING_ID,
                    "status": "pending",
                    "is_deleted": False,
                    "invitation_sent_at": None if invitation_revoked else "sent",
                },
            )
        pytest.fail(f"Unexpected request: {method} {path}")

    context = _context(tmp_path, dataset, handler)
    results = [execute_access_control(action, dataset, context) for action in actions]
    manifest = {
        "control_plan": [asdict(action) for action in actions],
        "control_results": results,
        "mappings": {"user": {_guest_key(dataset): GUEST_ID, _pending_key(dataset): PENDING_ID}},
    }
    # The real plan also holds the People security control under this kind; it has
    # its own verifier and must not fail the access operation check.
    from operations.sample.controls.people_security import plan_people_security_controls

    manifest["control_plan"].append(asdict(plan_people_security_controls(dataset)[0]))

    counts, issues = verify_access_controls(
        context.clients["admin"], dataset, manifest, admin_id=ADMIN_ID
    )

    assert not issues
    assert counts["access_groups_deleted"] == 1
    assert counts["access_users_restored"] == 1
    assert counts["access_invitations_revoked"] == 1
    assert group_deleted and not guest_deleted and invitation_revoked
    observed = {_route(request) for request in requests}
    assert CONTROL_ROUTES <= observed


def test_group_rename_fails_closed_without_a_current_etag(tmp_path: Path) -> None:
    dataset = _dataset()
    create, rename = plan_access_controls(dataset)[:2]
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(
                201,
                headers={"X-Request-ID": str(uuid4()), "ETag": f'"{GROUP_ID}:1"'},
                json={
                    "id": GROUP_ID,
                    "name": create.values["name"],
                    "revision": 1,
                    "description": create.values["description"],
                },
            )
        if request.method == "GET":
            return httpx.Response(200, json={"id": GROUP_ID, "revision": 1})
        pytest.fail("A PATCH without the current ETag must not be sent")

    context = _context(tmp_path, dataset, handler)
    execute_access_control(create, dataset, context)

    with pytest.raises(SamplePhaseActionError):
        execute_access_control(rename, dataset, context)
    assert [request.method for request in requests] == ["POST", "GET"]


def test_access_verifier_reports_malformed_recorded_plan(tmp_path: Path) -> None:
    dataset = _dataset()

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        pytest.fail(f"Unexpected request while rejecting malformed plan: {request.url.path}")

    counts, issues = verify_access_controls(
        _client(tmp_path, handler),
        dataset,
        {"control_plan": [{}], "control_results": []},
        admin_id=ADMIN_ID,
    )

    assert counts == {
        "access_groups_deleted": 0,
        "access_users_restored": 0,
        "access_invitations_revoked": 0,
    }
    assert "Access control plan is invalid" in issues
