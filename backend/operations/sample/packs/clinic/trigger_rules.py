"""Input changes that exercise Clinic Set-field rules during a live run."""

from __future__ import annotations

from typing import Any

from operations.sample.blueprint import SampleDataset, _option_id
from operations.sample.packs.clinic.triggers import PATCH_KEYS
from operations.sample.population.run import SamplePopulationError

# Record, field and new value: each record starts in a state the change moves out of.
_MUTATIONS: dict[str, tuple[str, str, str | int]] = {
    PATCH_KEYS[0]: ("encounters:000003", "status", "Finished"),
    PATCH_KEYS[1]: ("claims:000003", "status", "Denied"),
    PATCH_KEYS[2]: ("stock_lots:000003", "qty_on_hand", 12),
    PATCH_KEYS[3]: ("equipment:000004", "status", "Out of service"),
}


def _trigger_mutation(dataset: SampleDataset, key: str) -> tuple[str, str, Any]:
    if key not in _MUTATIONS:
        raise SamplePopulationError("Unknown Clinic record trigger mutation")
    logical_id, field_key, value = _MUTATIONS[key]
    module_key = logical_id.split(":", maxsplit=1)[0]
    field_id = dataset.field_ids[module_key][field_key]
    if field_key == "status":
        return logical_id, field_id, _option_id(
            dataset.seed, module_key, field_key, str(value), dataset.organization
        )
    return logical_id, field_id, value
