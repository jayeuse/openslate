"""Input changes that exercise the city government's Set-field rules during a live run."""

from __future__ import annotations

from typing import Any

from operations.sample.blueprint import SampleDataset, _option_id
from operations.sample.packs.local_government.triggers import PATCH_KEYS
from operations.sample.population.run import SamplePopulationError

# Record, field and new value: each record starts in a state the change moves out of.
_MUTATIONS: dict[str, tuple[str, str, str | int]] = {
    PATCH_KEYS[0]: ("permit_applications:000003", "status", "Assessed"),
    PATCH_KEYS[1]: ("building_permits:000003", "days_pending", 9),
    PATCH_KEYS[2]: ("purchase_requests:000003", "abc_amount", 2_400_000),
    PATCH_KEYS[3]: ("legislative_measures:000003", "status", "Approved on third reading"),
}


def _trigger_mutation(dataset: SampleDataset, key: str) -> tuple[str, str, Any]:
    if key not in _MUTATIONS:
        raise SamplePopulationError("Unknown city government record trigger mutation")
    logical_id, field_key, value = _MUTATIONS[key]
    module_key = logical_id.split(":", maxsplit=1)[0]
    field_id = dataset.field_ids[module_key][field_key]
    if field_key == "status":
        return (
            logical_id,
            field_id,
            _option_id(dataset.seed, module_key, field_key, str(value), dataset.organization),
        )
    return logical_id, field_id, value
