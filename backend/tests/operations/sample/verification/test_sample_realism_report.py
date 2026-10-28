"""The offline realism report finds clean data and accepts data that follows the rules."""

import random
from dataclasses import replace
from datetime import date

import pytest

from operations.sample.blueprint import _option_id
from operations.sample.packs.registry import get_pack, pack_keys
from operations.sample.realism import DateCluster, DateShape, weighted_label
from operations.sample.scenario import build_dataset
from operations.sample.verification.realism import is_round, realism_report

ANCHOR = date(2026, 9, 30)


def _dataset(pack: str):
    return build_dataset("standard", 42, ANCHOR, organization=get_pack(pack))


@pytest.mark.parametrize(
    "value,expected",
    [(50, True), (500, True), (1_500, True), (5_000, True), (10_000, True), (4_200, False),
     (48, False), (7, False), (5_000.5, False), (0, False)],
)  # fmt: skip
def test_round_numbers_are_the_ones_people_type(value: float, expected: bool) -> None:
    assert is_round(value) is expected


@pytest.mark.parametrize("pack", pack_keys())
@pytest.mark.parametrize(
    "criterion",
    [
        pytest.param(c, marks=pytest.mark.xfail(strict=True, reason=f"P2 applies rule C{c}"))
        for c in (1, 2, 3, 5)
    ],
)
def test_pack_plan_has_a_real_organizations_shape(pack: str, criterion: int) -> None:
    # Strict: once P2 applies the rule, this passes and the marker must come out.
    assert realism_report(_dataset(pack)).failed(criterion) == []


@pytest.mark.parametrize("pack", pack_keys())
def test_pack_workload_already_centers_on_a_few_writers(pack: str) -> None:
    assert realism_report(_dataset(pack)).failed(4) == []


def test_status_and_date_checks_accept_values_drawn_by_the_rules() -> None:
    dataset = _dataset("harbor")
    module = next(m for m in dataset.organization.catalog.modules if m.key == "quotes")
    status = next(f for f in module.fields if f.value_kind == "status")
    day_field = next(f for f in module.fields if f.type == "Date")
    ids = dataset.field_ids["quotes"]
    weights = dict(zip(module.statuses, (55, 20, 12, 8, 4, 1), strict=False))
    cluster = DateCluster(DateShape(date(2025, 10, 1), ANCHOR))
    rng = random.Random("42:report")
    label_id = {
        label: _option_id(dataset.seed, "quotes", status.key, label, dataset.organization)
        for label in module.statuses
    }
    records = tuple(
        replace(record, data={
            **record.data,
            ids[status.key]: label_id[weighted_label(rng, weights)],
            ids[day_field.key]: cluster.pick(rng).isoformat(),
        }) if record.module_key == "quotes" else record
        for record in dataset.records
    )  # fmt: skip
    before = realism_report(dataset).issues
    after = realism_report(replace(dataset, records=records)).issues

    assert any(issue.startswith(("C1 quotes", "C3 quotes")) for issue in before)
    assert not any(issue.startswith(("C1 quotes", "C3 quotes")) for issue in after)


def test_holiday_records_are_reported_only_for_the_pack_holidays() -> None:
    dataset = _dataset("harbor")
    report = realism_report(dataset, holidays=frozenset({date(2026, 6, 12), date(2025, 12, 25)}))

    assert any(issue.startswith("C3 ") and "holidays" in issue for issue in report.issues)
    assert not any("holidays" in issue for issue in realism_report(dataset).issues)
