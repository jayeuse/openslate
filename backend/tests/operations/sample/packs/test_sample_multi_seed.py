"""A deterministic seed range exercises the complete offline pack admission path."""

from datetime import date

import pytest

from operations.sample.packs.registry import get_pack, pack_keys
from operations.sample.scenario import build_dataset
from tests.operations.sample.packs.sample_pack_preflight import admit_dataset

ANCHOR = date(2026, 9, 30)
SEEDS = (
    0,
    1,
    2,
    3,
    5,
    7,
    11,
    17,
    23,
    42,
    99,
    123_456_789,
    2**32 - 1,
    2**32,
    2**53,
    0x123456789ABCDEF,
    2**63,
    2**64 - 2,
    2**64 - 1,
    9_876_543_210_987_654_321,
)


@pytest.mark.parametrize("pack_key", pack_keys())
def test_twenty_small_seeds_per_pack_pass_offline_admission(pack_key: str) -> None:
    assert len(SEEDS) == 20
    assert len(set(SEEDS)) == 20
    assert {0, 42, 2**64 - 1} <= set(SEEDS)
    assert all(0 <= seed < 2**64 for seed in SEEDS)
    pack = get_pack(pack_key)
    failures: list[str] = []
    for seed in SEEDS:
        dataset = build_dataset("small", seed=seed, anchor_date=ANCHOR, organization=pack)
        try:
            admit_dataset(dataset)
        except Exception as error:
            failures.append(f"seed {seed}: {error}")
    assert not failures, f"{pack_key} Small offline admission failures: {'; '.join(failures)}"
