from collections.abc import Generator
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
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
import app.systems.users.router as users_router
import app.systems.users.service as users_service
from app.common.dependencies.auth import (
    VerifiedPendingIdentity,
    get_current_user,
    get_verified_pending_identity,
    require_capability,
)
from app.common.listing import ListQueryResult, PaginationMetadata
from app.core.database import get_db
from app.core.integrations.supabase import SupabaseAdminClient
from app.main import create_app
from app.systems.fields.models import Field, FieldType
from app.systems.lifecycle.schemas import (
    LifecycleImpactResponse,
    LifecycleMutationResponse,
    LifecycleOperation,
    LifecyclePurgePreviewResponse,
    LifecycleTargetType,
)
from app.systems.modules.models import Module
from app.systems.relationships.schemas import RelationshipResponse
from app.systems.users.models import Role, User, UserRole
from app.systems.users.permissions import (
    ALL_CAPABILITIES,
    Capability,
    effective_permissions,
)
from app.systems.users.schemas import RoleCreate, RoleUpdate


def _persisted(entity: Any, *, deleted: bool = False) -> Any:
    now = datetime.now(UTC)
    entity.id = uuid7()
    entity.created_at = now
    entity.updated_at = now
    entity.is_deleted = deleted
    entity.deleted_at = now if deleted else None
    entity.performed_by = None
    return entity


def make_role(
    name: str = UserRole.MEMBER,
    permissions: object | None = None,
    *,
    deleted: bool = False,
) -> Role:
    role = Role(
        role=name,
        permissions={} if permissions is None else permissions,
        is_deleted=deleted,
    )
    return _persisted(role, deleted=deleted)


def make_user(
    name: str,
    *,
    role: Role | None = None,
    permissions: object | None = None,
    status: str = "active",
    deleted: bool = False,
) -> User:
    assigned_role = role or make_role(permissions=permissions)
    user = User(
        id=uuid7(),
        email=f"{name}@example.com",
        username=name,
        status=status,
        role_id=assigned_role.id,
        role=assigned_role,
        is_deleted=deleted,
    )
    return _persisted(user, deleted=deleted)


def make_module(department_id=None, *, accepted: bool = False) -> Module:
    module = Module(
        department_id=department_id or uuid7(),
        module_name="Assets",
        is_schema_accepted=accepted,
    )
    return _persisted(module)


def make_field(module_id, *, position: int, name: str) -> Field:
    return _persisted(
        Field(
            module_id=module_id,
            name=name,
            type=FieldType.TEXT,
            required=False,
            position=position,
            config={},
        )
    )


def _empty_list_result() -> ListQueryResult[Any]:
    return ListQueryResult(
        items=[],
        pagination=PaginationMetadata(
            limit=25,
            offset=0,
            count=0,
            total=0,
            has_more=False,
        ),
    )


@pytest.fixture
def api() -> Generator[FastAPI, None, None]:
    application = create_app()
    yield application
    application.dependency_overrides.clear()


def _client(application: FastAPI, user: User, db: Session | None = None) -> TestClient:
    database = db or Mock(spec=Session)
    application.dependency_overrides[get_current_user] = lambda: user
    application.dependency_overrides[get_db] = lambda: database
    return TestClient(application)


def test_role_schemas_accept_finite_flat_boolean_capabilities() -> None:
    permissions = {capability: index % 2 == 0 for index, capability in enumerate(ALL_CAPABILITIES)}

    assert RoleCreate(role="editor", permissions=permissions).permissions == permissions
    assert RoleUpdate(permissions=permissions).permissions == permissions


@pytest.mark.parametrize(
    "permissions",
    [
        {"unknown.read": True},
        {"records": {"read": True}},
        {"records.read": "true"},
    ],
    ids=["unknown", "nested", "non-boolean"],
)
@pytest.mark.parametrize("schema", [RoleCreate, RoleUpdate], ids=["create", "update"])
def test_role_schemas_reject_unknown_nested_and_non_boolean_capabilities(
    schema: type[RoleCreate] | type[RoleUpdate],
    permissions: dict[str, Any],
) -> None:
    values: dict[str, Any] = {"permissions": permissions}
    if schema is RoleCreate:
        values["role"] = "editor"

    with pytest.raises(ValidationError):
        schema.model_validate(values)


@pytest.mark.parametrize(
    "permissions",
    [
        None,
        [],
        {"records": {"read": True}},
        {"records.read": "true"},
        {"unknown.read": True},
    ],
    ids=["none", "list", "nested", "non-boolean", "unknown"],
)
def test_malformed_persisted_permissions_are_effectively_zero(permissions: object) -> None:
    role = SimpleNamespace(role="editor", permissions=permissions)

    assert effective_permissions(role) == []


def test_admin_effective_permissions_are_all_even_when_persisted_document_is_malformed() -> None:
    role = SimpleNamespace(role=UserRole.ADMIN, permissions={"records": {"read": "not-a-boolean"}})
    user = SimpleNamespace(role=role)

    assert effective_permissions(role) == list(ALL_CAPABILITIES)
    assert all(require_capability(capability)(user) for capability in Capability)


def test_effective_permissions_are_deterministic_and_sorted() -> None:
    role = make_role(
        "editor",
        {
            "records.write": True,
            "departments.read": True,
            "records.read": False,
        },
    )

    assert effective_permissions(role) == ["departments.read", "records.write"]


def test_require_capability_accepts_a_permitted_non_admin() -> None:
    user = make_user("reader", permissions={"records.read": True})

    assert require_capability(Capability.RECORDS_READ)(user) is user


@pytest.mark.parametrize(
    "permissions",
    [{}, {"departments.read": True}, {"records.read": "true"}, {"records": {"read": True}}],
    ids=["missing", "unrelated", "non-boolean", "nested"],
)
def test_require_capability_rejects_missing_or_malformed_permissions(
    permissions: object,
) -> None:
    user = SimpleNamespace(role=SimpleNamespace(role="editor", permissions=permissions))

    with pytest.raises(HTTPException) as raised:
        require_capability(Capability.RECORDS_WRITE)(user)

    assert raised.value.status_code == 403


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
        monkeypatch.setattr(records_router, "_active_module", lambda *_args: module)
        monkeypatch.setattr(records_router, "_lock_active_module", lambda *_args: module)
        monkeypatch.setattr(records_router, "_module_fields", lambda *_args: [])
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
            "token": "token",
            "confirmation_name": "Operations",
            "password": "password",
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
        token="token",
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
            "token": "token",
            "confirmation_name": "Operations",
            "password": "password",
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
    if route_group in {"users", "roles"}:
        monkeypatch.setattr(
            users_router,
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
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    monkeypatch.setattr(users_router, "_security_event", lambda *_args, **_kwargs: None)

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
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    monkeypatch.setattr(users_router, "_security_event", event_writer)

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
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    monkeypatch.setattr(users_router, "_security_event", events)

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
