"""Invitation, user administration, and authentication route contracts."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.reconciliation as reconciliation
import app.systems.access.users.service as users_service
from app.common.dependencies.auth import (
    VerifiedPendingIdentity,
    get_verified_pending_identity,
)
from app.core.integrations.supabase import SupabaseAdminClient
from app.systems.access.users.models import UserRole
from app.systems.access.users.permissions import ALL_CAPABILITIES

from .support import _client, make_role, make_user


def test_pending_invitation_acceptance_uses_verified_identity_not_request_body(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pending_role = make_role("operator")
    pending = make_user("pending", role=pending_role, status="pending")
    pending.invitation_sent_at = datetime.now(UTC)
    identity = VerifiedPendingIdentity(subject=pending.id, email=pending.email)
    database = Mock(spec=Session)
    admin_role = make_role(UserRole.ADMIN)
    database.scalar.side_effect = [admin_role, pending, pending_role]
    monkeypatch.setattr(users_service, "append_committed_security_event", lambda _payload: None)
    api.dependency_overrides[get_verified_pending_identity] = lambda: identity

    response = _client(api, pending, database).post(
        "/api/auth/invitations/accept",
        json={"user_id": str(uuid7()), "email": "attacker@example.com", "verified": False},
    )

    assert response.status_code == 200
    assert response.json()["id"] == str(pending.id)
    assert pending.status == "active"


def test_admin_user_patch_cannot_activate_or_set_a_pending_status(api: FastAPI) -> None:
    admin = make_user("admin", role=make_role(UserRole.ADMIN))
    target = make_user("pending", role=make_role(), status="disabled")
    database = Mock(spec=Session)
    database.scalar.return_value = target

    response = _client(api, admin, database).patch(
        f"/api/users/{target.id}",
        json={"status": "pending"},
    )

    assert response.status_code == 422
    assert target.status == "disabled"
    database.commit.assert_not_called()


@pytest.mark.parametrize(
    ("status", "deleted", "method_name"),
    [
        ("active", False, "enable_user"),
        ("pending", False, "disable_user"),
        ("disabled", False, "disable_user"),
        ("active", True, "disable_user"),
    ],
)
def test_exact_admin_can_reconcile_auth_from_local_state(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    status: str,
    deleted: bool,
    method_name: str,
) -> None:
    target = make_user("reconcile-target", role=make_role(), status=status, deleted=deleted)
    admin = make_user("admin", role=make_role(UserRole.ADMIN))
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin.role,
        admin,
        target,
        admin.role,
        admin,
        target,
    ]
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(reconciliation, "SupabaseAdminClient", lambda: client)
    monkeypatch.setattr(reconciliation, "_record_outcome", lambda *_args, **_kwargs: None)

    response = _client(api, admin, database).post(
        f"/api/users/{target.id}/reconcile-auth",
    )

    assert response.status_code == 200
    getattr(client, method_name).assert_called_once_with(target.id)
    opposite = "disable_user" if method_name == "enable_user" else "enable_user"
    getattr(client, opposite).assert_not_called()


def test_reconcile_auth_remains_exact_admin_only_even_with_all_capabilities(api: FastAPI) -> None:
    custom = make_user(
        "custom",
        role=make_role("operator", {capability: True for capability in ALL_CAPABILITIES}),
    )
    database = Mock(spec=Session)

    response = _client(api, custom, database).post(
        f"/api/users/{uuid7()}/reconcile-auth",
    )

    assert response.status_code == 403


def test_reconcile_auth_emits_correlated_safe_attempt_and_outcome_events(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = make_user("reconcile-target", role=make_role(), status="disabled")
    admin = make_user("admin", role=make_role(UserRole.ADMIN))
    database = Mock(spec=Session)
    database.scalar.side_effect = [admin.role, admin, target, admin.role, admin, target]
    client = Mock(spec=SupabaseAdminClient)
    event_writer = Mock()
    monkeypatch.setattr(reconciliation, "SupabaseAdminClient", lambda: client)
    monkeypatch.setattr(
        reconciliation,
        "_record_outcome",
        lambda event_type, outcome, operation_id, actor_id, target_id, reason=None: event_writer(
            event_type=event_type,
            outcome=outcome,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=target_id,
            reason=reason,
        ),
    )

    response = _client(api, admin, database).post(
        f"/api/users/{target.id}/reconcile-auth",
    )

    assert response.status_code == 200
    events = [call.kwargs for call in event_writer.call_args_list]
    assert len(events) >= 2
    assert len({event["operation_id"] for event in events}) == 1
    assert {getattr(event["outcome"], "value", event["outcome"]) for event in events} >= {
        "attempt",
        "success",
    }


def test_reconcile_auth_records_partial_drift_without_an_opposite_provider_call(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = make_user("reconcile-target", role=make_role(), status="disabled")
    changed = make_user("reconcile-target", role=target.role, status="active")
    changed.id = target.id
    admin = make_user("admin", role=make_role(UserRole.ADMIN))
    database = Mock(spec=Session)
    database.scalar.side_effect = [admin.role, admin, target, admin.role, admin, changed]
    client = Mock(spec=SupabaseAdminClient)
    events = Mock()
    monkeypatch.setattr(reconciliation, "SupabaseAdminClient", lambda: client)
    monkeypatch.setattr(
        reconciliation,
        "_record_outcome",
        lambda event_type, outcome, operation_id, actor_id, target_id, reason=None: events(
            event_type=event_type,
            outcome=outcome,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=target_id,
            reason=reason,
        ),
    )

    response = _client(api, admin, database).post(
        f"/api/users/{target.id}/reconcile-auth",
    )

    assert response.status_code == 409
    client.disable_user.assert_called_once_with(target.id)
    client.enable_user.assert_not_called()
    assert changed.status == "disabled"
    assert changed.tokens_valid_after is not None
    outcomes = {
        getattr(call.kwargs["outcome"], "value", call.kwargs["outcome"])
        for call in events.call_args_list
    }
    assert {"attempt", "partial"} <= outcomes


@pytest.mark.parametrize(
    "permissions",
    [
        {"records.read": True},
        {"records.write": True, "departments.read": True},
    ],
)
def test_auth_me_adds_role_and_sorted_effective_permissions(
    api: FastAPI,
    permissions: dict[str, bool],
) -> None:
    role_name = UserRole.MEMBER
    user = make_user("member", role=make_role(role_name, permissions))

    response = _client(api, user).get("/api/auth/me")

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == str(user.id)
    assert body["email"] == user.email
    assert body["role"] == role_name
    assert body["permissions"] == sorted(
        capability for capability, granted in permissions.items() if granted
    )
    assert "status" in body


def test_auth_me_returns_all_capabilities_for_admin(api: FastAPI) -> None:
    admin = make_user("admin", role=make_role(UserRole.ADMIN, {"bad": []}))

    response = _client(api, admin).get("/api/auth/me")

    assert response.status_code == 200
    assert response.json()["role"] == "admin"
    assert response.json()["permissions"] == list(ALL_CAPABILITIES)


@pytest.mark.parametrize(
    "permissions",
    [
        {"unknown.read": True},
        {"records": {"read": True}},
        {"records.read": "true"},
    ],
    ids=["unknown", "nested", "non-boolean"],
)
@pytest.mark.parametrize("method", ["POST", "PATCH"])
def test_role_http_create_and_update_reject_invalid_permission_documents(
    api: FastAPI,
    permissions: dict[str, Any],
    method: str,
) -> None:
    admin = make_user("admin", role=make_role(UserRole.ADMIN))
    client = _client(api, admin)
    if method == "POST":
        path = "/api/roles"
        payload = {"role": "editor", "permissions": permissions}
    else:
        path = f"/api/roles/{uuid7()}"
        payload = {"permissions": permissions}

    response = client.request(method, path, json=payload)

    assert response.status_code == 422
