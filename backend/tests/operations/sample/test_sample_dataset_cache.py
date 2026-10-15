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


@pytest.mark.parametrize(
    "builder_name", ("_built", "_configuration_base", "_phase_configuration_base")
)
def test_mutation_mode_rebuilds_warm_fixtures_after_a_dependency_changes(
    monkeypatch: pytest.MonkeyPatch, builder_name: str
) -> None:
    from tests.operations.sample import sample_datasets
    from tests.operations.sample.phases.test_sample_phase_configuration import (
        _phase_configuration_base,
    )
    from tests.operations.sample.verification.test_sample_run_verification import (
        _configuration_base,
    )

    owned_caches = (sample_datasets._built, _configuration_base, _phase_configuration_base)
    builder = {
        "_built": lambda: sample_datasets._built("small", 42, date(2026, 9, 29), "harbor"),
        "_configuration_base": _configuration_base,
        "_phase_configuration_base": _phase_configuration_base,
    }[builder_name]
    monkeypatch.delenv("MUTANT_UNDER_TEST", raising=False)
    for cached in owned_caches:
        cached.cache_clear()
    try:
        warm = builder()
        monkeypatch.setenv("MUTANT_UNDER_TEST", "stats")
        assert builder() == warm
        monkeypatch.delenv("MUTANT_UNDER_TEST")

        def changed_dependency(*_args: object, **_kwargs: object) -> None:
            raise RuntimeError("changed build_dataset dependency")

        monkeypatch.setattr(sample_datasets, "build_dataset", changed_dependency)
        assert builder() == warm
        for marker in ("stats", "", "operations.sample.scenario.x_build_dataset__mutmut_1"):
            monkeypatch.setenv("MUTANT_UNDER_TEST", marker)
            with pytest.raises(RuntimeError, match="changed build_dataset dependency"):
                builder()
        monkeypatch.delenv("MUTANT_UNDER_TEST")
        assert builder() == warm
    finally:
        for cached in owned_caches:
            cached.cache_clear()
