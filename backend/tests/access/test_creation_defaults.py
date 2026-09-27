"""Creation-time application of persisted Access defaults."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.account_operations as account_operations
import app.systems.access.users.service as user_service
from app.core.integrations.supabase_auth import ProviderUser
from app.systems.access.policy.models import (
    AccessGroupMember,
)
from app.systems.access.policy.service import CreationDefaults
from app.systems.access.users.coordination import (
    InvitationError,
)
from app.systems.access.users.models import (
    IdentityKind,
    Role,
    User,
    UserDepartment,
    UserRole,
)
from app.systems.access.users.schemas import InvitationCreate, UserCreate, UserUpdate


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
    return_created_profile = False

    def lookup_user(_statement: object) -> User | None:
        nonlocal return_created_profile
        if not return_created_profile:
            return None
        return_created_profile = False
        return next(
            (
                call.args[0]
                for call in reversed(db.add.call_args_list)
                if isinstance(call.args[0], User)
            ),
            None,
        )

    def commit() -> None:
        nonlocal return_created_profile
        return_created_profile = True

    db.scalar.side_effect = lookup_user
    db.commit.side_effect = commit
    monkeypatch.setattr(user_service, "load_creation_defaults", lambda _db: defaults)
    monkeypatch.setattr(user_service, "append_security_event", Mock())
    monkeypatch.setattr(db, "flush", lambda: None)

    invited_users: dict[str, ProviderUser] = {}
    provider = Mock()

    def create_provider_user(email: str, local_user_id: UUID, operation_id: UUID) -> ProviderUser:
        user = ProviderUser(
            id=uuid7(),
            banned_until=None,
            email=email,
            app_metadata={
                "openslate_user_id": str(local_user_id),
                "openslate_invitation_operation_id": str(operation_id),
            },
        )
        invited_users[email] = user
        return user

    provider.admin_create_invitation_user.side_effect = create_provider_user
    provider.admin_send_invitation.side_effect = lambda email: invited_users[email]
    monkeypatch.setattr(user_service, "get_supabase_auth_client", lambda: provider)
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
