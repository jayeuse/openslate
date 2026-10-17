"""Response, conditional-header and visibility contracts for Access group routes."""

from collections.abc import Callable
from datetime import UTC, datetime
from unittest.mock import Mock
from uuid import UUID

import pytest
from fastapi import HTTPException, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.policy.configuration_router as policy_router
import app.systems.access.policy.schemas as schemas
from app.common.listing import ListQueryResult, PaginationMetadata
from app.systems.access.policy.models import AccessLevel, Group
from app.systems.access.policy.scope import EffectiveAccess
from app.systems.access.users.models import User, UserRole
from tests.users.user_support import local_user


def _fresh_admin(database: Mock) -> User:
    """The real fresh administrator check reloads this administrator from the database."""

    admin, membership = local_user(UserRole.ADMIN)
    database.dirty = set()
    database.scalars.return_value.all.return_value = [membership]
    database.scalar.return_value = admin
    return admin


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


def _stored_groups(*groups: Group) -> Callable[[type, UUID], Group | None]:
    """``Session.get`` over the stored groups, as ``get_group`` reads them."""

    stored = {group.id: group for group in groups}
    return lambda model, key: stored.get(key) if model is Group else None


def _group_contents(
    monkeypatch: pytest.MonkeyPatch, group: Group
) -> tuple[UUID, schemas.GroupAccessResponse]:
    """One stored member and one access row of ``group``; the maps answer for the IDs asked."""

    member_id = uuid7()
    access = schemas.GroupAccessResponse(
        department_id=uuid7(),
        department_name="Operations",
        module_name=None,
        level=AccessLevel.READ,
    )
    monkeypatch.setattr(
        policy_router,
        "group_member_map",
        lambda _db, ids: {key: [member_id] for key in ids if key == group.id},
    )
    monkeypatch.setattr(
        policy_router,
        "group_access_map",
        lambda _db, ids: {key: [access] for key in ids if key == group.id},
    )
    return member_id, access


def test_group_list_serializes_members_pagination_and_private_cache_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    group = _group()
    member_id = uuid7()
    database = Mock(spec=Session)
    admin = _fresh_admin(database)
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

    result = policy_router.list_groups(admin, database, response, schemas.GroupListRequest())

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
    admin = _fresh_admin(database)
    monkeypatch.setattr(
        policy_router,
        "execute_standard_list",
        Mock(side_effect=SQLAlchemyError("list failed")),
    )
    response = Response()

    with pytest.raises(HTTPException) as error:
        policy_router.list_groups(admin, database, response, schemas.GroupListRequest())

    assert error.value.status_code == 503
    assert error.value.detail == "Database unavailable"
    assert response.headers["Cache-Control"] == "private, no-store"
    database.rollback.assert_called_once()


def test_group_detail_and_update_routes_return_etags_and_private_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    group = _group()
    database = Mock(spec=Session)
    admin = _fresh_admin(database)
    database.get.side_effect = _stored_groups(group)
    member_id, access = _group_contents(monkeypatch, group)
    detail_response = Response()

    detail = policy_router.get_group_route(group.id, admin, database, detail_response)

    assert detail.id == group.id
    assert detail.member_ids == [member_id]
    assert detail.access == [access]
    assert detail_response.headers["ETag"] == policy_router.group_etag(group)
    assert detail_response.headers["Cache-Control"] == "private, no-store"

    monkeypatch.setattr(policy_router, "update_group", lambda *_args: group)
    update_response = Response()
    updated = policy_router.update_group_route(
        group.id,
        schemas.GroupUpdate(name=group.name),
        admin,
        database,
        update_response,
        policy_router.group_etag(group),
    )

    assert updated.id == group.id
    assert updated.member_ids == [member_id]
    assert updated.access == [access]
    assert update_response.headers["ETag"] == policy_router.group_etag(group)
    assert update_response.headers["Cache-Control"] == "private, no-store"


def test_group_delete_route_returns_empty_private_response(monkeypatch: pytest.MonkeyPatch) -> None:
    group = _group()
    database = Mock(spec=Session)
    delete = Mock()
    admin = _fresh_admin(database)
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
    database = Mock(spec=Session)
    admin = _fresh_admin(database)
    replaced: list[object] = []
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


INVENTORY, FINANCE = uuid7(), uuid7()
FORBIDDEN = (403, "Forbidden")
# The same answer as for a group that does not exist, so a refusal reveals nothing.
NOT_FOUND = (404, "Group not found")


@pytest.mark.parametrize(
    ("departments", "reach", "expected"),
    [
        pytest.param(
            {INVENTORY: AccessLevel.WRITE},
            {INVENTORY},
            [FORBIDDEN, FORBIDDEN, FORBIDDEN],
            id="no-managed-department-is-refused",
        ),
        pytest.param(
            {INVENTORY: AccessLevel.MANAGE},
            {INVENTORY},
            [200, 200, NOT_FOUND],
            id="manager-of-the-whole-reach-sees-the-group",
        ),
        pytest.param(
            {INVENTORY: AccessLevel.MANAGE},
            {INVENTORY, FINANCE},
            [200, NOT_FOUND, NOT_FOUND],
            id="manager-of-part-of-the-reach-gets-not-found",
        ),
    ],
)
def test_a_non_administrator_reads_only_groups_inside_departments_they_manage(
    monkeypatch: pytest.MonkeyPatch,
    departments: dict[UUID, AccessLevel],
    reach: set[UUID],
    expected: list[object],
) -> None:
    group = _group()
    user, membership = local_user(UserRole.MEMBER)
    database = Mock(spec=Session)
    database.dirty = set()
    database.scalars.return_value.all.return_value = [membership]
    database.get.side_effect = _stored_groups(group)
    levels = {user.id: EffectiveAccess(departments=departments)}
    reaches = {group.id: frozenset(reach)}
    monkeypatch.setattr(policy_router, "effective_levels", lambda _db, person: levels[person.id])
    monkeypatch.setattr(policy_router, "group_reach", lambda _db, group_id: reaches[group_id])
    monkeypatch.setattr(
        policy_router,
        "execute_standard_list",
        lambda *_args: ListQueryResult(
            items=[group],
            pagination=PaginationMetadata(limit=25, offset=0, count=1, total=1, has_more=False),
        ),
    )
    _group_contents(monkeypatch, group)
    reads: list[Callable[[], object]] = [
        lambda: policy_router.list_groups(user, database, Response(), schemas.GroupListRequest()),
        lambda: policy_router.get_group_route(group.id, user, database, Response()),
        lambda: policy_router.get_group_route(uuid7(), user, database, Response()),
    ]

    outcomes: list[object] = []
    for read in reads:
        try:
            read()
        except HTTPException as error:
            outcomes.append((error.status_code, error.detail))
        else:
            outcomes.append(200)

    assert outcomes == expected


@pytest.mark.parametrize(
    ("failing", "read"),
    [
        pytest.param("effective_levels", "list", id="levels-for-the-list"),
        pytest.param("effective_levels", "detail", id="levels-for-one-group"),
        pytest.param("group_reach", "detail", id="reach-of-one-group"),
    ],
)
def test_a_database_failure_while_deciding_a_managers_visibility_answers_503(
    monkeypatch: pytest.MonkeyPatch, failing: str, read: str
) -> None:
    group = _group()
    user, membership = local_user(UserRole.MEMBER)
    database = Mock(spec=Session)
    database.dirty = set()
    database.scalars.return_value.all.return_value = [membership]
    database.get.side_effect = _stored_groups(group)
    monkeypatch.setattr(
        policy_router,
        "effective_levels",
        lambda _db, _person: EffectiveAccess(departments={INVENTORY: AccessLevel.MANAGE}),
    )
    monkeypatch.setattr(policy_router, "group_reach", lambda _db, _group_id: frozenset({INVENTORY}))
    monkeypatch.setattr(policy_router, failing, Mock(side_effect=SQLAlchemyError("read failed")))

    reads = {
        "list": lambda: policy_router.list_groups(
            user, database, Response(), schemas.GroupListRequest()
        ),
        "detail": lambda: policy_router.get_group_route(group.id, user, database, Response()),
    }

    with pytest.raises(HTTPException) as error:
        reads[read]()

    assert (error.value.status_code, error.value.detail) == (503, "Database unavailable")
