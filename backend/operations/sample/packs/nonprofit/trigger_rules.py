"""Input changes that exercise the foundation's Set-field rules during a live run."""

from __future__ import annotations

from typing import Any

from operations.sample.blueprint import SampleDataset, _option_id
from operations.sample.packs.nonprofit.catalog_fields import AWARDED
from operations.sample.packs.nonprofit.triggers import PATCH_KEYS
from operations.sample.population.run import SamplePopulationError

# Record, field and new value: each record starts in a state the change moves out of.
_MUTATIONS: dict[str, tuple[str, str, str | int]] = {
    PATCH_KEYS[0]: ("grant_awards:000004", "status", AWARDED),
    PATCH_KEYS[1]: ("budget_lines:000004", "burn_rate", 93),
    PATCH_KEYS[2]: ("assistance:000004", "status", "Disputed"),
    PATCH_KEYS[3]: ("cash_advances:000004", "balance", 0),
}


def _trigger_mutation(dataset: SampleDataset, key: str) -> tuple[str, str, Any]:
    if key not in _MUTATIONS:
        raise SamplePopulationError("Unknown Fairhaven record trigger mutation")
    logical_id, field_key, value = _MUTATIONS[key]
    module_key = logical_id.split(":", maxsplit=1)[0]
    field_id = dataset.field_ids[module_key][field_key]
    if field_key == "status":
        return logical_id, field_id, _option_id(
            dataset.seed, module_key, field_key, str(value), dataset.organization
        )
    return logical_id, field_id, value
