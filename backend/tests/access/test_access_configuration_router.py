"""Response and conditional-header contracts for Access configuration routes."""

from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.policy.configuration_router as policy_router
import app.systems.access.policy.schemas as schemas
from app.common.listing import ListQueryResult, PaginationMetadata
from app.systems.access.policy.models import AccessGroup, AccessPolicyDefaults
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus


def _admin() -> User:
    role = Role(id=uuid7(), role=UserRole.ADMIN.value, permissions={}, is_deleted=False)
    return User(
        id=uuid7(),
        email="admin@example.test",
        username="admin",
        identity_kind=IdentityKind.INTERNAL.value,
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
        role=role,
        is_deleted=False,
    )


def _group() -> AccessGroup:
    now = datetime.now(UTC)
    return AccessGroup(
        id=uuid7(),
        name="Operations",
        description="Team",
        revision=2,
        created_at=now,
        updated_at=now,
        deleted_at=None,
        is_deleted=False,
        performed_by=None,
    )


def _defaults() -> AccessPolicyDefaults:
    now = datetime.now(UTC)
    return AccessPolicyDefaults(
        id=uuid7(),
        singleton_key="workspace",
        default_role_id=uuid7(),
        invitation_expiry_days=14,
        guest_duration_days=45,
        service_duration_days=90,
        default_deny=True,
        require_guest_sponsor=True,
        require_service_owner=True,
        revision=3,
        created_at=now,
        updated_at=now,
        deleted_at=None,
        is_deleted=False,
        performed_by=None,
    )


def test_group_list_serializes_members_pagination_and_private_cache_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    group = _group()
    member_id = uuid7()
    database = Mock(spec=Session)
    monkeypatch.setattr(policy_router, "_exact_admin", lambda *_args: None)
    monkeypatch.setattr(
        policy_router,
        "execute_standard_list",
        lambda *_args: ListQueryResult(
            items=[group],
            pagination=PaginationMetadata(limit=25, offset=0, count=1, total=1, has_more=False),
        ),
    )
    monkeypatch.setattr(
        policy_router,
        "group_member_map",
        lambda *_args: {group.id: [member_id]},
    )
    response = Response()

    result = policy_router.list_groups(
        _admin(), database, response, schemas.AccessGroupListRequest()
    )

    assert result.items[0].member_ids == [member_id]
    assert result.pagination.total == 1
    assert response.headers["Cache-Control"] == "private, no-store"


def test_group_list_database_failure_returns_route_local_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = Mock(spec=Session)
    monkeypatch.setattr(policy_router, "_exact_admin", lambda *_args: None)
    monkeypatch.setattr(
        policy_router,
        "execute_standard_list",
        Mock(side_effect=SQLAlchemyError("list failed")),
    )
    response = Response()

    with pytest.raises(HTTPException) as error:
        policy_router.list_groups(_admin(), database, response, schemas.AccessGroupListRequest())

    assert error.value.status_code == 503
    assert error.value.detail == "Database unavailable"
    assert response.headers["Cache-Control"] == "private, no-store"
    database.rollback.assert_called_once()


def test_group_detail_and_update_routes_return_etags_and_private_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    group = _group()
    database = Mock(spec=Session)
    monkeypatch.setattr(policy_router, "_exact_admin", lambda *_args: None)
    monkeypatch.setattr(policy_router, "get_group", lambda *_args: group)
    monkeypatch.setattr(policy_router, "group_member_ids", lambda *_args: [])
    detail_response = Response()

    detail = policy_router.get_group_route(group.id, _admin(), database, detail_response)

    assert detail.id == group.id
    assert detail_response.headers["ETag"] == policy_router.group_etag(group)
    assert detail_response.headers["Cache-Control"] == "private, no-store"

    monkeypatch.setattr(policy_router, "update_group", lambda *_args: group)
    update_response = Response()
    updated = policy_router.update_group_route(
        group.id,
        schemas.AccessGroupUpdate(name=group.name),
        _admin(),
        database,
        update_response,
        policy_router.group_etag(group),
    )

    assert updated.id == group.id
    assert update_response.headers["ETag"] == policy_router.group_etag(group)
    assert update_response.headers["Cache-Control"] == "private, no-store"


def test_group_delete_route_returns_empty_private_response(monkeypatch: pytest.MonkeyPatch) -> None:
    group = _group()
    database = Mock(spec=Session)
    delete = Mock()
    admin = _admin()
    monkeypatch.setattr(policy_router, "_exact_admin", lambda *_args: None)
    monkeypatch.setattr(policy_router, "delete_group", delete)

    response = policy_router.delete_group_route(
        group.id,
        admin,
        database,
        policy_router.group_etag(group),
    )

    assert response.status_code == 204
    assert response.body == b""
    assert response.headers["Cache-Control"] == "private, no-store"
    delete.assert_called_once_with(database, group.id, policy_router.group_etag(group), admin.id)


def test_defaults_get_and_update_routes_return_etags_and_private_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    defaults = _defaults()
    group_id, department_id = uuid7(), uuid7()
    database = Mock(spec=Session)
    monkeypatch.setattr(policy_router, "_exact_admin", lambda *_args: None)
    monkeypatch.setattr(policy_router, "get_defaults", lambda *_args: defaults)
    monkeypatch.setattr(
        policy_router,
        "default_link_ids",
        lambda *_args: ([group_id], [department_id]),
    )
    get_response = Response()

    result = policy_router.get_defaults_route(_admin(), database, get_response)

    assert result.group_ids == [group_id]
    assert result.department_ids == [department_id]
    assert get_response.headers["ETag"] == policy_router.defaults_etag(defaults)
    assert get_response.headers["Cache-Control"] == "private, no-store"

    monkeypatch.setattr(policy_router, "update_defaults", lambda *_args: defaults)
    update_response = Response()
    updated = policy_router.update_defaults_route(
        schemas.AccessDefaultsUpdate(guest_duration_days=60),
        _admin(),
        database,
        update_response,
        policy_router.defaults_etag(defaults),
    )

    assert updated.guest_duration_days == 45
    assert update_response.headers["ETag"] == policy_router.defaults_etag(defaults)
    assert update_response.headers["Cache-Control"] == "private, no-store"
