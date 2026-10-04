"""Published Sandbox structure reconciliation and mapping helpers."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
)
from operations.sample.phases.design_common import (
    _list_items,
    _record_new_mapping,
)

if TYPE_CHECKING:
    from operations.sample.blueprint import SampleDataset


def _map_published_structure(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    values: Mapping[str, Any],
    on_substep: PhaseSubstep | None,
) -> None:
    module_key = str(values["module_key"])
    module_id = _mapped_id(context, "modules", module_key, step="read_published_modules")
    module_spec = next(
        item for item in dataset.organization.catalog.modules if item.key == module_key
    )
    module_rows = _list_items(
        action,
        context,
        evidence,
        path="/api/modules",
        params={"department_id": context.department_ids[module_spec.department]},
        step="read_published_modules",
        on_substep=on_substep,
    )
    target_rows = [
        row
        for row in module_rows
        if row.get("id") == module_id
        and row.get("department_id") == context.department_ids[module_spec.department]
        and row.get("module_name") == values["renamed_module_name"]
        and row.get("is_deleted") is False
    ]
    if len(target_rows) != 1:
        raise SamplePhaseActionError(
            "Published target module did not match its plan", step="read_published_modules"
        )

    new_module_key = str(values["new_module_key"])
    new_module_name = str(values["new_module_name"])
    new_department_key = str(values["new_module_department_key"])
    new_department_id = context.department_ids[new_department_key]
    new_module_matches = [
        row
        for row in _list_items(
            action,
            context,
            evidence,
            path="/api/modules",
            params={"department_id": new_department_id},
            step="read_published_modules",
            on_substep=on_substep,
        )
        if row.get("module_name") == new_module_name
        and row.get("department_id") == new_department_id
        and row.get("is_deleted") is False
    ]
    if len(new_module_matches) != 1:
        raise SamplePhaseActionError(
            "Published new module was missing or ambiguous", step="read_published_modules"
        )
    live_new_module_id = _id(
        {"module": new_module_matches[0].get("id")},
        "module",
        label="published module",
        step="read_published_modules",
    )
    _record_new_mapping(context, action, "modules", new_module_key, live_new_module_id, mappings)

    added_field_key = str(values["added_field_key"])
    added_field_name = str(values["added_field_name"])
    added_fields = _list_items(
        action,
        context,
        evidence,
        path="/api/fields",
        params={"module_id": module_id},
        step="read_published_fields",
        on_substep=on_substep,
    )
    added_field_matches = [
        row
        for row in added_fields
        if row.get("name") == added_field_name
        and row.get("module_id") == module_id
        and row.get("is_deleted") is False
    ]
    if len(added_field_matches) != 1:
        raise SamplePhaseActionError(
            "Published added field was missing or ambiguous", step="read_published_fields"
        )
    added_field_id = _id(
        {"field": added_field_matches[0].get("id")},
        "field",
        label="published field",
        step="read_published_fields",
    )
    _record_new_mapping(
        context,
        action,
        "fields",
        f"{module_key}:{added_field_key}",
        added_field_id,
        mappings,
    )

    title_field_key = str(values["title_field_key"])
    title_field_name = str(values["title_field_name"])
    title_fields = _list_items(
        action,
        context,
        evidence,
        path="/api/fields",
        params={"module_id": live_new_module_id},
        step="read_published_fields",
        on_substep=on_substep,
    )
    title_matches = [
        row
        for row in title_fields
        if row.get("name") == title_field_name
        and row.get("module_id") == live_new_module_id
        and row.get("is_deleted") is False
    ]
    if len(title_matches) != 1:
        raise SamplePhaseActionError(
            "Published title field was missing or ambiguous", step="read_published_fields"
        )
    title_field_id = _id(
        {"field": title_matches[0].get("id")},
        "field",
        label="published field",
        step="read_published_fields",
    )
    _record_new_mapping(
        context,
        action,
        "fields",
        f"{new_module_key}:{title_field_key}",
        title_field_id,
        mappings,
    )
