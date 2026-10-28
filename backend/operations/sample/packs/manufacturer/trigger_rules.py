"""Input changes that exercise the sauce plant's Set-field rules during a live run."""

from __future__ import annotations

from typing import Any

from operations.sample.blueprint import SampleDataset, _option_id
from operations.sample.packs.manufacturer.triggers import PATCH_KEYS
from operations.sample.population.run import SamplePopulationError

# Record, field and new value: each record starts in a state the change moves out of.
_MUTATIONS: dict[str, tuple[str, str, str | int | float]] = {
    PATCH_KEYS[0]: ("batch_records:000003", "equilibrium_ph", 4.47),
    PATCH_KEYS[1]: ("shift_reports:000003", "oee_pct", 48.5),
    PATCH_KEYS[2]: ("materials:000003", "on_hand", 4),
    PATCH_KEYS[3]: ("supplier_invoices:000003", "price_variance", 812.4),
}


def _trigger_mutation(dataset: SampleDataset, key: str) -> tuple[str, str, Any]:
    if key not in _MUTATIONS:
        raise SamplePopulationError("Unknown sauce plant record trigger mutation")
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
