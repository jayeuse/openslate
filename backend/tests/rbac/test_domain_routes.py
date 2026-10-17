"""Administrator boundaries for lifecycle, account and audit routes.

Record and relationship routes follow department and module access; their
database tests live in ``tests/access/test_read_paths_integration.py``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from secrets import token_urlsafe
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.auth.router as auth_router
import app.systems.access.users.router as users_router
import app.systems.manage.audit.router as audit_router
import app.systems.sandbox.lifecycle.router as lifecycle_router
from app.systems.access.users.models import UserRole
from app.systems.access.users.schemas import UserListResponse
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleImpactResponse,
    LifecycleMutationResponse,
    LifecycleOperation,
    LifecyclePurgePreviewResponse,
    LifecycleTargetType,
)

from .support import _client, _empty_list_result, make_user

# Fixed, so parametrized test IDs are the same in every process.
_PATH_ID = "0190a000-0000-7000-8000-000000000001"

CONFIRMATION_TOKEN = token_urlsafe(32)
CONFIRMATION_PASSWORD = token_urlsafe(32)


@pytest.mark.parametrize(
    ("target_type", "operation", "path"),
    [
        (
            LifecycleTargetType.DEPARTMENT,
            LifecycleOperation.CLOSE,
            f"/api/departments/{_PATH_ID}/close",
        ),
        (
            LifecycleTargetType.DEPARTMENT,
            LifecycleOperation.REOPEN,
            f"/api/departments/{_PATH_ID}/reopen",
        ),
        (
            LifecycleTargetType.MODULE,
            LifecycleOperation.CLOSE,
            f"/api/modules/{_PATH_ID}/close",
        ),
        (
            LifecycleTargetType.MODULE,
            LifecycleOperation.REOPEN,
            f"/api/modules/{_PATH_ID}/reopen",
        ),
        (
            LifecycleTargetType.FIELD,
            LifecycleOperation.CLOSE,
            f"/api/fields/{_PATH_ID}/close",
        ),
        (
            LifecycleTargetType.FIELD,
            LifecycleOperation.REOPEN,
            f"/api/fields/{_PATH_ID}/reopen",
        ),
    ],
)
def test_lifecycle_close_and_reopen_are_administrator_only(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    target_type: LifecycleTargetType,
    operation: LifecycleOperation,
    path: str,
) -> None:
    impact = LifecycleImpactResponse(
        target_type=target_type,
        target_id=uuid7(),
        operation=operation,
        actor_id=uuid7(),
        impact_digest="digest",
    )
    mutation = LifecycleMutationResponse(impact=impact, operation_id=uuid7())
    if operation is LifecycleOperation.CLOSE:
        monkeypatch.setattr(lifecycle_router, "_close", lambda *_args: mutation)
        payload: dict[str, object] = {
            "token": CONFIRMATION_TOKEN,
            "confirmation_name": "Operations",
            "password": CONFIRMATION_PASSWORD,
        }
    else:
        monkeypatch.setattr(lifecycle_router, "_reopen", lambda *_args: mutation)
        payload = {"confirmed": True}

    admin = make_user("lifecycle-admin", role=UserRole.ADMIN)
    assert _client(api, admin).post(path, json=payload).status_code == 200
    for role in (UserRole.MEMBER, UserRole.GUEST):
        blocked = make_user(f"lifecycle-{role}", role=role)
        assert _client(api, blocked).post(path, json=payload).status_code == 403


def _purge_impact(target_type: LifecycleTargetType) -> LifecycleImpactResponse:
    return LifecycleImpactResponse(
        target_type=target_type,
        target_id=uuid7(),
        operation=LifecycleOperation.PURGE,
        actor_id=uuid7(),
        impact_digest="digest",
    )


@pytest.mark.parametrize(
    ("target_type", "path"),
    [
        (
            LifecycleTargetType.DEPARTMENT,
            f"/api/departments/{_PATH_ID}/purge/preview",
        ),
        (LifecycleTargetType.DEPARTMENT, f"/api/departments/{_PATH_ID}/purge"),
        (LifecycleTargetType.MODULE, f"/api/modules/{_PATH_ID}/purge/preview"),
        (LifecycleTargetType.MODULE, f"/api/modules/{_PATH_ID}/purge"),
        (LifecycleTargetType.FIELD, f"/api/fields/{_PATH_ID}/purge/preview"),
        (LifecycleTargetType.FIELD, f"/api/fields/{_PATH_ID}/purge"),
        (LifecycleTargetType.RECORD, f"/api/records/{_PATH_ID}/purge/preview"),
        (LifecycleTargetType.RECORD, f"/api/records/{_PATH_ID}/purge"),
    ],
)
def test_all_purge_routes_remain_literal_admin_only(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    target_type: LifecycleTargetType,
    path: str,
) -> None:
    impact = _purge_impact(target_type)
    preview = LifecyclePurgePreviewResponse(
        impact=impact,
        token=CONFIRMATION_TOKEN,
        expires_at=datetime.now(UTC),
        confirmation_name="Operations",
        last_successful_backup_at=None,
    )
    mutation = LifecycleMutationResponse(impact=impact, operation_id=uuid7())
    monkeypatch.setattr(lifecycle_router, "_purge_preview", lambda *_args: preview)
    monkeypatch.setattr(lifecycle_router, "_purge", lambda *_args: mutation)
    payload = (
        None
        if path.endswith("/preview")
        else {
            "token": CONFIRMATION_TOKEN,
            "confirmation_name": "Operations",
            "password": CONFIRMATION_PASSWORD,
        }
    )

    admin = make_user("admin", role=UserRole.ADMIN)
    response = _client(api, admin).request("POST", path, json=payload)
    assert response.status_code == 200

    member = make_user("member", role=UserRole.MEMBER)
    response = _client(api, member).request("POST", path, json=payload)
    assert response.status_code == 403


@pytest.mark.parametrize(
    ("path", "method", "payload", "route_group"),
    [
        ("/api/users", "GET", None, "users"),
        (
            "/api/auth/invitations",
            "POST",
            {"email": "invited@example.com", "username": "invited"},
            "invitations",
        ),
        ("/api/audit-logs", "GET", None, "audit"),
    ],
)
def test_users_invitations_and_audit_are_administrator_only(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    method: str,
    payload: dict[str, object] | None,
    route_group: str,
) -> None:
    database = Mock(spec=Session)
    if route_group == "users":
        monkeypatch.setattr(
            users_router,
            "directory_list",
            lambda *_args, **_kwargs: UserListResponse(
                items=[], pagination=_empty_list_result().pagination
            ),
        )
    elif route_group == "invitations":
        invited, invited_membership = make_user("invited")
        database.scalars.return_value.one.return_value = invited_membership
        monkeypatch.setattr(
            auth_router,
            "invite_user",
            lambda *_args, **_kwargs: invited,
        )
    else:
        monkeypatch.setattr(
            audit_router,
            "list_audit_logs",
            lambda *_args, **_kwargs: _empty_list_result(),
        )

    admin = make_user("admin", role=UserRole.ADMIN)
    response = _client(api, admin, database).request(method, path, json=payload)
    assert response.status_code in {200, 201}

    member = make_user("member", role=UserRole.MEMBER)
    response = _client(api, member, database).request(method, path, json=payload)
    assert response.status_code == 403
