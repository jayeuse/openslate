"""The realism helpers meet the exit-criteria shapes on their own draws (spec R1-R6)."""

import random
from collections import Counter
from datetime import date, timedelta

import pytest

from app.systems.sandbox.designs.field_validation import _valid_email, _valid_http_url
from operations.sample.realism import (
    FILLER_NOTES,
    AmountShape,
    DateCluster,
    DateShape,
    dirty_text,
    email_variant,
    entry_time,
    filler_note,
    long_tail_amount,
    pareto_weights,
    phone_variant,
    url_variant,
    weighted_label,
)
from operations.sample.verification.realism import is_round

DRAWS = 10_000
YEAR = DateShape(
    start=date(2025, 10, 1),
    end=date(2026, 9, 30),
    holidays=frozenset({date(2025, 12, 25), date(2026, 1, 1), date(2026, 6, 12)}),
)


def _rng(name: str) -> random.Random:
    return random.Random(f"42:test:{name}")


def test_weighted_labels_follow_the_pack_weights_and_repeat_for_one_seed() -> None:
    weights = {"Paid": 68, "Issued": 14, "Overdue": 9, "Partially paid": 6, "Disputed": 3}
    rng = _rng("labels")
    counts = Counter(weighted_label(rng, weights) for _ in range(DRAWS))

    assert counts.most_common(1)[0][0] == "Paid"
    assert 0.64 <= counts["Paid"] / DRAWS <= 0.72
    assert len(set(counts.values())) == len(counts)
    assert [weighted_label(_rng("x"), weights) for _ in range(3)] == [
        weighted_label(_rng("x"), weights) for _ in range(3)
    ]


def test_amounts_have_a_long_tail_and_round_numbers() -> None:
    rng = _rng("amounts")
    values = sorted(long_tail_amount(rng, AmountShape(median=4_200)) for _ in range(DRAWS))

    assert values[int(0.99 * DRAWS)] / values[DRAWS // 2] >= 5
    assert sum(map(is_round, values)) / DRAWS >= 0.05


def test_amounts_keep_the_field_minimum_maximum_and_step() -> None:
    rng = _rng("bounded")
    shape = AmountShape(median=300, minimum=25, maximum=2_000, step=25, cents_share=0.5)
    values = [long_tail_amount(rng, shape) for _ in range(DRAWS)]

    assert all(25 <= value <= 2_000 and value % 25 == 0 for value in values)


def test_dates_fall_on_working_days_and_never_on_holidays() -> None:
    cluster = DateCluster(YEAR)
    rng = _rng("dates")
    days = [cluster.pick(rng) for _ in range(DRAWS)]
    by_weekday = Counter(day.weekday() for day in days)

    assert sum(day.weekday() < 5 for day in days) / DRAWS >= 0.85
    assert not set(days) & YEAR.holidays
    assert by_weekday[0] > by_weekday[2]  # Mondays are denser than Wednesdays.
    assert all(YEAR.start <= day <= YEAR.end for day in days)


def test_seasons_and_go_live_shift_where_dates_fall() -> None:
    shape = DateShape(YEAR.start, YEAR.end, seasons={6: 3.0, 12: 0.3}, go_live_share=0.1)
    rng = _rng("seasons")
    days = [DateCluster(shape).pick(rng) for _ in range(DRAWS)]
    by_month = Counter(day.month for day in days)
    first_week = sum(day < YEAR.start + timedelta(days=7) for day in days)

    assert by_month[6] > 2 * by_month[5] and by_month[12] < by_month[11]
    assert first_week / DRAWS >= 0.1


def test_entry_times_cluster_in_working_peaks_with_a_few_late_ones() -> None:
    rng = _rng("times")
    hours = Counter(entry_time(rng).hour for _ in range(DRAWS))
    peaks = sum(hours[hour] for hour in (9, 10, 14, 15)) / DRAWS

    assert peaks >= 0.8
    assert 0 < sum(hours[hour] for hour in (21, 22)) / DRAWS <= 0.05


@pytest.mark.parametrize("size", [3, 5, 8, 12, 20])
def test_one_or_two_people_write_most_of_a_department(size: int) -> None:
    team = [f"person_{n}" for n in range(size)]
    rng = _rng(f"pareto:{size}")
    weights = pareto_weights(rng, team)
    writes = Counter(rng.choices(team, weights=weights, k=DRAWS))

    assert sum(count for _, count in writes.most_common(2)) / DRAWS >= 0.4
    assert sorted(weights, reverse=True)[0] > sorted(weights, reverse=True)[-1]


def test_dirty_emails_and_urls_still_pass_the_server_checks() -> None:
    rng = _rng("dirt")
    emails = {email_variant(rng, "ana.cruz@harbor-ops.example") for _ in range(200)}
    urls = {url_variant(rng, "https://portal.harbor-ops.example/orders") for _ in range(200)}

    assert len(emails) > 3 and all(map(_valid_email, emails))
    assert len(urls) > 1 and all(map(_valid_http_url, urls))


def test_text_dirt_changes_the_value_the_way_people_type_it() -> None:
    rng = _rng("text")
    name = "Acme Cold Storage Corporation"
    variants = {dirty_text(rng, name) for _ in range(200)}

    assert "Acme Cold Storage Corp." in variants
    assert name.upper() in variants
    assert any("  " in value for value in variants) and name + " " in variants
    assert filler_note(rng) in FILLER_NOTES


def test_phone_variants_keep_the_same_number_in_different_formats() -> None:
    rng = _rng("phone")
    variants = {phone_variant(rng, "9171234567", "44") for _ in range(200)}

    assert len(variants) == 5
    assert all(
        "".join(ch for ch in value if ch.isdigit()).endswith("1234567") for value in variants
    )
