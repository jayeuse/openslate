"""Input changes that exercise School Set-field rules during a live run."""

from __future__ import annotations

from typing import Any

from operations.sample.blueprint import SampleDataset, _option_id
from operations.sample.packs.school.triggers import PATCH_KEYS
from operations.sample.population.run import SamplePopulationError


def _trigger_mutation(dataset: SampleDataset, key: str) -> tuple[str, str, Any]:
    if key == PATCH_KEYS[0]:
        logical_id = "applications:000002"
        return (
            logical_id,
            dataset.field_ids["applications"]["status"],
            _option_id(dataset.seed, "applications", "status", "Enrolled", dataset.organization),
        )
    if key == PATCH_KEYS[1]:
        logical_id = "attendance_exceptions:000003"
        return (
            logical_id,
            dataset.field_ids["attendance_exceptions"]["consecutive_days_absent"],
            5,
        )
    if key == PATCH_KEYS[2]:
        logical_id = "fee_assessments:000003"
        return (
            logical_id,
            dataset.field_ids["fee_assessments"]["status"],
            _option_id(dataset.seed, "fee_assessments", "status", "Past due", dataset.organization),
        )
    if key == PATCH_KEYS[3]:
        logical_id = "students:000002"
        return (
            logical_id,
            dataset.field_ids["students"]["status"],
            _option_id(dataset.seed, "students", "status", "Enrolled", dataset.organization),
        )
    raise SamplePopulationError("Unknown School record trigger mutation")
