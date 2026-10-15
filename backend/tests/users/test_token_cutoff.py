"""The token cutoff must not refuse a sign-in made in the same second as a revocation."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import cast

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.systems.access.users import coordination
from app.systems.access.users.coordination import advance_token_cutoff, token_cutoff
from app.systems.access.users.models import User
from tests.property_support import PROPERTY


def test_cutoff_drops_sub_second_precision() -> None:
    moment = datetime(2026, 10, 7, 13, 24, 51, 600000, tzinfo=UTC)
    assert token_cutoff(moment) == datetime(2026, 10, 7, 13, 24, 51, tzinfo=UTC)


def test_a_new_token_in_the_revocation_second_is_not_before_the_cutoff(monkeypatch) -> None:
    revoked = datetime(2026, 10, 7, 13, 24, 51, 600000, tzinfo=UTC)
    monkeypatch.setattr(coordination, "utc_now", lambda: revoked)
    user = cast(User, SimpleNamespace(tokens_valid_after=None))
    advance_token_cutoff(user)
    # A sign-in 200 ms later gets a whole-second iat of 13:24:51.
    issued_at = datetime(2026, 10, 7, 13, 24, 51, tzinfo=UTC)
    assert user.tokens_valid_after is not None
    assert not issued_at < user.tokens_valid_after
    # A token from the previous second stays refused.
    assert datetime(2026, 10, 7, 13, 24, 50, tzinfo=UTC) < user.tokens_valid_after


def test_the_cutoff_never_moves_backwards(monkeypatch) -> None:
    later = datetime(2026, 10, 7, 13, 25, 0, tzinfo=UTC)
    user = cast(User, SimpleNamespace(tokens_valid_after=later))
    monkeypatch.setattr(
        coordination, "utc_now", lambda: datetime(2026, 10, 7, 13, 24, 59, 900000, tzinfo=UTC)
    )
    advance_token_cutoff(user)
    assert user.tokens_valid_after == later


MOMENTS = st.datetimes(
    min_value=datetime(2000, 1, 1), max_value=datetime(2100, 1, 1), timezones=st.just(UTC)
)


@PROPERTY
@given(moment=MOMENTS)
def test_the_cutoff_is_the_start_of_the_same_whole_second(moment: datetime) -> None:
    cutoff = token_cutoff(moment)
    assert cutoff.microsecond == 0
    assert cutoff <= moment < cutoff + timedelta(seconds=1)
    assert token_cutoff(cutoff) == cutoff


@PROPERTY
@given(previous=st.none() | MOMENTS, revoked=MOMENTS)
def test_advancing_keeps_the_later_of_the_previous_cutoff_and_the_revocation_second(
    previous: datetime | None, revoked: datetime
) -> None:
    user = cast(User, SimpleNamespace(tokens_valid_after=previous))
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(coordination, "utc_now", lambda: revoked)
        advance_token_cutoff(user)
    assert user.tokens_valid_after is not None
    assert user.tokens_valid_after >= token_cutoff(revoked)
    assert previous is None or user.tokens_valid_after >= previous
    assert user.tokens_valid_after in {previous, token_cutoff(revoked)}
