"""The offline realism report finds clean data and accepts data that follows the rules."""

import random
from dataclasses import replace
from datetime import date, timedelta

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


@pytest.mark.parametrize("pack", pack_keys())
@pytest.mark.parametrize("criterion", [1, 2, 3, 4, 5])
@pytest.mark.parametrize("profile", ["standard", "large"])
def test_pack_plan_has_a_real_organizations_shape(pack: str, criterion: int, profile: str) -> None:
    dataset = build_dataset(profile, 42, ANCHOR, organization=get_pack(pack))
    assert realism_report(dataset, **pack_realism(dataset)).failed(criterion) == []


def test_status_and_date_checks_find_flat_values_and_accept_values_drawn_by_the_rules() -> None:
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
    label_id = {
        label: _option_id(dataset.seed, module.key, status.key, label, dataset.organization)
        for label in module.statuses
    }
    weights = {label: 100 / (rank + 1) ** 2 for rank, label in enumerate(module.statuses)}
    cluster = DateCluster(DateShape(date(2025, 10, 1), ANCHOR))
    rng = random.Random("42:report")

    def rewrite(flat: bool):
        rows = []
        for position, record in enumerate(dataset.records):
            if record.module_key != module.key:
                rows.append(record)
                continue
            label = (module.statuses[position % len(module.statuses)] if flat
                     else weighted_label(rng, weights))  # fmt: skip
            day = date(2025, 10, 1) + timedelta(days=position % 300) if flat else cluster.pick(rng)
            data = {**record.data, ids[status.key]: label_id[label],
                    ids[day_field.key]: day.isoformat()}  # fmt: skip
            rows.append(replace(record, data=data))
        return realism_report(replace(dataset, records=tuple(rows))).issues

    prefixes = (f"C1 {module.key}:", f"C3 {module.key}:")
    flat = rewrite(flat=True)
    assert all(any(issue.startswith(prefix) for issue in flat) for prefix in prefixes)
    assert not any(issue.startswith(prefixes) for issue in rewrite(flat=False))


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
