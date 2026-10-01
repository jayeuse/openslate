"""Generated Harbor and School requests satisfy the current application contracts."""

from datetime import date

import pytest

from operations.sample_packs.registry import get_pack, pack_keys
from operations.sample_scenario import build_dataset
from tests.operations.sample_pack_preflight import admit_dataset
from tests.operations.sample_pack_relationship_preflight import admit_relationship_profile

ANCHOR = date(2026, 9, 30)


@pytest.mark.parametrize("pack_key", pack_keys())
def test_seed_42_small_payloads_pass_server_rule_preflight(pack_key: str) -> None:
    dataset = build_dataset("small", seed=42, anchor_date=ANCHOR, organization=get_pack(pack_key))
    admit_dataset(dataset)


@pytest.mark.parametrize("profile", ("standard", "large"))
@pytest.mark.parametrize("pack_key", pack_keys())
def test_larger_profiles_keep_relationship_plans_within_cardinality(
    pack_key: str, profile: str
) -> None:
    # The compact pass enumerates planned edges only; it avoids materializing the large record set.
    admit_relationship_profile(get_pack(pack_key), profile)  # type: ignore[arg-type]
