"""Input changes that exercise distributor Set-field rules during a live run."""

from __future__ import annotations

from typing import Any

from operations.sample.blueprint import SampleDataset, _option_id
from operations.sample.packs.fmcg_distributor.catalog_fields import NEAR_EXPIRY
from operations.sample.packs.fmcg_distributor.triggers import PATCH_KEYS
from operations.sample.population.run import SamplePopulationError

# Record, field and new value: each record starts in a state the change moves out of.
_MUTATIONS: dict[str, tuple[str, str, str | int]] = {
    PATCH_KEYS[0]: ("goods_receipts:000003", "status", "Posted with discrepancy"),
    PATCH_KEYS[1]: ("stock_lots:000003", "expiry_band", NEAR_EXPIRY),
    PATCH_KEYS[2]: ("sales_invoices:000004", "days_past_due", 34),
    PATCH_KEYS[3]: ("route_tours:000003", "cash_variance", -1_250),
}
_CHOICES = frozenset({"status", "expiry_band"})


def _trigger_mutation(dataset: SampleDataset, key: str) -> tuple[str, str, Any]:
    if key not in _MUTATIONS:
        raise SamplePopulationError("Unknown distributor record trigger mutation")
    logical_id, field_key, value = _MUTATIONS[key]
    module_key = logical_id.split(":", maxsplit=1)[0]
    field_id = dataset.field_ids[module_key][field_key]
    if field_key in _CHOICES:
        return logical_id, field_id, _option_id(
            dataset.seed, module_key, field_key, str(value), dataset.organization
        )
    return logical_id, field_id, value
