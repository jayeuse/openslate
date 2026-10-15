"""Which local profiles count as accepted accounts, and which can act at a given time."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest

from app.systems.access.users.eligibility import is_active_account, is_established_user
from app.systems.access.users.models import UserRole, UserStatus
from tests.users.user_support import local_user

SENT = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("status", "sent", "accepted", "established"),
    [
        # A profile from before invitations existed stays an account.
        (UserStatus.ACTIVE, None, None, True),
        # A sent invitation counts only after it is accepted.
        (UserStatus.ACTIVE, SENT, None, False),
        (UserStatus.DISABLED, SENT, None, False),
        (UserStatus.ACTIVE, SENT, SENT + timedelta(hours=1), True),
        # A pending profile is never an account, even with an acceptance time.
        (UserStatus.PENDING, SENT, SENT + timedelta(hours=1), False),
    ],
)
def test_only_an_accepted_or_legacy_profile_is_established(
    status: UserStatus, sent: datetime | None, accepted: datetime | None, established: bool
) -> None:
    _user, membership = local_user(status=status)
    membership.invitation_sent_at = sent
    membership.invitation_accepted_at = accepted

    assert is_established_user(membership) is established


def test_the_caller_clock_decides_account_expiry() -> None:
    # Access checks pass one frozen clock for a whole request; the account is judged at it.
    user, membership = local_user(UserRole.GUEST)
    membership.expires_at = datetime(2020, 1, 2, tzinfo=UTC)
    db = Mock()
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]

    assert is_active_account(db, user, now=datetime(2020, 1, 1, tzinfo=UTC)) is True
    assert is_active_account(db, user, now=datetime(2020, 1, 2, tzinfo=UTC)) is False
