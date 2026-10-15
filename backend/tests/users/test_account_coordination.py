"""The administrator projection, the guest profile rules and the 409 a failed commit gives."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.systems.access.users import coordination
from app.systems.access.users.coordination import (
    ProfileValidationError,
    commit,
    ensure_projected_admin_remains,
    validate_identity_profile,
)
from app.systems.access.users.models import UserRole, UserStatus
from tests.users.user_support import local_user

NOW = datetime.now(UTC).replace(microsecond=0)
LAST_ACTIVE = "Cannot remove the last active admin"
LAST_DURABLE = "Cannot remove the last durable admin"


@pytest.fixture
def frozen_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(coordination, "utc_now", lambda: NOW)


def _admin_counts(monkeypatch: pytest.MonkeyPatch, active_count: int, durable_count: int) -> None:
    """The database state: active administrators, and those of them without an expiry."""

    def count(_db: Session, *, durable: bool = False) -> int:
        return durable_count if durable else active_count

    monkeypatch.setattr(coordination, "active_admin_count", count)


@pytest.mark.usefixtures("frozen_clock")
@pytest.mark.parametrize(
    ("role", "change", "active", "durable", "refusal"),
    [
        # A change that keeps the only administrator an active administrator.
        (UserRole.ADMIN, {"destination_role": "admin"}, 1, 1, None),
        (UserRole.ADMIN, {"destination_deleted": True}, 2, 2, None),
        (UserRole.ADMIN, {"destination_deleted": True}, 1, 1, LAST_ACTIVE),
        # Another administrator remains, but only until their expiry.
        (UserRole.ADMIN, {"destination_deleted": True}, 2, 1, LAST_DURABLE),
        (UserRole.MEMBER, {"destination_role": "admin"}, 1, 1, None),
        # A temporary administrator never takes the place of the durable one.
        (
            UserRole.MEMBER,
            {
                "destination_role": "admin",
                "destination_expires_at": NOW + timedelta(days=1),
                "expiry_requested": True,
            },
            1,
            1,
            None,
        ),
        # An expiry at the current instant already ends the administrator.
        (
            UserRole.ADMIN,
            {
                "destination_role": "admin",
                "destination_expires_at": NOW,
                "expiry_requested": True,
            },
            1,
            1,
            LAST_ACTIVE,
        ),
    ],
    ids=[
        "keeps-only-admin",
        "deletes-one-of-two",
        "deletes-only-admin",
        "deletes-only-durable-admin",
        "promotes-member",
        "promotes-temporary-admin",
        "expiry-at-now",
    ],
)
def test_some_active_and_some_durable_administrator_always_remains(
    monkeypatch: pytest.MonkeyPatch,
    role: UserRole,
    change: dict[str, object],
    active: int,
    durable: int,
    refusal: str | None,
) -> None:
    _admin_counts(monkeypatch, active, durable)
    user, membership = local_user(role)
    monkeypatch.setattr(coordination, "sole_active_membership", lambda *_: membership)
    arguments = {
        "destination_role": membership.role,
        "destination_status": UserStatus.ACTIVE.value,
        **change,
    }

    if refusal is None:
        ensure_projected_admin_remains(Mock(spec=Session), user, membership, **arguments)
        return
    with pytest.raises(HTTPException) as error:
        ensure_projected_admin_remains(Mock(spec=Session), user, membership, **arguments)
    assert error.value.status_code == 409
    # The People panel shows a 409 detail to the administrator.
    assert error.value.detail == refusal


@pytest.mark.usefixtures("frozen_clock")
@pytest.mark.parametrize(
    ("role", "sponsor", "expires_at", "message"),
    [
        (UserRole.MEMBER, "member", None, "Only guests can have a sponsor"),
        (UserRole.GUEST, None, NOW + timedelta(days=1), "Guests require an active sponsor"),
        (UserRole.GUEST, "member", None, "Guests require a future expiration"),
        (
            UserRole.GUEST,
            "member",
            (NOW + timedelta(days=1)).replace(tzinfo=None),
            "Guests require a future expiration",
        ),
        (UserRole.GUEST, "member", NOW, "Guests require a future expiration"),
        (
            UserRole.GUEST,
            "guest",
            NOW + timedelta(days=1),
            "Guest sponsor is not an active member or administrator",
        ),
    ],
    ids=["member-sponsor", "no-sponsor", "no-expiry", "naive-expiry", "expiry-at-now", "guest"],
)
def test_guest_profile_rules_refuse_with_the_shown_reason(
    role: UserRole, sponsor: str | None, expires_at: datetime | None, message: str
) -> None:
    sponsor_user, membership = (
        local_user(UserRole(sponsor)) if sponsor is not None else (None, None)
    )
    db = Mock(spec=Session)
    db.dirty = set()
    db.scalar.return_value = sponsor_user
    db.scalars.return_value.all.return_value = [membership]

    with pytest.raises(ProfileValidationError) as error:
        validate_identity_profile(
            db,
            role=role,
            sponsor_user_id=sponsor_user.id if sponsor_user is not None else None,
            expires_at=expires_at,
        )

    # The user routes answer 409 with this text, and the People panel shows it.
    assert str(error.value) == message


def test_a_constraint_failure_at_commit_is_a_409_with_the_caller_reason() -> None:
    db = Mock(spec=Session)
    db.commit.side_effect = IntegrityError("UPDATE users", {}, Exception("duplicate username"))

    with pytest.raises(HTTPException) as error:
        commit(db, "Username unavailable")

    assert (error.value.status_code, error.value.detail) == (409, "Username unavailable")
    db.rollback.assert_called_once_with()
