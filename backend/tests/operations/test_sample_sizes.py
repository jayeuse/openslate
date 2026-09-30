from operations.sample_catalog import module_counts
from operations.sample_packs import default_pack


def _ceil_divide(value: int, divisor: int) -> int:
    return (value + divisor - 1) // divisor


def test_harbor_profiles_scale_from_a_roughly_five_thousand_standard_run() -> None:
    pack = default_pack()
    standard = module_counts("standard", pack)
    small = module_counts("small", pack)
    large = module_counts("large", pack)
    standard_source = {module.key: module.standard_count for module in pack.catalog.modules}
    expected_standard = {key: _ceil_divide(count, 4) for key, count in standard_source.items()}

    assert sum(standard.values()) == 5_001
    assert standard == expected_standard
    assert small == {key: max(1, _ceil_divide(count, 5)) for key, count in standard.items()}
    assert large == {key: count * 4 for key, count in standard.items()}
    assert sum(small.values()) == 1_001
    assert sum(large.values()) == 20_004


def test_harbor_keeps_the_version_one_profile_counts() -> None:
    pack = default_pack()
    legacy = pack.catalog.legacy_counts_by_profile
    assert legacy is not None
    old_standard = {module.key: module.standard_count for module in pack.catalog.modules}

    assert legacy["standard"] == old_standard
    assert legacy["small"] == {
        key: max(1, _ceil_divide(count, 20)) for key, count in old_standard.items()
    }
    assert legacy["large"] == {key: count * 5 for key, count in old_standard.items()}
