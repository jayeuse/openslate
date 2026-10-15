"""Larger Harbor and School profiles keep their relationship plans within cardinality.

Small payloads pass the server-rule preflight in test_sample_multi_seed.py, whose seed range
includes seed 42 for every pack.
"""

import pytest

from operations.sample.packs.registry import get_pack, pack_keys
from tests.operations.sample.packs.sample_pack_relationship_preflight import (
    admit_relationship_profile,
)


@pytest.mark.parametrize("profile", ("standard", "large"))
@pytest.mark.parametrize("pack_key", pack_keys())
def test_larger_profiles_keep_relationship_plans_within_cardinality(
    pack_key: str, profile: str
) -> None:
    # The compact pass enumerates planned edges only; it avoids materializing the large record set.
    admit_relationship_profile(get_pack(pack_key), profile)  # type: ignore[arg-type]
