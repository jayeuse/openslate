"""The offline realism report finds clean data and accepts data that follows the rules."""

import random
from dataclasses import replace
from datetime import date

import pytest

from operations.sample.blueprint import _option_id
from operations.sample.packs.registry import get_pack, pack_keys
from operations.sample.realism import DateCluster, DateShape, weighted_label
from operations.sample.scenario import build_dataset
from operations.sample.verification.realism import is_round, pack_realism, realism_report

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


# Packs that already apply rules R1-R5 (P2). The others are strict xfails until they do.
REALISTIC = {"harbor"}


@pytest.mark.parametrize(
    "pack,criterion",
    [
        pytest.param(
            pack,
            criterion,
            marks=()
            if pack in REALISTIC or criterion == 4
            else pytest.mark.xfail(strict=True, reason=f"P2 applies rule C{criterion}"),
        )
        for pack in pack_keys()
        for criterion in (1, 2, 3, 4, 5)
    ],
)
@pytest.mark.parametrize("profile", ["standard", "large"])
def test_pack_plan_has_a_real_organizations_shape(pack: str, criterion: int, profile: str) -> None:
    dataset = build_dataset(profile, 42, ANCHOR, organization=get_pack(pack))
    assert realism_report(dataset, **pack_realism(dataset)).failed(criterion) == []


def test_status_and_date_checks_accept_values_drawn_by_the_rules() -> None:
    # School still has the old flat values, so its first big module shows both issues.
    dataset = _dataset("school")
    module = next(
        m for m in dataset.organization.catalog.modules
        if len(m.statuses) >= 4 and dataset.module_counts[m.key] >= 30
        and any(f.type == "Date" for f in m.fields)
        and any(f.value_kind == "status" for f in m.fields)
    )  # fmt: skip
    status = next(f for f in module.fields if f.value_kind == "status")
    day_field = next(f for f in module.fields if f.type == "Date")
    ids = dataset.field_ids[module.key]
    weights = {label: 100 / (rank + 1) ** 2 for rank, label in enumerate(module.statuses)}
    cluster = DateCluster(DateShape(date(2025, 10, 1), ANCHOR))
    rng = random.Random("42:report")
    label_id = {
        label: _option_id(dataset.seed, module.key, status.key, label, dataset.organization)
        for label in module.statuses
    }
    records = tuple(
        replace(record, data={
            **record.data,
            ids[status.key]: label_id[weighted_label(rng, weights)],
            ids[day_field.key]: cluster.pick(rng).isoformat(),
        }) if record.module_key == module.key else record
        for record in dataset.records
    )  # fmt: skip
    prefixes = (f"C1 {module.key}:", f"C3 {module.key}:")
    before = realism_report(dataset).issues
    after = realism_report(replace(dataset, records=records)).issues

    assert any(issue.startswith(prefixes) for issue in before)
    assert not any(issue.startswith(prefixes) for issue in after)


def test_holiday_records_are_reported_only_for_the_given_holidays() -> None:
    # A holiday list that covers every day School's records use must be reported;
    # Harbor's own holidays hold no records.
    school = _dataset("school")
    christmas = frozenset(
        date.fromisoformat(value[:10])
        for record in school.records
        for value in record.data.values()
        if isinstance(value, str) and len(value) == 10 and value[:2] == "20"
    )

    assert any("holidays" in issue for issue in realism_report(school, holidays=christmas).issues)
    assert not any("holidays" in issue for issue in realism_report(school).issues)
    harbor = _dataset("harbor")
    assert not realism_report(harbor, **pack_realism(harbor)).failed(3)
