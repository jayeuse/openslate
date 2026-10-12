"""Pure Board event occurrence expansion contracts."""

import os
import time
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta, timezone
from itertools import product
from typing import Any, cast
from uuid import UUID

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_occurrences import expand_board_event_occurrences
from tests.property_support import PROPERTY

_DEFAULT_EVENT_ID = UUID(int=1)


def _event(
    *,
    event_id: UUID = _DEFAULT_EVENT_ID,
    all_day: bool = True,
    start_date: date | None = date(2026, 9, 14),
    end_date: date | None = date(2026, 9, 14),
    start_at: datetime | None = None,
    end_at: datetime | None = None,
    timezone_name: str = "UTC",
    recurrence: str = "none",
    repeat_until: date | None = None,
) -> BoardEvent:
    return BoardEvent(
        id=event_id,
        board_id=UUID(int=2),
        author_id=UUID(int=3),
        title="Planning",
        details="",
        location="",
        all_day=all_day,
        start_date=start_date,
        end_date=end_date,
        start_at=start_at,
        end_at=end_at,
        timezone_name=timezone_name,
        recurrence=recurrence,
        repeat_until=repeat_until,
    )


def _timed_event(
    start: str,
    end: str,
    *,
    timezone_name: str,
    recurrence: str = "none",
    repeat_until: date | None = None,
) -> BoardEvent:
    return _event(
        all_day=False,
        start_date=None,
        end_date=None,
        start_at=datetime.fromisoformat(start.replace("Z", "+00:00")),
        end_at=datetime.fromisoformat(end.replace("Z", "+00:00")),
        timezone_name=timezone_name,
        recurrence=recurrence,
        repeat_until=repeat_until,
    )


def test_all_day_spans_overlap_an_inclusive_window_with_stable_occurrence_id() -> None:
    event = _event(start_date=date(2026, 9, 14), end_date=date(2026, 9, 16))

    first = expand_board_event_occurrences(event, date(2026, 9, 15), date(2026, 9, 15))
    second = expand_board_event_occurrences(event, date(2026, 9, 15), date(2026, 9, 15))

    assert first == second
    assert len(first.occurrences) == 1
    occurrence = first.occurrences[0]
    assert occurrence.id == f"{event.id}:2026-09-14"
    assert occurrence.event_id == str(event.id)
    assert occurrence.start == "2026-09-14"
    assert occurrence.end == "2026-09-16"
    assert occurrence.date == "2026-09-14"
    assert first.truncated is False


def test_daily_weekly_and_monthly_recurrences_are_anchored_and_repeat_until_is_inclusive() -> None:
    daily = _event(
        recurrence="daily",
        repeat_until=date(2026, 9, 16),
    )
    weekly = _event(
        event_id=UUID(int=4),
        recurrence="weekly",
        repeat_until=date(2026, 9, 28),
    )
    monthly = _event(
        event_id=UUID(int=5),
        start_date=date(2026, 1, 31),
        end_date=date(2026, 1, 31),
        recurrence="monthly",
        repeat_until=date(2026, 4, 30),
    )

    daily_result = expand_board_event_occurrences(daily, date(2026, 9, 14), date(2026, 9, 17))
    weekly_result = expand_board_event_occurrences(weekly, date(2026, 9, 14), date(2026, 9, 28))
    monthly_result = expand_board_event_occurrences(monthly, date(2026, 1, 1), date(2026, 4, 30))
    # A window that starts after the anchor and skips the short February.
    monthly_window = expand_board_event_occurrences(monthly, date(2026, 2, 25), date(2026, 4, 5))

    assert [item.date for item in daily_result.occurrences] == [
        "2026-09-14",
        "2026-09-15",
        "2026-09-16",
    ]
    assert [item.id for item in daily_result.occurrences] == [
        f"{daily.id}:2026-09-14",
        f"{daily.id}:2026-09-15",
        f"{daily.id}:2026-09-16",
    ]
    assert [item.date for item in weekly_result.occurrences] == [
        "2026-09-14",
        "2026-09-21",
        "2026-09-28",
    ]
    assert [item.date for item in monthly_result.occurrences] == [
        "2026-01-31",
        "2026-03-31",
    ]
    assert [item.date for item in monthly_window.occurrences] == ["2026-03-31"]


def test_recurring_spans_include_earlier_anchor_days_that_overlap_the_window() -> None:
    all_day = _event(
        start_date=date(2026, 9, 14),
        end_date=date(2026, 9, 16),
        recurrence="daily",
        repeat_until=date(2026, 9, 17),
    )
    timed = _timed_event(
        "2026-09-14T00:00:00Z",
        "2026-09-16T00:00:00Z",
        timezone_name="UTC",
        recurrence="daily",
        repeat_until=date(2026, 9, 16),
    )

    # A 48-hour span that starts at 01:00: the 2026-09-14 occurrence still runs into the
    # window, although the window start minus the duration is 2026-09-14 00:00.
    late_timed = _timed_event(
        "2026-09-14T01:00:00Z",
        "2026-09-16T01:00:00Z",
        timezone_name="UTC",
        recurrence="daily",
        repeat_until=date(2026, 9, 16),
    )

    all_day_result = expand_board_event_occurrences(all_day, date(2026, 9, 15), date(2026, 9, 15))
    timed_result = expand_board_event_occurrences(timed, date(2026, 9, 16), date(2026, 9, 16))
    late_result = expand_board_event_occurrences(late_timed, date(2026, 9, 16), date(2026, 9, 16))

    assert [(item.date, item.end) for item in all_day_result.occurrences] == [
        ("2026-09-14", "2026-09-16"),
        ("2026-09-15", "2026-09-17"),
    ]
    assert [item.date for item in timed_result.occurrences] == [
        "2026-09-15",
        "2026-09-16",
    ]
    assert [item.start for item in late_result.occurrences] == [
        "2026-09-14T01:00:00Z",
        "2026-09-15T01:00:00Z",
        "2026-09-16T01:00:00Z",
    ]


def test_timed_recurrence_uses_compatible_dst_offsets_and_fixed_elapsed_duration() -> None:
    spring = _timed_event(
        "2026-03-07T07:30:00Z",
        "2026-03-07T08:30:00Z",
        timezone_name="America/New_York",
        recurrence="daily",
        repeat_until=date(2026, 3, 9),
    )
    fall = _timed_event(
        "2026-10-31T05:30:00Z",
        "2026-10-31T06:30:00Z",
        timezone_name="America/New_York",
        recurrence="daily",
        repeat_until=date(2026, 11, 2),
    )

    spring_result = expand_board_event_occurrences(spring, date(2026, 3, 7), date(2026, 3, 9))
    fall_result = expand_board_event_occurrences(fall, date(2026, 10, 31), date(2026, 11, 2))

    assert [item.start for item in spring_result.occurrences] == [
        "2026-03-07T07:30:00Z",
        "2026-03-08T07:30:00Z",
        "2026-03-09T06:30:00Z",
    ]
    assert [item.start for item in fall_result.occurrences] == [
        "2026-10-31T05:30:00Z",
        "2026-11-01T05:30:00Z",
        "2026-11-02T06:30:00Z",
    ]
    # A recurring timed occurrence keeps its local-date key when its UTC offset moves.
    assert [item.id for item in spring_result.occurrences] == [
        f"{spring.id}:2026-03-07",
        f"{spring.id}:2026-03-08",
        f"{spring.id}:2026-03-09",
    ]
    assert {item.event_id for item in spring_result.occurrences} == {str(spring.id)}
    for occurrence in (*spring_result.occurrences, *fall_result.occurrences):
        start = datetime.fromisoformat(occurrence.start.replace("Z", "+00:00"))
        end = datetime.fromisoformat(occurrence.end.replace("Z", "+00:00"))
        assert end - start == timedelta(hours=1)


def test_range_is_bounded_and_result_cap_reports_only_omitted_matches() -> None:
    daily = _event(
        recurrence="daily",
        repeat_until=date(2027, 9, 14),
    )
    window_start = date(2026, 9, 14)
    window_366_days = window_start + timedelta(days=365)
    window_367_days = window_start + timedelta(days=366)

    exactly_100 = expand_board_event_occurrences(
        daily,
        window_start,
        window_start + timedelta(days=99),
        requested_limit=500,
    )
    capped = expand_board_event_occurrences(
        daily,
        window_start,
        window_start + timedelta(days=100),
    )
    maximum_window = expand_board_event_occurrences(daily, window_start, window_366_days)
    oversized_window = expand_board_event_occurrences(daily, window_start, window_367_days)

    assert len(exactly_100.occurrences) == 100
    assert exactly_100.truncated is False
    assert len(capped.occurrences) == 100
    assert capped.truncated is True
    assert len(maximum_window.occurrences) == 100
    assert maximum_window.truncated is True
    assert oversized_window.occurrences == ()
    assert oversized_window.truncated is False


def test_nonrecurring_timed_event_overlaps_window_and_is_normalized_to_utc() -> None:
    event = _timed_event(
        "2026-09-14T23:00:00Z",
        "2026-09-15T01:00:00Z",
        timezone_name="Asia/Manila",
    )

    result = expand_board_event_occurrences(event, date(2026, 9, 15), date(2026, 9, 15))

    assert len(result.occurrences) == 1
    occurrence = result.occurrences[0]
    assert occurrence.id == f"{event.id}:2026-09-14T23:00:00Z"
    assert occurrence.start == "2026-09-14T23:00:00Z"
    assert occurrence.end == "2026-09-15T01:00:00Z"
    assert occurrence.date == "2026-09-15"


def test_corrupt_persisted_temporal_rows_fail_closed() -> None:
    valid_start = datetime(2026, 9, 14, 9, tzinfo=UTC)
    invalid_rows = [
        _event(timezone_name="Not/A_Zone"),
        _event(
            all_day=False,
            start_date=None,
            end_date=None,
            start_at=datetime(2026, 9, 14, 9),
            end_at=datetime(2026, 9, 14, 10, tzinfo=UTC),
        ),
        _event(
            all_day=False,
            start_date=None,
            end_date=None,
            start_at=valid_start.replace(tzinfo=timezone(timedelta(hours=1))),
            end_at=datetime(2026, 9, 14, 10, tzinfo=UTC),
        ),
        _event(start_date=datetime(2026, 9, 14)),
        _event(end_date=date(2026, 9, 13)),
        _event(
            all_day=True,
            start_date=None,
            end_date=None,
            start_at=valid_start,
            end_at=datetime(2026, 9, 14, 10, tzinfo=UTC),
        ),
        _event(recurrence="yearly", repeat_until=date(2027, 9, 14)),
        _event(recurrence="daily", repeat_until=None),
        _event(recurrence="none", repeat_until=date(2026, 9, 14)),
        _event(recurrence="weekly", repeat_until=date(2026, 9, 13)),
        _timed_event(
            "2026-09-14T10:00:00Z",
            "2026-09-14T10:00:00Z",
            timezone_name="UTC",
        ),
        _event(event_id=cast(Any, "not-a-uuid")),
        _event(all_day=True, start_at=valid_start),
        _event(end_date=None),
        _event(
            all_day=False,
            start_date=None,
            end_date=None,
            start_at=None,
            end_at=datetime(2026, 9, 14, 10, tzinfo=UTC),
        ),
        _event(
            all_day=False,
            end_date=None,
            start_at=valid_start,
            end_at=datetime(2026, 9, 14, 10, tzinfo=UTC),
        ),
    ]
    # The second window also holds the day before the row, which a reversed span reaches.
    windows = [
        (date(2026, 9, 14), date(2026, 9, 14)),
        (date(2026, 9, 1), date(2026, 9, 30)),
    ]

    for row, window in product(invalid_rows, windows):
        result = expand_board_event_occurrences(row, *window)
        assert result.occurrences == ()
        assert result.truncated is False


@pytest.mark.parametrize(
    ("event", "window_start", "window_end"),
    [
        pytest.param(
            _event(recurrence="daily", repeat_until=date(2026, 9, 20)),
            datetime(2026, 9, 14, 0, 0),
            date(2026, 9, 16),
            id="window-start-is-a-datetime",
        ),
        pytest.param(
            _event(recurrence="daily", repeat_until=date(2026, 9, 20)),
            datetime(2026, 9, 14, 0, 0),
            datetime(2026, 9, 16, 0, 0),
            id="both-window-ends-are-datetimes",
        ),
        # Midnight on 0001-01-01 in Tokyo (local mean time, UTC+9:19) is before the first
        # UTC instant Python has.
        pytest.param(
            _timed_event(
                "2026-09-14T10:00:00Z", "2026-09-14T11:00:00Z", timezone_name="Asia/Tokyo"
            ),
            date(1, 1, 1),
            date(1, 1, 2),
            id="window-start-has-no-utc-instant",
        ),
    ],
)
def test_windows_that_are_not_representable_calendar_dates_fail_closed(
    event: BoardEvent, window_start: date, window_end: date
) -> None:
    result = expand_board_event_occurrences(event, window_start, window_end)

    assert result.occurrences == ()
    assert result.truncated is False


def test_repeat_until_is_inclusive_on_the_anchor_day_and_a_later_window_is_empty() -> None:
    all_day = _event(recurrence="daily", repeat_until=date(2026, 9, 14))
    timed = _timed_event(
        "2026-09-14T09:00:00Z",
        "2026-09-14T10:00:00Z",
        timezone_name="UTC",
        recurrence="weekly",
        repeat_until=date(2026, 9, 14),
    )
    ended = _event(recurrence="daily", repeat_until=date(2026, 9, 16))

    all_day_result = expand_board_event_occurrences(all_day, date(2026, 9, 14), date(2026, 9, 14))
    timed_result = expand_board_event_occurrences(timed, date(2026, 9, 14), date(2026, 9, 14))
    ended_result = expand_board_event_occurrences(ended, date(2026, 9, 20), date(2026, 9, 21))

    assert [item.date for item in all_day_result.occurrences] == ["2026-09-14"]
    assert [item.start for item in timed_result.occurrences] == ["2026-09-14T09:00:00Z"]
    assert ended_result.occurrences == ()
    assert ended_result.truncated is False


def test_single_events_outside_the_window_are_left_out_and_its_last_day_is_inclusive() -> None:
    all_day_before = _event(start_date=date(2026, 9, 14), end_date=date(2026, 9, 14))
    # 2026-09-16T04:00:00Z is midnight at the start of 2026-09-16 in New York (EDT).
    timed_at_next_midnight = _timed_event(
        "2026-09-16T04:00:00Z",
        "2026-09-16T05:00:00Z",
        timezone_name="America/New_York",
    )
    timed_on_last_date = _timed_event(
        "9999-12-31T10:00:00Z",
        "9999-12-31T11:00:00Z",
        timezone_name="UTC",
    )

    before = expand_board_event_occurrences(all_day_before, date(2026, 9, 15), date(2026, 9, 15))
    next_midnight = expand_board_event_occurrences(
        timed_at_next_midnight, date(2026, 9, 15), date(2026, 9, 15)
    )
    last_date = expand_board_event_occurrences(
        timed_on_last_date, date(9999, 12, 31), date(9999, 12, 31)
    )

    assert before.occurrences == ()
    assert next_midnight.occurrences == ()
    assert [(item.start, item.end) for item in last_date.occurrences] == [
        ("9999-12-31T10:00:00Z", "9999-12-31T11:00:00Z")
    ]


@pytest.fixture
def host_zone_ahead_of_utc() -> Iterator[None]:
    """Run the server process in UTC+14, far from every event zone in the test."""

    previous = os.environ.get("TZ")
    os.environ["TZ"] = "Pacific/Kiritimati"
    time.tzset()
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous
        time.tzset()


@pytest.mark.usefixtures("host_zone_ahead_of_utc")
def test_event_zone_not_the_server_zone_sets_dates_and_window_bounds() -> None:
    # 19:00 on 2026-09-14 in Honolulu (UTC-10); already 2026-09-15 in UTC and on the host.
    single = _timed_event(
        "2026-09-15T05:00:00Z",
        "2026-09-15T06:00:00Z",
        timezone_name="Pacific/Honolulu",
    )
    # Daily at 23:45 in Pago Pago (UTC-11) for 24 h 30 min: the 2026-09-14 occurrence
    # ends at 00:15 on 2026-09-16 local time, inside the window.
    late = _timed_event(
        "2026-09-14T10:45:00Z",
        "2026-09-15T11:15:00Z",
        timezone_name="Pacific/Pago_Pago",
        recurrence="daily",
        repeat_until=date(2026, 9, 20),
    )

    # 12:00 UTC on the last date is already past 9999 on the host clock.
    last_noon = _timed_event(
        "9999-12-31T12:00:00Z",
        "9999-12-31T13:00:00Z",
        timezone_name="UTC",
        recurrence="daily",
        repeat_until=date(9999, 12, 31),
    )

    single_result = expand_board_event_occurrences(single, date(2026, 9, 14), date(2026, 9, 14))
    late_result = expand_board_event_occurrences(late, date(2026, 9, 16), date(2026, 9, 16))
    last_result = expand_board_event_occurrences(last_noon, date(9999, 12, 31), date(9999, 12, 31))

    assert [item.date for item in single_result.occurrences] == ["2026-09-14"]
    assert [(item.date, item.start) for item in late_result.occurrences] == [
        ("2026-09-14", "2026-09-15T10:45:00Z"),
        ("2026-09-15", "2026-09-16T10:45:00Z"),
        ("2026-09-16", "2026-09-17T10:45:00Z"),
    ]
    assert [item.start for item in last_result.occurrences] == ["9999-12-31T12:00:00Z"]


def test_monthly_timed_recurrence_keeps_local_time_across_dst_and_stops_at_the_limit() -> None:
    # 09:00 in New York: EST in January, EDT from 2026-03-08.
    monthly = _timed_event(
        "2026-01-15T14:00:00Z",
        "2026-01-15T15:00:00Z",
        timezone_name="America/New_York",
        recurrence="monthly",
        repeat_until=date(2026, 4, 30),
    )

    spring = expand_board_event_occurrences(monthly, date(2026, 3, 1), date(2026, 4, 30))
    capped = expand_board_event_occurrences(
        monthly, date(2026, 1, 1), date(2026, 4, 30), requested_limit=1
    )

    assert [(item.id, item.start) for item in spring.occurrences] == [
        (f"{monthly.id}:2026-03-15", "2026-03-15T13:00:00Z"),
        (f"{monthly.id}:2026-04-15", "2026-04-15T13:00:00Z"),
    ]
    assert [item.start for item in capped.occurrences] == ["2026-01-15T14:00:00Z"]
    assert capped.truncated is True


@pytest.mark.parametrize(
    ("anchor", "repeat_until", "window_start", "window_end", "expected"),
    [
        pytest.param(
            date(2026, 11, 1),
            date(2027, 3, 31),
            date(2026, 12, 1),
            date(2026, 12, 1),
            ["2026-12-01"],
            id="one-day-window-on-the-first",
        ),
        pytest.param(
            date(2026, 11, 1),
            date(2027, 3, 31),
            date(2026, 11, 15),
            date(2026, 12, 1),
            ["2026-12-01"],
            id="window-ends-on-the-first-of-the-next-month",
        ),
        pytest.param(
            date(2026, 11, 1),
            date(2027, 3, 31),
            date(2026, 11, 1),
            date(2027, 1, 1),
            ["2026-11-01", "2026-12-01", "2027-01-01"],
            id="window-crosses-the-new-year",
        ),
        pytest.param(
            date(9999, 11, 10),
            date(9999, 12, 31),
            date(9999, 11, 1),
            date(9999, 12, 31),
            ["9999-11-10", "9999-12-10"],
            id="last-representable-december",
        ),
    ],
)
def test_monthly_recurrence_walks_calendar_months_to_inclusive_window_edges(
    anchor: date, repeat_until: date, window_start: date, window_end: date, expected: list[str]
) -> None:
    event = _event(
        start_date=anchor, end_date=anchor, recurrence="monthly", repeat_until=repeat_until
    )

    result = expand_board_event_occurrences(event, window_start, window_end)

    assert [item.date for item in result.occurrences] == expected


def test_weekly_recurrence_keeps_its_weekday_far_from_the_anchor_and_at_the_last_date() -> None:
    monday = _event(
        start_date=date(2026, 1, 5),
        end_date=date(2026, 1, 5),
        recurrence="weekly",
        repeat_until=date(2026, 12, 31),
    )
    # The next weekly date after 9999-12-27 would be 10000-01-03, which does not exist.
    last_week = _event(
        start_date=date(9999, 12, 20),
        end_date=date(9999, 12, 20),
        recurrence="weekly",
        repeat_until=date(9999, 12, 31),
    )

    far = expand_board_event_occurrences(monday, date(2026, 3, 2), date(2026, 3, 15))
    beyond = expand_board_event_occurrences(last_week, date(9999, 12, 28), date(9999, 12, 31))

    assert [item.date for item in far.occurrences] == ["2026-03-02", "2026-03-09"]
    assert beyond.occurrences == ()
    assert beyond.truncated is False


@pytest.mark.parametrize(
    ("requested_limit", "count", "truncated"),
    [
        pytest.param(5, 5, True, id="below-the-maximum"),
        pytest.param(0, 1, True, id="raised-to-one"),
        # A bool is not a count, so the default maximum applies to the 31-day window.
        pytest.param(True, 31, False, id="not-an-int"),
    ],
)
def test_requested_limit_is_kept_between_one_and_the_maximum(
    requested_limit: int, count: int, truncated: bool
) -> None:
    daily = _event(recurrence="daily", repeat_until=date(2027, 9, 14))

    result = expand_board_event_occurrences(
        daily, date(2026, 9, 14), date(2026, 10, 14), requested_limit=requested_limit
    )

    assert len(result.occurrences) == count
    assert result.truncated is truncated


@PROPERTY
@given(
    weekly=st.booleans(),
    anchor_offset=st.integers(min_value=0, max_value=400),
    window_days=st.integers(min_value=1, max_value=60),
    until_offset=st.integers(min_value=0, max_value=500),
)
def test_daily_and_weekly_dates_are_whole_steps_from_the_anchor_with_no_gaps(
    weekly: bool, anchor_offset: int, window_days: int, until_offset: int
) -> None:
    step = 7 if weekly else 1
    anchor = date(2026, 1, 1)
    window_start = anchor + timedelta(days=anchor_offset)
    window_end = window_start + timedelta(days=window_days - 1)
    repeat_until = anchor + timedelta(days=until_offset)
    event = _event(
        start_date=anchor,
        end_date=anchor,
        recurrence="weekly" if weekly else "daily",
        repeat_until=repeat_until,
    )

    dates = [
        date.fromisoformat(item.date)
        for item in expand_board_event_occurrences(event, window_start, window_end).occurrences
    ]

    last_allowed = min(window_end, repeat_until)
    assert all(window_start <= day <= last_allowed for day in dates)
    assert all((day - anchor).days % step == 0 for day in dates)
    assert all(
        (later - earlier).days == step for earlier, later in zip(dates, dates[1:], strict=False)
    )
    if dates:
        assert (dates[0] - window_start).days < step
        assert (last_allowed - dates[-1]).days < step
    else:
        assert window_start > last_allowed or (last_allowed - window_start).days + 1 < step
