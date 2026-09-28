"""Pure Board event occurrence expansion contracts."""

from datetime import UTC, date, datetime, timedelta, timezone
from uuid import UUID

from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_occurrences import expand_board_event_occurrences

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

    all_day_result = expand_board_event_occurrences(all_day, date(2026, 9, 15), date(2026, 9, 15))
    timed_result = expand_board_event_occurrences(timed, date(2026, 9, 16), date(2026, 9, 16))

    assert [(item.date, item.end) for item in all_day_result.occurrences] == [
        ("2026-09-14", "2026-09-16"),
        ("2026-09-15", "2026-09-17"),
    ]
    assert [item.date for item in timed_result.occurrences] == [
        "2026-09-15",
        "2026-09-16",
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
    ]

    for row in invalid_rows:
        result = expand_board_event_occurrences(row, date(2026, 9, 14), date(2026, 9, 14))
        assert result.occurrences == ()
        assert result.truncated is False
