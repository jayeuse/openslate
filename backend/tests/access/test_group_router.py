"""Response and conditional-header contracts for Access group routes."""

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
from app.systems.access.policy.models import AccessLevel, Group
from app.systems.access.users.models import User, UserRole, UserStatus


def _admin() -> User:
    return User(
        id=uuid7(),
        email="admin@example.test",
        username="admin",
        role=UserRole.ADMIN.value,
        status=UserStatus.ACTIVE.value,
        is_deleted=False,
    )


def _group() -> Group:
    now = datetime.now(UTC)
    return Group(
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
    department_id = uuid7()
    monkeypatch.setattr(
        policy_router,
        "group_member_map",
        lambda *_args: {group.id: [member_id]},
    )
    monkeypatch.setattr(
        policy_router,
        "group_access_map",
        lambda *_args: {
            group.id: [
                schemas.GroupAccessResponse(
                    department_id=department_id,
                    department_name="Operations",
                    module_name=None,
                    level=AccessLevel.WRITE,
                )
            ]
        },
    )
    response = Response()

    result = policy_router.list_groups(_admin(), database, response, schemas.GroupListRequest())

    assert result.items[0].member_ids == [member_id]
    assert [
        (item.department_id, item.module_id, item.level) for item in result.items[0].access
    ] == [(department_id, None, AccessLevel.WRITE)]
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
        policy_router.list_groups(_admin(), database, response, schemas.GroupListRequest())

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
    monkeypatch.setattr(policy_router, "group_member_map", lambda *_args: {})
    monkeypatch.setattr(policy_router, "group_access_map", lambda *_args: {})
    detail_response = Response()

    detail = policy_router.get_group_route(group.id, _admin(), database, detail_response)

    assert detail.id == group.id
    assert detail_response.headers["ETag"] == policy_router.group_etag(group)
    assert detail_response.headers["Cache-Control"] == "private, no-store"

    monkeypatch.setattr(policy_router, "update_group", lambda *_args: group)
    update_response = Response()
    updated = policy_router.update_group_route(
        group.id,
        schemas.GroupUpdate(name=group.name),
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


def test_group_access_replacement_route_passes_the_precondition_and_returns_the_new_etag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    group = _group()
    admin = _admin()
    database = Mock(spec=Session)
    replaced: list[object] = []
    monkeypatch.setattr(policy_router, "_exact_admin", lambda *_args: None)
    monkeypatch.setattr(policy_router, "group_member_map", lambda *_args: {})
    monkeypatch.setattr(policy_router, "group_access_map", lambda *_args: {})

    def replace(*args: object) -> Group:
        replaced.append(args)
        group.revision += 1
        return group

    monkeypatch.setattr(policy_router, "replace_group_access", replace)
    payload = schemas.GroupAccessReplace(
        access=[schemas.GroupAccessEntry(department_id=uuid7(), level=AccessLevel.READ)]
    )
    response = Response()
    current_etag = policy_router.group_etag(group)

    result = policy_router.replace_group_access_route(
        group.id, payload, admin, database, response, current_etag
    )

    assert replaced == [(database, group.id, payload.access, current_etag, admin.id)]
    assert result.revision == 3
    assert response.headers["ETag"] == policy_router.group_etag(group)
    assert response.headers["Cache-Control"] == "private, no-store"
