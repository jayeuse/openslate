"""Focused Board ACL contracts without database access."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID

import pytest
from sqlalchemy import CheckConstraint, Index, Text
from uuid6 import uuid7

from app.systems.access.users.models import User
from app.systems.boards.access import can_access_board
from app.systems.boards.models import Board, BoardGrant


def principal(
    *,
    role: str = "member",
    status: str = "active",
    user_deleted: bool = False,
    expires_at: datetime | None = None,
) -> User:
    user_id = uuid7()
    guest = role == "guest"
    return User(
        id=user_id,
        email=f"{user_id.hex}@example.com",
        username=f"board_test_{user_id.hex[:12]}",
        role=role,
        sponsor_user_id=uuid7() if guest else None,
        status=status,
        expires_at=expires_at or (datetime.now(UTC) + timedelta(days=1) if guest else None),
        is_deleted=user_deleted,
        deleted_at=None,
    )


def board(*, owner_id: UUID | None = None, deleted: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid7(),
        owner_id=owner_id or uuid7(),
        is_deleted=deleted,
        deleted_at=None,
    )


def grant(
    board_id: UUID,
    *,
    principal_type: str = "everyone",
    user_id: UUID | None = None,
    permission: str = "view",
    effect: str = "allow",
    deleted: bool = False,
) -> SimpleNamespace:
    return SimpleNamespace(
        board_id=board_id,
        principal_type=principal_type,
        principal_user_id=user_id,
        permission=permission,
        effect=effect,
        is_deleted=deleted,
        deleted_at=None,
    )


def test_board_acl_defaults_to_deny() -> None:
    actor = principal()
    target = board()

    assert not can_access_board(target, actor, "view", [])
    assert not can_access_board(target, actor, "edit", [])


def test_board_grants_never_let_a_guest_edit_or_manage() -> None:
    actor = principal(role="guest")
    target = board()
    grants = [grant(target.id, permission="manage")]

    assert can_access_board(target, actor, "view", grants)
    assert not can_access_board(target, actor, "edit", grants)
    assert not can_access_board(target, actor, "manage", grants)


def test_identity_allow_outranks_everyone_denial() -> None:
    actor = principal(role="guest")
    target = board()
    grants = [
        grant(target.id, permission="view", effect="deny"),
        grant(
            target.id,
            principal_type="user",
            user_id=actor.id,
            permission="view",
            effect="allow",
        ),
    ]

    assert can_access_board(target, actor, "view", grants)


def test_identity_manage_allow_outranks_everyone_view_denial() -> None:
    actor = principal()
    target = board()
    grants = [
        grant(target.id, permission="view", effect="deny"),
        grant(
            target.id,
            principal_type="user",
            user_id=actor.id,
            permission="manage",
            effect="allow",
        ),
    ]

    assert can_access_board(target, actor, "manage", grants)


def test_deny_wins_when_allow_and_deny_have_the_same_identity_priority() -> None:
    actor = principal(role="guest")
    target = board()
    grants = [
        grant(
            target.id,
            principal_type="user",
            user_id=actor.id,
            permission="view",
            effect="allow",
        ),
        grant(
            target.id,
            principal_type="user",
            user_id=actor.id,
            permission="view",
            effect="deny",
        ),
    ]

    assert not can_access_board(target, actor, "view", grants)


@pytest.mark.parametrize(
    ("grant_permission", "action", "expected"),
    [
        ("manage", "manage", True),
        ("manage", "edit", True),
        ("manage", "view", True),
        ("edit", "edit", True),
        ("edit", "view", True),
        ("edit", "manage", False),
        ("view", "edit", False),
    ],
)
def test_higher_board_grants_inherit_lower_actions(
    grant_permission: str,
    action: str,
    expected: bool,
) -> None:
    actor = principal()
    target = board()

    assert can_access_board(
        target,
        actor,
        action,
        [grant(target.id, permission=grant_permission)],
    ) is expected


@pytest.mark.parametrize("action", ["edit", "manage"])
def test_explicit_view_denial_blocks_higher_actions(action: str) -> None:
    actor = principal()
    target = board()
    grants = [
        grant(
            target.id,
            principal_type="user",
            user_id=actor.id,
            permission="view",
            effect="deny",
        ),
        grant(
            target.id,
            principal_type="user",
            user_id=actor.id,
            permission="manage",
            effect="allow",
        ),
    ]

    assert not can_access_board(target, actor, action, grants)


def test_creator_and_active_admin_receive_implicit_management() -> None:
    creator = principal()
    target = board(owner_id=creator.id)
    admin = principal(role="admin")

    for actor in (creator, admin):
        for action in ("view", "edit", "manage"):
            assert can_access_board(target, actor, action, [])


@pytest.mark.parametrize("action", ["view", "edit", "manage"])
@pytest.mark.parametrize("principal_kind", ["creator", "admin"])
def test_creator_and_admin_authority_cannot_be_revoked_by_identity_denials(
    action: str,
    principal_kind: str,
) -> None:
    actor = principal(role="admin" if principal_kind == "admin" else "member")
    target = board(owner_id=actor.id if principal_kind == "creator" else None)
    denials = [
        grant(
            target.id,
            principal_type="user",
            user_id=actor.id,
            permission="view",
            effect="deny",
        ),
        grant(
            target.id,
            principal_type="user",
            user_id=actor.id,
            permission="manage",
            effect="deny",
        ),
    ]

    assert can_access_board(target, actor, action, denials)


def test_a_guest_creator_keeps_only_view() -> None:
    creator = principal(role="guest")
    target = board(owner_id=creator.id)

    assert can_access_board(target, creator, "view", [])
    assert not can_access_board(target, creator, "edit", [])
    assert not can_access_board(target, creator, "manage", [])


def test_inactive_admin_cannot_use_non_revocable_board_authority() -> None:
    admin = principal(role="admin", status="disabled")
    target = board()

    assert not can_access_board(target, admin, "manage", [])


@pytest.mark.parametrize(
    "actor",
    [
        principal(status="disabled"),
        principal(user_deleted=True),
        principal(role="owner"),
        principal(expires_at=datetime.now(UTC) - timedelta(minutes=1)),
    ],
    ids=["disabled", "deleted-user", "unknown-role", "expired-user"],
)
def test_inactive_or_unresolved_principals_fail_closed(actor: User) -> None:
    target = board()

    assert not can_access_board(target, actor, "view", [grant(target.id)])


def test_unresolved_grantees_deleted_boards_and_unknown_actions_fail_closed() -> None:
    actor = principal()
    target = board()
    malformed_grantees = [
        grant(target.id, principal_type="user"),
        grant(target.id, principal_type="role"),
        grant(target.id, principal_type="mystery"),
        grant(target.id, deleted=True),
    ]

    assert not can_access_board(target, actor, "view", malformed_grantees)
    assert not can_access_board(board(deleted=True), actor, "view", [grant(target.id)])
    assert not can_access_board(target, actor, "delete", [grant(target.id, permission="manage")])


def test_board_schema_declares_domain_checks_foreign_keys_and_active_decision_uniqueness() -> None:
    board_checks = {
        constraint.name
        for constraint in Board.__table__.constraints
        if isinstance(constraint, CheckConstraint)
    }
    grant_checks = {
        constraint.name
        for constraint in BoardGrant.__table__.constraints
        if isinstance(constraint, CheckConstraint)
    }
    grant_indexes = {
        index.name: index
        for index in BoardGrant.__table__.indexes
        if isinstance(index, Index)
    }

    assert board_checks == {
        "ck_boards_name_nonempty",
        "ck_boards_revision_positive",
        "ck_boards_status",
        "ck_boards_default_section",
    }
    assert grant_checks == {
        "ck_board_grants_principal_type",
        "ck_board_grants_principal_reference",
        "ck_board_grants_permission",
        "ck_board_grants_effect",
    }
    assert isinstance(Board.__table__.c.description.type, Text)
    assert next(iter(Board.__table__.c.owner_id.foreign_keys)).ondelete == "RESTRICT"
    assert {
        "uq_board_grants_active_user_decision",
        "uq_board_grants_active_everyone_decision",
    } <= grant_indexes.keys()
    assert all(
        grant_indexes[name].unique
        and "is_deleted = false"
        in str(grant_indexes[name].dialect_options["postgresql"]["where"])
        for name in (
            "uq_board_grants_active_user_decision",
                "uq_board_grants_active_everyone_decision",
        )
    )
    expected_foreign_keys = {
        "board_id": "boards.id",
        "principal_user_id": "users.id",
    }
    for column_name, target in expected_foreign_keys.items():
        foreign_key = next(iter(BoardGrant.__table__.c[column_name].foreign_keys))
        assert foreign_key.target_fullname == target
        assert foreign_key.ondelete == "RESTRICT"


def test_board_schema_persists_department_status_and_default_section_metadata() -> None:
    department_id = Board.__table__.c.department_id
    status = Board.__table__.c.status
    default_section = Board.__table__.c.default_section
    index_names = {index.name for index in Board.__table__.indexes}

    assert department_id.nullable
    department_fk = next(iter(department_id.foreign_keys))
    assert department_fk.target_fullname == "departments.id"
    assert department_fk.ondelete == "RESTRICT"
    assert "ix_boards_department_id" in index_names
    assert status.default is not None and status.default.arg == "active"
    assert status.server_default is not None and str(status.server_default.arg) == "'active'"
    assert default_section.default is not None and default_section.default.arg == "overview"
    assert (
        default_section.server_default is not None
        and str(default_section.server_default.arg) == "'overview'"
    )
