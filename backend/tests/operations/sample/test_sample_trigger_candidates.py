"""Every seed must give each record-created automation at least one authored record."""

from datetime import date

import pytest

from operations.sample.packs.registry import get_pack, pack_keys
from operations.sample.population.triggers import validate_record_trigger_candidates
from operations.sample.scenario import build_dataset


@pytest.mark.parametrize("pack_key", pack_keys())
def test_every_seed_authors_a_record_for_each_created_trigger(pack_key: str) -> None:
    # Seven-pack run on 2026-10-30: Harbor seed 13780166122446134890 stopped at its
    # baseline with "No authored record exercises trigger urgent-request-created". The
    # rule needs an Open, Urgent service request; status and priority were drawn
    # separately, so 37 of 200 seeds had none.
    pack = get_pack(pack_key)
    for seed in (13780166122446134890, 62, 101, *range(40)):
        validate_record_trigger_candidates(
            build_dataset("small", seed, date(2026, 10, 30), organization=pack)
        )
