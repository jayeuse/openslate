"""Capability boundaries for domain and lifecycle routes."""
from __future__ import annotations

from datetime import UTC, datetime
from secrets import token_urlsafe
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.audit.router as audit_router
import app.systems.auth.router as auth_router
import app.systems.departments.router as departments_router
import app.systems.fields.router as fields_router
import app.systems.lifecycle.router as lifecycle_router
import app.systems.modules.router as modules_router
import app.systems.records.router as records_router
import app.systems.relationships.router as relationships_router
import app.systems.users.roles_router as roles_router
import app.systems.users.router as users_router
from app.systems.lifecycle.schemas import (
    LifecycleImpactResponse,
    LifecycleMutationResponse,
    LifecycleOperation,
    LifecyclePurgePreviewResponse,
    LifecycleTargetType,
)
from app.systems.relationships.schemas import RelationshipResponse
from app.systems.users.models import UserRole
from app.systems.users.permissions import ALL_CAPABILITIES, Capability

from .support import (
    _client,
    _empty_list_result,
    _persisted,
    make_field,
    make_module,
    make_role,
    make_user,
)

CONFIRMATION_TOKEN = token_urlsafe(32)
CONFIRMATION_PASSWORD = token_urlsafe(32)


@pytest.mark.parametrize(
    ("resource", "read_capability", "write_capability", "path"),
    [
        ("departments", "departments.read", "departments.write", "/api/departments"),
        ("modules", "modules.read", "modules.write", "/api/modules"),
        ("fields", "fields.read", "fields.write", "/api/fields"),
        ("records", "records.read", "records.write", "/api/records"),
        ("relationships", "relationships.read", "relationships.write", "/api/relationships"),
    ],
)
def test_resource_read_routes_require_read_and_not_write(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    resource: str,
    read_capability: str,
    write_capability: str,
    path: str,
) -> None:
    if resource == "relationships":
        monkeypatch.setattr(
            relationships_router,
            "list_relationships_service",
            lambda *_args: ([], _empty_list_result().pagination),
        )
    else:
        router_module = {
            "departments": departments_router,
            "modules": modules_router,
            "fields": fields_router,
            "records": records_router,
        }[resource]
        monkeypatch.setattr(
            router_module,
            "execute_standard_list",
            lambda *_args: _empty_list_result(),
        )

    write_only = make_user("writer", permissions={write_capability: True})
    assert _client(api, write_only).get(path).status_code == 403

    read_only = make_user("reader", permissions={read_capability: True})
    assert _client(api, read_only).get(path).status_code == 200


@pytest.mark.parametrize(
    ("resource", "read_capability", "write_capability"),
    [
        ("departments", "departments.read", "departments.write"),
        ("modules", "modules.read", "modules.write"),
        ("fields", "fields.read", "fields.write"),
        ("records", "records.read", "records.write"),
        ("relationships", "relationships.read", "relationships.write"),
    ],
)
def test_resource_write_routes_require_write_and_not_read(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    resource: str,
    read_capability: str,
    write_capability: str,
) -> None:
    db = Mock(spec=Session)
    if resource == "departments":
        db.scalar.return_value = None
        db.refresh.side_effect = lambda entity: _persisted(entity)
        path = "/api/departments"
        payload = {"department_name": "Operations"}
    elif resource == "modules":
        module = make_module(accepted=True)
        db.get.return_value = module
        monkeypatch.setattr(modules_router, "_active_fields", lambda *_args: [])
        monkeypatch.setattr(modules_router, "_lock_module", lambda *_args: module)
        monkeypatch.setattr(modules_router, "validate_module_schema", lambda _fields: None)
        path = f"/api/modules/{module.id}/schema/accept"
        payload = None
    elif resource == "fields":
        module = make_module(accepted=True)
        first = make_field(module.id, position=0, name="Title")
        second = make_field(module.id, position=1, name="Summary")
        db.scalars.return_value.all.return_value = [first, second]
        monkeypatch.setattr(fields_router, "_lock_active_module", lambda *_args: module)
        path = f"/api/modules/{module.id}/fields/reorder"
        payload = {"field_ids": [str(second.id), str(first.id)]}
    elif resource == "records":
        module = make_module(accepted=True)
        field = make_field(module.id, position=0, name="Title")
        monkeypatch.setattr(records_router, "_active_module", lambda *_args: module)
        monkeypatch.setattr(records_router, "_lock_active_module", lambda *_args: module)
        monkeypatch.setattr(records_router, "_module_fields", lambda *_args: [field])
        db.refresh.side_effect = lambda entity: _persisted(entity)
        path = "/api/records"
        payload = {"module_id": str(module.id), "data": {}}
    else:
        relationship = RelationshipResponse(
            id=uuid7(),
            field_id=uuid7(),
            source_record_id=uuid7(),
            target_record_id=uuid7(),
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            deleted_at=None,
            is_deleted=False,
            performed_by=None,
            visibility="available",
            hidden_reasons=[],
        )
        monkeypatch.setattr(
            relationships_router,
            "create_relationship_service",
            lambda *_args: object(),
        )
        monkeypatch.setattr(
            relationships_router,
            "relationship_response",
            lambda _edge: relationship,
        )
        path = "/api/relationships"
        payload = {
            "field_id": str(relationship.field_id),
            "source_record_id": str(relationship.source_record_id),
            "target_record_id": str(relationship.target_record_id),
        }

    write_only = make_user("writer", permissions={write_capability: True})
    response = _client(api, write_only, db).request("POST", path, json=payload)
    assert response.status_code in {200, 201}

    read_only = make_user("reader", permissions={read_capability: True})
    response = _client(api, read_only, db).request("POST", path, json=payload)
    assert response.status_code == 403


@pytest.mark.parametrize(
    ("target_type", "operation", "path", "capability"),
    [
        (
            LifecycleTargetType.DEPARTMENT,
            LifecycleOperation.CLOSE,
            f"/api/departments/{uuid7()}/close",
            Capability.DEPARTMENTS_WRITE,
        ),
        (
            LifecycleTargetType.DEPARTMENT,
            LifecycleOperation.REOPEN,
            f"/api/departments/{uuid7()}/reopen",
            Capability.DEPARTMENTS_WRITE,
        ),
        (
            LifecycleTargetType.MODULE,
            LifecycleOperation.CLOSE,
            f"/api/modules/{uuid7()}/close",
            Capability.MODULES_WRITE,
        ),
        (
            LifecycleTargetType.MODULE,
            LifecycleOperation.REOPEN,
            f"/api/modules/{uuid7()}/reopen",
            Capability.MODULES_WRITE,
        ),
        (
            LifecycleTargetType.FIELD,
            LifecycleOperation.CLOSE,
            f"/api/fields/{uuid7()}/close",
            Capability.FIELDS_WRITE,
        ),
        (
            LifecycleTargetType.FIELD,
            LifecycleOperation.REOPEN,
            f"/api/fields/{uuid7()}/reopen",
            Capability.FIELDS_WRITE,
        ),
    ],
)
def test_lifecycle_close_and_reopen_use_corresponding_resource_write_capability(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    target_type: LifecycleTargetType,
    operation: LifecycleOperation,
    path: str,
    capability: Capability,
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

    write_only = make_user("lifecycle-writer", permissions={capability.value: True})
    blocked = make_user("lifecycle-blocked", permissions={})
    response = _client(api, blocked).post(path, json=payload)
    assert response.status_code == 403
    response = _client(api, write_only).post(path, json=payload)
    assert response.status_code == 200

    read_only = make_user(
        "lifecycle-reader",
        permissions={capability.value.replace(".write", ".read"): True},
    )
    assert _client(api, read_only).post(path, json=payload).status_code == 403


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
            f"/api/departments/{uuid7()}/purge/preview",
        ),
        (LifecycleTargetType.DEPARTMENT, f"/api/departments/{uuid7()}/purge"),
        (LifecycleTargetType.MODULE, f"/api/modules/{uuid7()}/purge/preview"),
        (LifecycleTargetType.MODULE, f"/api/modules/{uuid7()}/purge"),
        (LifecycleTargetType.FIELD, f"/api/fields/{uuid7()}/purge/preview"),
        (LifecycleTargetType.FIELD, f"/api/fields/{uuid7()}/purge"),
        (LifecycleTargetType.RECORD, f"/api/records/{uuid7()}/purge/preview"),
        (LifecycleTargetType.RECORD, f"/api/records/{uuid7()}/purge"),
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

    admin = make_user("admin", role=make_role(UserRole.ADMIN, {"not-a-capability": "bad"}))
    response = _client(api, admin).request("POST", path, json=payload)
    assert response.status_code == 200

    non_admin_with_every_capability = make_user(
        "custom",
        permissions={capability: True for capability in ALL_CAPABILITIES},
    )
    response = _client(api, non_admin_with_every_capability).request("POST", path, json=payload)
    assert response.status_code == 403


@pytest.mark.parametrize(
    ("path", "method", "payload", "route_group"),
    [
        ("/api/users", "GET", None, "users"),
        ("/api/roles", "GET", None, "roles"),
        (
            "/api/auth/invitations",
            "POST",
            {"email": "invited@example.com", "username": "invited"},
            "invitations",
        ),
        ("/api/audit-logs", "GET", None, "audit"),
    ],
)
def test_users_roles_invitations_and_audit_are_literal_admin_only(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    method: str,
    payload: dict[str, object] | None,
    route_group: str,
) -> None:
    if route_group == "users":
        monkeypatch.setattr(
            users_router,
            "execute_standard_list",
            lambda *_args: _empty_list_result(),
        )
    elif route_group == "roles":
        monkeypatch.setattr(
            roles_router,
            "execute_standard_list",
            lambda *_args: _empty_list_result(),
        )
    elif route_group == "invitations":
        monkeypatch.setattr(
            auth_router,
            "invite_user",
            lambda *_args, **_kwargs: make_user("invited"),
        )
    else:
        monkeypatch.setattr(
            audit_router,
            "list_audit_logs",
            lambda *_args, **_kwargs: _empty_list_result(),
        )

    admin = make_user("admin", role=make_role(UserRole.ADMIN))
    response = _client(api, admin).request(method, path, json=payload)
    assert response.status_code in {200, 201}

    custom = make_user(
        "custom",
        permissions={capability: True for capability in ALL_CAPABILITIES},
    )
    response = _client(api, custom).request(method, path, json=payload)
    assert response.status_code == 403
