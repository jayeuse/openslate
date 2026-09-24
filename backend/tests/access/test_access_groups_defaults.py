"""Behavior contracts for unregistered Access group/default routes."""

import os
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException, Response
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.policy.configuration_router as policy_router
import app.systems.access.policy.schemas as schemas
import app.systems.access.policy.service as policy_service
from app.main import create_app
from app.systems.access.policy.models import (
    AccessDefaultDepartment,
    AccessDefaultGroup,
    AccessGroup,
    AccessGroupMember,
    AccessPolicyDefaults,
)
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus
from app.systems.sandbox.departments.models import Department

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")


def test_group_and_defaults_routes_are_registered_in_the_application() -> None:
    paths = create_app().openapi()["paths"]

    assert "/api/access/groups" in paths
    assert "/api/access/groups/{group_id}" in paths
    assert "/api/access/defaults" in paths


def _role(name: UserRole = UserRole.MEMBER) -> Role:
    return Role(id=uuid7(), role=name.value, permissions={}, is_deleted=False)


def _user(*, expired: bool = False, deleted: bool = False, disabled: bool = False) -> User:
    role = _role()
    now = datetime.now(UTC)
    return User(
        id=uuid7(),
        email=f"{uuid7().hex}@example.com",
        username=f"user-{uuid7().hex[:12]}",
        role_id=role.id,
        role=role,
        identity_kind=IdentityKind.INTERNAL.value,
        status=UserStatus.DISABLED.value if disabled else UserStatus.ACTIVE.value,
        expires_at=now - timedelta(seconds=1) if expired else None,
        is_deleted=deleted,
    )


def test_group_schemas_are_strict_trimmed_and_reject_explicit_nulls() -> None:
    create = schemas.AccessGroupCreate(name="  Operations  ", description="  Team  ")
    assert create.name == "Operations"
    assert create.description == "Team"

    with pytest.raises(ValidationError):
        schemas.AccessGroupCreate.model_validate({"name": "Ops", "unexpected": True})
    with pytest.raises(HTTPException) as error:
        policy_service.require_group_patch(schemas.AccessGroupUpdate())
    assert error.value.status_code == 422
    with pytest.raises(ValidationError):
        schemas.AccessGroupUpdate(name=None)
    with pytest.raises(ValidationError):
        schemas.AccessDefaultsUpdate(group_ids=None)
    with pytest.raises(ValidationError):
        schemas.AccessGroupCreate(name="Operations", description="x" * 2001)
    with pytest.raises(ValidationError):
        schemas.AccessGroupUpdate(description="x" * 2001)


def test_defaults_schema_rejects_disabled_protected_flags_and_bad_durations() -> None:
    with pytest.raises(ValidationError):
        schemas.AccessDefaultsUpdate(default_deny=False)
    with pytest.raises(ValidationError):
        schemas.AccessDefaultsUpdate(invitation_expiry_days=366)


def test_group_etag_is_revision_based_and_requires_match() -> None:
    group = AccessGroup(id=uuid7(), name="Operations", description="", revision=4)
    tag = policy_service.group_etag(group)
    assert tag == f'"{group.id}:4"'
    with pytest.raises(HTTPException) as missing:
        policy_service.require_match(None, tag)
    with pytest.raises(HTTPException) as stale:
        policy_service.require_match('"stale"', tag)
    assert missing.value.status_code == 428
    assert stale.value.status_code == 412


def test_group_member_replacement_deduplicates_and_rejects_expired_users(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    group = AccessGroup(id=uuid7(), name="Operations", description="", revision=1)
    active = _user()
    expired = _user(expired=True)
    db = Mock(spec=Session)
    db.scalars.return_value.all.side_effect = [[], [active]]

    with pytest.raises(HTTPException) as error:
        policy_service.replace_group_members(db, group, [active.id, active.id, expired.id], uuid7())
    assert error.value.status_code == 409

    db.scalars.return_value.all.side_effect = [[], [active]]
    policy_service.replace_group_members(db, group, [active.id, active.id], uuid7())
    additions = [
        call.args[0]
        for call in db.add.call_args_list
        if isinstance(call.args[0], AccessGroupMember)
    ]
    assert [item.user_id for item in additions] == [active.id]


@pytest.mark.parametrize(
    "user",
    [_user(disabled=True), _user(expired=True), _user(deleted=True)],
)
def test_group_member_same_set_still_rejects_ineligible_users(user: User) -> None:
    group = AccessGroup(id=uuid7(), name="Operations", description="", revision=1)
    existing = AccessGroupMember(group_id=group.id, user_id=user.id)
    db = Mock(spec=Session)
    db.scalars.return_value.all.side_effect = [[existing], [], []]

    with pytest.raises(HTTPException) as error:
        policy_service.replace_group_members(db, group, [user.id], uuid7())

    assert error.value.status_code == 409
    db.delete.assert_not_called()
    db.add.assert_not_called()
    db.flush.assert_not_called()


def test_group_edit_preserves_an_unchanged_pending_invite() -> None:
    group = AccessGroup(id=uuid7(), name="Operations", description="", revision=1)
    pending = _user()
    pending.status = UserStatus.PENDING.value
    existing = AccessGroupMember(group_id=group.id, user_id=pending.id)
    db = Mock(spec=Session)
    db.scalars.return_value.all.side_effect = [[existing], [], [pending]]

    changed = policy_service.replace_group_members(db, group, [pending.id], uuid7())

    assert changed is False
    db.delete.assert_not_called()
    db.add.assert_not_called()
    db.flush.assert_not_called()


def test_group_edit_can_add_an_active_member_beside_a_pending_invite() -> None:
    group = AccessGroup(id=uuid7(), name="Operations", description="", revision=1)
    pending = _user()
    pending.status = UserStatus.PENDING.value
    active = _user()
    existing = AccessGroupMember(group_id=group.id, user_id=pending.id)
    db = Mock(spec=Session)
    db.scalars.return_value.all.side_effect = [[existing], [active], [pending]]

    changed = policy_service.replace_group_members(
        db, group, [pending.id, active.id], uuid7()
    )

    assert changed is True
    additions = [
        call.args[0]
        for call in db.add.call_args_list
        if isinstance(call.args[0], AccessGroupMember)
    ]
    assert [item.user_id for item in additions] == [active.id]
    db.delete.assert_not_called()


def test_group_edit_cannot_add_a_new_pending_invite() -> None:
    group = AccessGroup(id=uuid7(), name="Operations", description="", revision=1)
    pending = _user()
    pending.status = UserStatus.PENDING.value
    db = Mock(spec=Session)
    db.scalars.return_value.all.side_effect = [[], []]

    with pytest.raises(HTTPException) as error:
        policy_service.replace_group_members(db, group, [pending.id], uuid7())

    assert error.value.status_code == 409
    db.add.assert_not_called()


@pytest.mark.parametrize(
    ("link_model", "target_model", "target_field"),
    [
        (AccessDefaultGroup, AccessGroup, "group_id"),
        (AccessDefaultDepartment, Department, "department_id"),
    ],
)
def test_default_same_set_still_rejects_deleted_references(
    link_model: type[AccessDefaultGroup] | type[AccessDefaultDepartment],
    target_model: type[AccessGroup] | type[Department],
    target_field: str,
) -> None:
    defaults_id = uuid7()
    target_id = uuid7()
    existing = link_model(id=uuid7(), policy_defaults_id=defaults_id, **{target_field: target_id})
    db = Mock(spec=Session)
    db.scalars.return_value.all.side_effect = [[existing], []]

    with pytest.raises(HTTPException) as error:
        policy_service._replace_default_links(
            db,
            defaults_id,
            [target_id],
            link_model,
            target_model,
            target_field,
            uuid7(),
        )

    assert error.value.status_code == 409
    db.delete.assert_not_called()
    db.add.assert_not_called()
    db.flush.assert_not_called()


def test_group_create_rolls_back_when_members_are_ineligible() -> None:
    db = Mock(spec=Session)
    expired = _user(expired=True)
    db.scalars.return_value.all.side_effect = [[], []]

    with pytest.raises(HTTPException) as error:
        policy_service.create_group(
            db,
            schemas.AccessGroupCreate(name="Operations", member_ids=[expired.id]),
            uuid7(),
        )

    assert error.value.status_code == 409
    db.rollback.assert_called_once()


def test_partial_group_replacement_flush_failure_rolls_back_every_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    group = AccessGroup(id=uuid7(), name="Operations", description="", revision=1)
    old_member_id = uuid7()
    new_member = _user()
    existing = AccessGroupMember(group_id=group.id, user_id=old_member_id)
    db = Mock(spec=Session)
    db.scalars.return_value.all.side_effect = [[existing], [new_member]]
    db.flush.side_effect = SQLAlchemyError("flush failed")
    monkeypatch.setattr(policy_service, "lock_group", lambda *_args: group)

    with pytest.raises(HTTPException) as error:
        policy_service.update_group(
            db,
            group.id,
            schemas.AccessGroupUpdate(member_ids=[new_member.id]),
            policy_service.group_etag(group),
            uuid7(),
        )

    assert error.value.status_code == 503
    assert db.delete.call_args.args == (existing,)
    additions = [
        call.args[0]
        for call in db.add.call_args_list
        if isinstance(call.args[0], AccessGroupMember)
    ]
    assert [item.user_id for item in additions] == [new_member.id]
    db.flush.assert_called_once()
    db.rollback.assert_called_once()


def test_default_group_links_deduplicate_and_explicit_empty_clears() -> None:
    defaults_id = uuid7()
    old_group_id = uuid7()
    new_group_id = uuid7()
    existing = AccessDefaultGroup(
        id=uuid7(),
        policy_defaults_id=defaults_id,
        group_id=old_group_id,
    )
    db = Mock(spec=Session)
    db.scalars.return_value.all.side_effect = [[existing], [new_group_id]]

    changed = policy_service._replace_default_links(
        db,
        defaults_id,
        [new_group_id, new_group_id],
        AccessDefaultGroup,
        AccessGroup,
        "group_id",
        uuid7(),
    )

    assert changed is True
    assert db.delete.call_args.args == (existing,)
    additions = [
        call.args[0]
        for call in db.add.call_args_list
        if isinstance(call.args[0], AccessDefaultGroup)
    ]
    assert [item.group_id for item in additions] == [new_group_id]

    db.reset_mock()
    db.scalars.return_value.all.side_effect = [[existing]]
    assert (
        policy_service._replace_default_links(
            db,
            defaults_id,
            [],
            AccessDefaultGroup,
            AccessGroup,
            "group_id",
            uuid7(),
        )
        is True
    )
    assert db.delete.call_args.args == (existing,)


def test_group_deletion_is_blocked_by_members_or_default_references() -> None:
    group = AccessGroup(id=uuid7(), name="Operations", description="", revision=1)
    db = Mock(spec=Session)
    db.scalar.return_value = 1

    with pytest.raises(HTTPException) as error:
        policy_service.ensure_group_deletable(db, group)
    assert error.value.status_code == 409


@pytest.mark.parametrize(
    "response_builder,row",
    [
        (policy_router._group_response, AccessGroup(id=uuid7(), name="Operations", description="")),
        (
            policy_router._defaults_response,
            AccessPolicyDefaults(id=uuid7(), default_role_id=uuid7()),
        ),
    ],
)
def test_detail_and_defaults_link_reads_fail_safely(
    response_builder: object,
    row: AccessGroup | AccessPolicyDefaults,
) -> None:
    db = Mock(spec=Session)
    db.scalars.side_effect = SQLAlchemyError("read failed")

    with pytest.raises(HTTPException) as error:
        response_builder(db, row)  # type: ignore[operator]

    assert error.value.status_code == 503
    db.rollback.assert_called_once()


def test_group_delete_blocker_read_failure_is_safe() -> None:
    db = Mock(spec=Session)
    db.scalar.side_effect = SQLAlchemyError("count failed")

    with pytest.raises(HTTPException) as error:
        policy_service.ensure_group_deletable(
            db,
            AccessGroup(id=uuid7(), name="Operations", description=""),
        )

    assert error.value.status_code == 503
    db.rollback.assert_called_once()


def test_group_route_invokes_fresh_admin_and_sets_private_create_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin = _user()
    now = datetime.now(UTC)
    group = AccessGroup(
        id=uuid7(),
        name="Operations",
        description="",
        revision=1,
        created_at=now,
        updated_at=now,
        is_deleted=False,
    )
    db = Mock(spec=Session)
    calls: list[object] = []
    monkeypatch.setattr(
        policy_router,
        "require_fresh_exact_admin",
        lambda *_args: calls.append("admin"),
    )
    monkeypatch.setattr(policy_router, "create_group", lambda *_args: group)
    monkeypatch.setattr(policy_router, "group_member_ids", lambda *_args: [])

    response = Response()
    result = policy_router.create_group_route(
        schemas.AccessGroupCreate(name="Operations"), admin, db, response
    )

    assert result.id == group.id
    assert calls == ["admin"]
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["Location"].endswith(str(group.id))


def test_policy_openapi_documents_conditional_mutations_and_list_fields() -> None:
    app = FastAPI()
    app.include_router(policy_router.router, prefix="/api")
    paths = app.openapi()["paths"]

    assert set(policy_router.GROUP_LIST_SPEC.sort_fields) == {"name", "created_at", "updated_at"}
    assert "Location" in paths["/api/access/groups"]["post"]["responses"]["201"]["headers"]
    assert {"412", "428"} <= set(paths["/api/access/groups/{group_id}"]["patch"]["responses"])
    assert "409" in paths["/api/access/groups/{group_id}"]["delete"]["responses"]
    assert {"412", "428"} <= set(paths["/api/access/defaults"]["patch"]["responses"])
    schemas_document = app.openapi()["components"]["schemas"]
    assert "anyOf" not in schemas_document["AccessGroupUpdate"]["properties"]["member_ids"]
    assert "anyOf" not in schemas_document["AccessDefaultsUpdate"]["properties"]["group_ids"]


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_group_and_default_replacements_are_atomic_in_postgresql(integration_db: Session) -> None:
    """Exercise physical replacement rows through the guarded disposable database."""

    role = integration_db.scalar(
        select(Role).where(Role.role == UserRole.MEMBER.value, Role.is_deleted.is_(False))
    )
    assert isinstance(role, Role)
    actor = User(
        id=uuid7(),
        email=f"{uuid7().hex}@example.com",
        username=f"policy-{uuid7().hex[:12]}",
        role_id=role.id,
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
    )
    integration_db.add(actor)
    integration_db.flush()

    group = policy_service.create_group(
        integration_db,
        schemas.AccessGroupCreate(
            name=f"Operations {uuid7().hex}", member_ids=[actor.id, actor.id]
        ),
        actor.id,
    )
    assert policy_service.group_member_ids(integration_db, group.id) == [actor.id]

    updated_group = policy_service.update_group(
        integration_db,
        group.id,
        schemas.AccessGroupUpdate(member_ids=[]),
        policy_service.group_etag(group),
        actor.id,
    )
    assert updated_group.revision == 2
    assert (
        integration_db.scalar(
            select(func.count())
            .select_from(AccessGroupMember)
            .where(AccessGroupMember.group_id == group.id)
        )
        == 0
    )

    defaults = policy_service.get_defaults(integration_db)
    defaults_revision = defaults.revision
    updated_defaults = policy_service.update_defaults(
        integration_db,
        schemas.AccessDefaultsUpdate(group_ids=[group.id, group.id]),
        policy_service.defaults_etag(defaults),
        actor.id,
    )
    group_ids, department_ids = policy_service.default_link_ids(integration_db, updated_defaults.id)
    assert group_ids == [group.id]
    assert department_ids == []
    assert updated_defaults.revision == defaults_revision + 1
    assert (
        integration_db.scalar(
            select(func.count())
            .select_from(AccessDefaultGroup)
            .where(AccessDefaultGroup.policy_defaults_id == updated_defaults.id)
        )
        == 1
    )
