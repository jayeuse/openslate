"""Creation-time application of persisted Access defaults."""

import os
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.account_operations as account_operations
import app.systems.access.users.roles_router as roles_router
import app.systems.access.users.service as user_service
from app.systems.access.policy import service as policy_service
from app.systems.access.policy.models import (
    AccessDefaultDepartment,
    AccessDefaultGroup,
    AccessGroup,
    AccessGroupMember,
)
from app.systems.access.policy.service import CreationDefaults
from app.systems.access.users.coordination import (
    InvitationError,
    active_admin_count,
    ensure_projected_admin_remains,
    is_active_admin,
)
from app.systems.access.users.models import (
    IdentityKind,
    Role,
    User,
    UserDepartment,
    UserRole,
    UserStatus,
)
from app.systems.access.users.schemas import InvitationCreate, UserCreate, UserUpdate
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.exceptions import LifecyclePreflightError
from app.systems.sandbox.lifecycle.planner import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleTargetType
from app.systems.sandbox.lifecycle.service import close_lifecycle

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")


def _role(name: UserRole = UserRole.MEMBER) -> Role:
    return Role(id=uuid7(), role=name.value, permissions={}, is_deleted=False)


def _defaults(
    role: Role,
    *,
    group_ids: tuple = (),
    department_ids: tuple = (),
    invitation_expiry_days: int = 7,
    guest_duration_days: int = 30,
) -> CreationDefaults:
    return CreationDefaults(
        role=role,
        group_ids=group_ids,
        department_ids=department_ids,
        invitation_expiry_days=invitation_expiry_days,
        guest_duration_days=guest_duration_days,
    )


def _prepare_invitation(monkeypatch: pytest.MonkeyPatch, defaults: CreationDefaults) -> Mock:
    db = Mock(spec=Session)
    db.scalar.return_value = None
    monkeypatch.setattr(user_service, "load_creation_defaults", lambda _db: defaults)
    monkeypatch.setattr(user_service, "create_credential", Mock())
    monkeypatch.setattr(user_service, "append_security_event", Mock())
    monkeypatch.setattr(db, "flush", lambda: None)
    return db


def test_create_distinguishes_omitted_departments_from_an_explicit_empty_list() -> None:
    omitted = UserCreate(email="omitted@example.com", username="omitted")
    explicit_empty = UserCreate(
        email="explicit@example.com",
        username="explicit",
        department_ids=[],
    )

    assert omitted.department_ids is None
    assert explicit_empty.department_ids == []


def test_omitted_departments_and_groups_use_defaults_without_inventing_a_primary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    role = _role()
    department_a, department_b = uuid7(), uuid7()
    group_a, group_b = uuid7(), uuid7()
    db = _prepare_invitation(
        monkeypatch,
        _defaults(
            role,
            department_ids=(department_b, department_a),
            group_ids=(group_b, group_a),
        ),
    )
    resolved: list[tuple[list, object]] = []
    monkeypatch.setattr(
        user_service,
        "resolve_department_memberships",
        lambda _db, ids, primary: resolved.append((ids, primary)) or tuple(ids),
    )

    user = user_service.invite_user(
        db,
        InvitationCreate(email="new@example.com", username="new"),
        bootstrap=True,
    )

    assert user.role_id == role.id
    assert resolved == [([department_b, department_a], None)]
    memberships = [
        call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], UserDepartment)
    ]
    assert [(row.department_id, row.is_primary) for row in memberships] == [
        (department_b, False),
        (department_a, False),
    ]
    groups = [
        call.args[0]
        for call in db.add.call_args_list
        if isinstance(call.args[0], AccessGroupMember)
    ]
    assert [(row.group_id, row.user_id) for row in groups] == [
        (group_b, user.id),
        (group_a, user.id),
    ]


def test_explicit_empty_departments_and_explicit_role_override_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    default_role, explicit_role = _role(), _role()
    db = _prepare_invitation(monkeypatch, _defaults(default_role, department_ids=(uuid7(),)))
    monkeypatch.setattr(user_service, "_lock_role", lambda _db, _role_id: explicit_role)
    seen: list[list] = []
    monkeypatch.setattr(
        user_service,
        "resolve_department_memberships",
        lambda _db, ids, _primary: seen.append(ids) or (),
    )

    user = user_service.invite_user(
        db,
        InvitationCreate(
            email="explicit@example.com",
            username="explicit",
            role_id=explicit_role.id,
            department_ids=[],
        ),
        bootstrap=True,
    )

    assert user.role_id == explicit_role.id
    assert seen == [[]]


def test_guest_expiry_defaults_only_when_omitted_and_explicit_expiry_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 9, 23, tzinfo=UTC)
    role = _role()
    sponsor_id = uuid7()
    defaults = _defaults(role, guest_duration_days=17)
    db = _prepare_invitation(monkeypatch, defaults)
    monkeypatch.setattr(user_service, "utc_now", lambda: now)
    monkeypatch.setattr(user_service, "validate_identity_profile", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(user_service, "resolve_department_memberships", lambda *_args: ())

    derived = user_service.invite_user(
        db,
        InvitationCreate(
            email="derived@example.com",
            username="derived",
            identity_kind=IdentityKind.GUEST,
            sponsor_user_id=sponsor_id,
        ),
        bootstrap=True,
    )
    explicit_expiry = now + timedelta(days=2)
    explicit = user_service.invite_user(
        db,
        InvitationCreate(
            email="explicit-expiry@example.com",
            username="explicit-expiry",
            identity_kind=IdentityKind.GUEST,
            sponsor_user_id=sponsor_id,
            expires_at=explicit_expiry,
        ),
        bootstrap=True,
    )

    assert derived.expires_at == now + timedelta(days=17)
    assert explicit.expires_at == explicit_expiry


def test_email_invitation_uses_configured_duration(monkeypatch: pytest.MonkeyPatch) -> None:
    db = _prepare_invitation(monkeypatch, _defaults(_role(), invitation_expiry_days=19))
    monkeypatch.setattr(user_service, "smtp_delivery_enabled", lambda: True)
    issued = Mock(return_value="token")
    monkeypatch.setattr(user_service, "issue_action_token", issued)
    monkeypatch.setattr(user_service, "queue_action_delivery", Mock())

    user_service.invite_user(
        db,
        InvitationCreate(email="email@example.com", username="email"),
        bootstrap=True,
        delivery="email",
    )

    assert issued.call_args.kwargs["invitation_lifetime"] == timedelta(days=19)


def test_legacy_resend_uses_the_current_configured_invitation_duration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = User(
        id=uuid7(),
        email="pending@example.com",
        username="pending",
        role_id=uuid7(),
        status="pending",
        identity_kind="internal",
    )
    db = Mock(spec=Session)
    calls: list[str] = []
    monkeypatch.setattr(user_service, "require_fresh_exact_admin", Mock())
    monkeypatch.setattr(
        user_service,
        "load_invitation_expiry_days",
        lambda _db: calls.append("defaults") or 13,
    )
    monkeypatch.setattr(
        user_service,
        "_lock_profile",
        lambda *_args: calls.append("profile") or profile,
    )
    issued = Mock(return_value="token")
    monkeypatch.setattr(user_service, "issue_action_token", issued)
    monkeypatch.setattr(user_service, "_security_event", Mock())

    user_service.resend_invitation(db, profile.id, actor_id=uuid7())

    assert calls == ["defaults", "profile"]
    assert issued.call_args.kwargs["invitation_lifetime"] == timedelta(days=13)


def test_email_delivery_resend_uses_the_current_configured_invitation_duration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = User(
        id=uuid7(),
        email="pending-email@example.com",
        username="pending_email",
        role_id=uuid7(),
        status="pending",
        identity_kind="internal",
    )
    db = Mock(spec=Session)
    calls: list[str] = []
    monkeypatch.setattr(user_service, "smtp_delivery_enabled", lambda: True)
    monkeypatch.setattr(user_service, "require_fresh_exact_admin", Mock())
    monkeypatch.setattr(
        user_service,
        "load_invitation_expiry_days",
        lambda _db: calls.append("defaults") or 23,
    )
    monkeypatch.setattr(
        user_service,
        "_lock_profile",
        lambda *_args: calls.append("profile") or profile,
    )
    monkeypatch.setattr(user_service, "replace_password", Mock())
    issued = Mock(return_value="token")
    monkeypatch.setattr(user_service, "issue_action_token", issued)
    monkeypatch.setattr(user_service, "queue_action_delivery", Mock())
    monkeypatch.setattr(user_service, "append_security_event", Mock())
    monkeypatch.setattr(user_service, "_security_event", Mock())

    user_service.resend_invitation_delivery(
        db,
        profile.id,
        actor_id=uuid7(),
        delivery="email",
        temporary_password=None,
    )

    assert calls == ["defaults", "profile"]
    assert issued.call_args.kwargs["invitation_lifetime"] == timedelta(days=23)


def test_invalid_defaults_roll_back_before_creating_any_identity_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    monkeypatch.setattr(
        user_service,
        "load_creation_defaults",
        Mock(side_effect=ValueError("default group is unavailable")),
    )
    monkeypatch.setattr(user_service, "_security_event", Mock())

    with pytest.raises(InvitationError, match="Access defaults"):
        user_service.invite_user(
            db,
            InvitationCreate(email="blocked@example.com", username="blocked"),
            bootstrap=True,
        )

    db.add.assert_not_called()
    db.commit.assert_not_called()
    db.rollback.assert_called_once()


def test_existing_user_profile_update_does_not_apply_creation_defaults() -> None:
    role = _role()
    existing = User(
        email="existing@example.com",
        username="existing",
        role_id=role.id,
        role=role,
        status="active",
        identity_kind="internal",
        display_name="Before",
    )

    account_operations._apply_profile_update(
        Mock(spec=Session),
        existing,
        UserUpdate(display_name="After"),
        destination_role=role,
    )

    assert existing.display_name == "After"


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_creation_defaults_apply_only_to_new_users_in_postgresql(integration_db: Session) -> None:
    defaults = policy_service.get_defaults(integration_db, lock=True)
    department = Department(department_name=f"Default Department {uuid7().hex}")
    group = AccessGroup(name=f"Default Group {uuid7().hex}", description="")
    integration_db.add_all((department, group))
    integration_db.flush()
    integration_db.add_all(
        (
            AccessDefaultDepartment(
                policy_defaults_id=defaults.id,
                department_id=department.id,
            ),
            AccessDefaultGroup(policy_defaults_id=defaults.id, group_id=group.id),
        )
    )
    integration_db.flush()

    user = user_service.invite_user(
        integration_db,
        InvitationCreate(
            email=f"default-{uuid7().hex}@example.com",
            username=f"default_{uuid7().hex[:12]}",
        ),
        bootstrap=True,
        temporary_password="initial temporary password",
    )

    memberships = integration_db.scalars(
        select(UserDepartment).where(UserDepartment.user_id == user.id)
    ).all()
    assert [(row.department_id, row.is_primary) for row in memberships] == [(department.id, False)]
    assert (
        integration_db.scalar(
            select(func.count())
            .select_from(AccessGroupMember)
            .where(AccessGroupMember.group_id == group.id, AccessGroupMember.user_id == user.id)
        )
        == 1
    )
    assert user.role_id == defaults.default_role_id

    existing = User(
        email=f"existing-{uuid7().hex}@example.com",
        username=f"existing_{uuid7().hex[:12]}",
        role_id=defaults.default_role_id,
        status="active",
        identity_kind="internal",
    )
    integration_db.add(existing)
    integration_db.flush()
    assert (
        integration_db.scalar(
            select(func.count())
            .select_from(UserDepartment)
            .where(UserDepartment.user_id == existing.id)
        )
        == 0
    )

    users_before = integration_db.scalar(select(func.count()).select_from(User))
    members_before = integration_db.scalar(select(func.count()).select_from(AccessGroupMember))
    group.is_deleted = True
    integration_db.commit()

    with pytest.raises(InvitationError, match="Access defaults"):
        user_service.invite_user(
            integration_db,
            InvitationCreate(
                email=f"blocked-{uuid7().hex}@example.com",
                username=f"blocked_{uuid7().hex[:12]}",
            ),
            bootstrap=True,
            temporary_password="initial temporary password",
        )

    assert integration_db.scalar(select(func.count()).select_from(User)) == users_before
    assert (
        integration_db.scalar(select(func.count()).select_from(AccessGroupMember)) == members_before
    )


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_default_department_close_is_blocked_before_invitations_break(
    integration_db: Session,
) -> None:
    defaults = policy_service.get_defaults(integration_db, lock=True)
    department = Department(department_name=f"Protected {uuid7().hex}")
    integration_db.add(department)
    integration_db.flush()
    integration_db.add(
        AccessDefaultDepartment(policy_defaults_id=defaults.id, department_id=department.id)
    )
    integration_db.commit()

    preview = plan_lifecycle(
        integration_db, LifecycleTargetType.DEPARTMENT, department.id, "close", None
    )
    assert any("default" in blocker.detail.lower() for blocker in preview.blockers)

    with pytest.raises(LifecyclePreflightError, match="default"):
        close_lifecycle(
            integration_db,
            LifecycleTargetType.DEPARTMENT,
            department.id,
            None,
            plan=preview,
        )

    assert department.is_deleted is False
    assert policy_service.load_creation_defaults(integration_db).department_ids == (department.id,)


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_configured_default_role_cannot_be_deleted_in_postgresql(
    integration_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    defaults = policy_service.get_defaults(integration_db, lock=True)
    role = Role(role=f"custom-{uuid7().hex}", permissions={})
    integration_db.add(role)
    integration_db.flush()
    defaults.default_role_id = role.id
    integration_db.commit()
    actor = User(id=uuid7(), role_id=role.id)
    monkeypatch.setattr(roles_router, "require_fresh_exact_admin", lambda *_args: actor)

    with pytest.raises(HTTPException, match="default role") as error:
        roles_router.delete_role(role.id, actor, integration_db)

    assert error.value.status_code == 409
    assert role.is_deleted is False
    assert policy_service.load_creation_defaults(integration_db).role.id == role.id


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_expired_administrator_is_not_counted_as_usable_in_postgresql(
    integration_db: Session,
) -> None:
    admin_role = integration_db.scalar(select(Role).where(Role.role == UserRole.ADMIN.value))
    assert admin_role is not None
    before = active_admin_count(integration_db)
    current = User(
        email=f"current-{uuid7().hex}@example.com",
        username=f"current_{uuid7().hex[:12]}",
        role_id=admin_role.id,
        role=admin_role,
        status="active",
        identity_kind="internal",
    )
    expired = User(
        email=f"expired-{uuid7().hex}@example.com",
        username=f"expired_{uuid7().hex[:12]}",
        role_id=admin_role.id,
        role=admin_role,
        status="active",
        identity_kind="internal",
        expires_at=datetime.now(UTC) - timedelta(days=1),
    )
    integration_db.add_all((current, expired))
    integration_db.flush()

    assert is_active_admin(current) is True
    assert is_active_admin(expired) is False
    assert active_admin_count(integration_db) == before + 1


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_default_group_keeps_pending_invite_during_member_edits_in_postgresql(
    integration_db: Session,
) -> None:
    defaults = policy_service.get_defaults(integration_db, lock=True)
    group = AccessGroup(name=f"Invitations {uuid7().hex}", description="")
    integration_db.add(group)
    integration_db.flush()
    integration_db.add(AccessDefaultGroup(policy_defaults_id=defaults.id, group_id=group.id))
    pending = User(
        email=f"pending-{uuid7().hex}@example.com",
        username=f"pending_{uuid7().hex[:12]}",
        role_id=defaults.default_role_id,
        status=UserStatus.PENDING.value,
        identity_kind=IdentityKind.INTERNAL.value,
        invitation_sent_at=datetime.now(UTC),
    )
    active = User(
        email=f"active-{uuid7().hex}@example.com",
        username=f"active_{uuid7().hex[:12]}",
        role_id=defaults.default_role_id,
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
    )
    integration_db.add_all((pending, active))
    integration_db.flush()
    integration_db.add(AccessGroupMember(group_id=group.id, user_id=pending.id))
    integration_db.commit()

    assert policy_service.replace_group_members(
        integration_db, group, [pending.id, active.id], uuid7()
    )
    assert {
        row.user_id
        for row in integration_db.scalars(
            select(AccessGroupMember).where(AccessGroupMember.group_id == group.id)
        )
    } == {pending.id, active.id}


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_future_expiring_admin_cannot_replace_the_only_durable_admin(
    integration_db: Session,
) -> None:
    admin_role = integration_db.scalar(select(Role).where(Role.role == UserRole.ADMIN.value))
    assert admin_role is not None
    assert active_admin_count(integration_db) == 0
    durable = User(
        email=f"durable-{uuid7().hex}@example.com",
        username=f"durable_{uuid7().hex[:12]}",
        role_id=admin_role.id,
        role=admin_role,
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
    )
    future_expiring = User(
        email=f"future-{uuid7().hex}@example.com",
        username=f"future_{uuid7().hex[:12]}",
        role_id=admin_role.id,
        role=admin_role,
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    integration_db.add_all((durable, future_expiring))
    integration_db.flush()

    assert active_admin_count(integration_db) == 2
    assert active_admin_count(integration_db, durable=True) == 1
    with pytest.raises(HTTPException, match="durable admin"):
        ensure_projected_admin_remains(
            integration_db,
            durable,
            destination_role=admin_role,
            destination_status=UserStatus.DISABLED.value,
        )
    assert durable.status == UserStatus.ACTIVE.value
