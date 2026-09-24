"""Validation of configured values used for new identities and invitations."""

from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.policy.service as policy_service
from app.systems.access.policy.models import AccessGroup, AccessPolicyDefaults
from app.systems.access.users.models import Role, UserRole
from app.systems.sandbox.departments.models import Department


def _defaults(**changes: object) -> AccessPolicyDefaults:
    now = datetime.now(UTC)
    values: dict[str, object] = {
        "id": uuid7(),
        "singleton_key": "workspace",
        "default_role_id": uuid7(),
        "invitation_expiry_days": 7,
        "guest_duration_days": 30,
        "service_duration_days": 90,
        "default_deny": True,
        "require_guest_sponsor": True,
        "require_service_owner": True,
        "revision": 4,
        "created_at": now,
        "updated_at": now,
        "is_deleted": False,
        "deleted_at": None,
    }
    values.update(changes)
    return AccessPolicyDefaults(**values)


def test_creation_defaults_load_and_validate_linked_values(monkeypatch: pytest.MonkeyPatch) -> None:
    defaults = _defaults()
    role = Role(
        id=defaults.default_role_id,
        role=UserRole.MEMBER.value,
        permissions={},
        is_deleted=False,
    )
    group_id, department_id = uuid7(), uuid7()
    db = Mock(spec=Session)
    db.scalar.return_value = role
    monkeypatch.setattr(policy_service, "get_defaults", lambda *_args, **_kwargs: defaults)
    monkeypatch.setattr(
        policy_service,
        "default_link_ids",
        lambda *_args: ([group_id], [department_id]),
    )
    monkeypatch.setattr(policy_service, "_active_ids", lambda _db, _model, ids: set(ids))

    loaded = policy_service.load_creation_defaults(db)

    assert loaded.role is role
    assert loaded.group_ids == (group_id,)
    assert loaded.department_ids == (department_id,)
    assert loaded.invitation_expiry_days == 7
    assert loaded.guest_duration_days == 30


@pytest.mark.parametrize(
    ("failure", "message"),
    [
        ("deleted", "Access defaults are unavailable"),
        ("role", "Default role is unavailable"),
        ("group", "Default group is unavailable"),
        ("department", "Default department is unavailable"),
        ("duration", "Default duration is invalid"),
    ],
)
def test_creation_defaults_reject_missing_or_invalid_configuration(
    failure: str, message: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    defaults = _defaults()
    if failure == "deleted":
        defaults.is_deleted = True
    if failure == "duration":
        defaults.invitation_expiry_days = 0
    group_id, department_id = uuid7(), uuid7()
    role = (
        None
        if failure == "role"
        else Role(
            id=defaults.default_role_id,
            role=UserRole.MEMBER.value,
            permissions={},
            is_deleted=False,
        )
    )
    db = Mock(spec=Session)
    db.scalar.return_value = role
    monkeypatch.setattr(policy_service, "get_defaults", lambda *_args, **_kwargs: defaults)
    monkeypatch.setattr(
        policy_service,
        "default_link_ids",
        lambda *_args: ([group_id], [department_id]),
    )

    def active_ids(_db: Session, model: type[AccessGroup] | type[Department], ids: tuple) -> set:
        if failure == "group" and model is AccessGroup:
            return set()
        if failure == "department" and model is Department:
            return set()
        return set(ids)

    monkeypatch.setattr(policy_service, "_active_ids", active_ids)
    with pytest.raises(ValueError, match=message):
        policy_service.load_creation_defaults(db)


def test_creation_defaults_translate_database_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        policy_service,
        "get_defaults",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(SQLAlchemyError("read failed")),
    )

    with pytest.raises(ValueError, match="Access defaults are unavailable"):
        policy_service.load_creation_defaults(Mock(spec=Session))


@pytest.mark.parametrize(
    ("deleted", "days", "expected"), [(False, 12, 12), (True, 12, None), (False, 0, None)]
)
def test_invitation_expiry_default_is_returned_only_when_usable(
    deleted: bool, days: int, expected: int | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    defaults = _defaults(is_deleted=deleted, invitation_expiry_days=days)
    monkeypatch.setattr(policy_service, "get_defaults", lambda *_args, **_kwargs: defaults)

    if expected is None:
        with pytest.raises(ValueError, match="Invitation expiry default is unavailable"):
            policy_service.load_invitation_expiry_days(Mock(spec=Session))
    else:
        assert policy_service.load_invitation_expiry_days(Mock(spec=Session)) == expected
