"""Harbor trigger-specific record choices for exercising Set-field rules."""

from __future__ import annotations

from typing import Any

from operations.sample.blueprint import SampleDataset
from operations.sample.population.run import SamplePopulationError
from operations.sample.population.triggers import _module_defaults, _select_option_id


def _trigger_mutation(dataset: SampleDataset, key: str) -> tuple[str, str, Any]:
    if key == "quote-value-changed":
        sample = next(item for item in dataset.records if item.logical_id == "quotes:000001")
        field_id = dataset.field_ids["quotes"]["total"]
        current = sample.data.get(field_id, 0)
        if isinstance(current, bool) or not isinstance(current, (int, float)):
            raise SamplePopulationError("Quote trigger input is not numeric")
        return sample.logical_id, field_id, max(current + 1, 5_001)
    if key == "work-order-state-changed":
        sample = next(item for item in dataset.records if item.logical_id == "work_orders:000001")
        field_id = dataset.field_ids["work_orders"]["status"]
        current = sample.data.get(field_id)
        target = _select_option_id(dataset, "work_orders", "status", "Scheduled")
        alternative = _select_option_id(dataset, "work_orders", "status", "Overdue")
        return sample.logical_id, field_id, alternative if current == target else target
    if key == "large-invoice-threshold":
        total_id = dataset.field_ids["invoices"]["total"]
        status_id = dataset.field_ids["invoices"]["status"]
        defaults = _module_defaults(dataset, "invoices")
        cancelled = _select_option_id(dataset, "invoices", "status", "Cancelled")
        paid = _select_option_id(dataset, "invoices", "status", "Paid")
        for sample in dataset.records:
            if sample.module_key != "invoices" or sample.logical_id == "invoices:000001":
                continue
            total = sample.data.get(total_id, defaults.get(total_id))
            status = sample.data.get(status_id, defaults.get(status_id))
            if (
                isinstance(total, (int, float))
                and not isinstance(total, bool)
                and total <= 10_000
                and status not in {cancelled, paid}
            ):
                return sample.logical_id, total_id, 10_001
        raise SamplePopulationError("No non-cancelled open invoice exercises the threshold rule")
    if key == "large-movement-threshold":
        return "stock_movements:000001", dataset.field_ids["stock_movements"]["quantity"], 20
    raise SamplePopulationError("Unknown record trigger mutation")
