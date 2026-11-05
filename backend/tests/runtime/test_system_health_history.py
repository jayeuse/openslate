"""S5: periods, Slow and the Email word from stored samples and signals (stack-free)."""

from datetime import UTC, datetime, timedelta

import pytest

from app.systems.manage.health import service
from app.systems.manage.health.history import (
    HealthHistory,
    Period,
    Sample,
    email_word,
    health_periods,
    slow_parts,
)

T = datetime(2026, 11, 5, 10, 0, tzinfo=UTC)


def _at(minute: int) -> datetime:
    return T + timedelta(minutes=minute)


def _sample(minute: int, **changes: str | int | None) -> Sample:
    """A sample where every part works quickly unless a change says otherwise.

    ``data="not_working"`` sets a status; ``data_ms=1500`` sets a check time.
    """

    statuses = {"data": "working", "signing_in": "working", "files": "working",
                "email": "set_up"}
    times = {"data": 20, "signing_in": 30, "files": 40}
    for name, value in changes.items():
        if name.endswith("_ms"):
            times[name.removesuffix("_ms")] = value
        else:
            statuses[name] = value
    return Sample(sampled_at=_at(minute), statuses=statuses, times=times)


def _run(minutes, **changes) -> list[Sample]:
    return [_sample(minute, **changes) for minute in minutes]


def _working(minutes) -> list[Sample]:
    return [_sample(minute) for minute in minutes]


@pytest.mark.parametrize(
    ("samples", "now", "expected"),
    [
        pytest.param(_working(range(0, 30)), _at(30), [], id="no_problem"),
        pytest.param(
            _working([0]) + _run(range(1, 13), email="not_working") + _working(range(13, 30)),
            _at(30),
            [Period("email", "not_working", _at(1), _at(13))],
            id="ended_run_ends_one_minute_after_its_last_bad_sample",
        ),
        pytest.param(
            _run([0, 2], data="not_working") + _working([3, 4]),
            _at(5),
            [Period("data", "not_working", _at(0), _at(3))],
            id="a_missing_minute_inside_a_run_keeps_one_period",
        ),
        pytest.param(
            _run([0], data="not_working") + _run([3], data="not_working") + _working([4]),
            _at(5),
            [
                Period("data", "not_working", _at(3), _at(4)),
                Period("data", "not_working", _at(0), _at(1)),
            ],
            id="a_gap_over_two_minutes_splits_the_run",
        ),
        pytest.param(
            _run([0], files="not_working") + _working([1]) + _run([2], files="not_working")
            + _working([3]),
            _at(4),
            [
                Period("files", "not_working", _at(2), _at(3)),
                Period("files", "not_working", _at(0), _at(1)),
            ],
            id="a_working_sample_between_ends_the_run",
        ),
        pytest.param(
            _working(range(0, 27)) + _run(range(27, 30), signing_in="not_working"),
            _at(32),
            [Period("signing_in", "not_working", _at(27), None)],
            id="a_run_reaching_a_newest_sample_three_minutes_old_is_still_going",
        ),
        pytest.param(
            _working(range(0, 27)) + _run(range(27, 30), signing_in="not_working"),
            _at(32) + timedelta(seconds=1),
            [Period("signing_in", "not_working", _at(27), _at(30))],
            id="a_newest_sample_over_three_minutes_old_ends_the_run",
        ),
        pytest.param(
            _working([0]) + _run([1, 2, 3], data_ms=1001) + _working([4]),
            _at(5),
            [Period("data", "slow", _at(1), _at(4))],
            id="three_slow_samples_make_a_slow_period",
        ),
        pytest.param(
            _working([0]) + _run([1, 2], data_ms=1500) + _working([3])
            + _run([4, 5, 6], data_ms=1000) + _working([7]),
            _at(8),
            [],
            id="two_slow_samples_or_exactly_one_second_are_not_slow",
        ),
        pytest.param(
            _run([0, 1, 2], data="not_working", data_ms=1900) + _working([3]),
            _at(4),
            [Period("data", "not_working", _at(0), _at(3))],
            id="a_slow_check_that_fails_is_not_working_only",
        ),
        pytest.param(
            # Ended at 10:19 (data, files) and 10:09 (email); going since 10:25 and 10:26.
            _run(range(0, 9), email="not_working")
            + _run(range(15, 19), files="not_working", data="not_working")
            + _run([25], signing_in="not_working")
            + _run([26, 27, 28], signing_in="not_working", files_ms=1200),
            _at(29),
            [
                Period("files", "slow", _at(26), None),
                Period("signing_in", "not_working", _at(25), None),
                Period("data", "not_working", _at(15), _at(19)),
                Period("files", "not_working", _at(15), _at(19)),
                Period("email", "not_working", _at(0), _at(9)),
            ],
            id="going_periods_first_then_ended_newest_first_in_part_order",
        ),
    ],
)
def test_s5_c3_i5_periods_from_samples(samples, now, expected):
    assert health_periods(samples, now) == expected


@pytest.mark.parametrize(
    ("samples", "now", "slow"),
    [
        pytest.param(_working([0]) + _run([1, 2, 3], signing_in_ms=1001), _at(4), {"signing_in"},
                     id="newest_three_over_one_second"),
        pytest.param(_run([1, 2], files_ms=1001) + _run([3], files_ms=1000), _at(4), set(),
                     id="one_at_exactly_one_second"),
        pytest.param(_run([2, 3], data_ms=4000), _at(4), set(), id="only_two_samples"),
        pytest.param(_run([0, 1, 2], data_ms=4000), _at(4) + timedelta(seconds=1), set(),
                     id="oldest_of_the_three_over_four_minutes_ago"),
        pytest.param(_run([1, 2], data_ms=4000) + _run([3], data="not_working", data_ms=4000),
                     _at(4), set(), id="one_not_working"),
        pytest.param(_run([1, 2, 3], data_ms=1500, files_ms=2500), _at(4), {"data", "files"},
                     id="two_parts"),
    ],
)
def test_s5_c4_i7_slow_needs_the_newest_three_samples_over_one_second(samples, now, slow):
    assert slow_parts(samples, now) == frozenset(slow)


def _snapshot(**statuses: str) -> dict:
    components = {name: {"status": "ready", "required": True}
                  for name in ("database", "auth", "storage", "smtp")}
    for name, value in statuses.items():
        components[name]["status"] = value
    return {"status": "ready", "components": components}


def test_s5_c4_i7_slow_shows_only_on_a_working_part_and_never_on_email():
    history = HealthHistory(
        periods=(), slow=frozenset({"data", "signing_in"}), oldest_sample_at=_at(0),
        email_accepted_at=None, email_failed_at=None,
    )

    parts = service.system_parts(_snapshot(auth="unavailable"), history, now=_at(5))

    assert [(part.key, part.status) for part in parts] == [
        ("data", "slow"),
        ("signing_in", "not_working"),
        ("files", "working"),
        ("email", "set_up"),
    ]


@pytest.mark.parametrize(
    ("smtp", "accepted", "failed", "word"),
    [
        ("not_configured", 1, None, "not_set_up"),
        (None, 1, None, "not_working"),
        ("unavailable", 1, None, "not_working"),
        ("ready", None, None, "set_up"),
        ("ready", 1, None, "working"),
        ("ready", 25, None, "set_up"),
        ("ready", 2, 1, "not_working"),
        ("ready", 1, 2, "working"),
        ("ready", None, 1, "not_working"),
        ("ready", None, 25, "set_up"),
        ("ready", 30, 25, "set_up"),
    ],
)
def test_s5_c5_i9_email_word_follows_recent_send_outcomes(smtp, accepted, failed, word):
    """Hours ago of the last accepted and the last failed send; 24 hours is recent."""

    now = _at(0)

    def hours_ago(value):
        return None if value is None else now - timedelta(hours=value)

    assert email_word(smtp, hours_ago(accepted), hours_ago(failed), now) == word


def test_s5_c5_i9_the_status_email_part_reads_working_only_after_an_accepted_send():
    accepted = HealthHistory(
        periods=(), slow=frozenset(), oldest_sample_at=None,
        email_accepted_at=_at(-30), email_failed_at=None,
    )

    with_send = service.system_parts(_snapshot(), accepted, now=_at(0))
    without_history = service.system_parts(_snapshot())

    assert with_send[3].status == "working"
    assert without_history[3].status == "set_up"
