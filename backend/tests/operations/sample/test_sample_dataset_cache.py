"""The shared dataset cache hands out fresh builds that no other test can change."""

from datetime import date

import pytest

from operations.sample.packs.registry import get_pack
from operations.sample.scenario import build_dataset
from tests.operations.sample.sample_datasets import sample_dataset


@pytest.mark.parametrize(
    ("anchor", "pack"),
    ((date(2026, 9, 30), "harbor"), (date(2026, 9, 29), "harbor"), (date(2026, 9, 30), "school")),
)
def test_a_cached_dataset_equals_a_fresh_build_and_keeps_its_pack(anchor: date, pack: str) -> None:
    cached = sample_dataset("small", 42, anchor, pack)

    assert cached == build_dataset(
        "small", seed=42, anchor_date=anchor, organization=get_pack(pack)
    )
    assert cached.organization is get_pack(pack)


def test_each_cached_dataset_is_a_private_copy() -> None:
    first = sample_dataset()
    first.document["design"]["modules"].clear()
    first.module_counts.clear()
    first.records[0].data.clear()

    second = sample_dataset()

    assert second.document["design"]["modules"]
    assert second.module_counts
    assert second.records[0].data
    assert second == build_dataset("small", seed=42, anchor_date=date(2026, 9, 30))
