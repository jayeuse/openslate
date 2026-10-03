"""Pack-neutral selection and Sandbox document helpers for phase planning."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from dataclasses import replace
from typing import TYPE_CHECKING, cast

from operations.sample_actors import planned_access_level
from operations.sample_catalog import _doc_id
from operations.sample_packs.interface import OrganizationPack
from operations.sample_packs.phase_types import (
    DesignPhaseSpec,
    GroupAccessChangeSpec,
    PhaseAction,
    PhaseActionKind,
    PhaseJsonValue,
    PhaseName,
)
from operations.sample_packs.types import ModuleSpec, PersonSpec

if TYPE_CHECKING:
    from operations.sample_blueprint import SampleDataset

_LEVELS = {"read": 1, "write": 2, "manage": 3}
_SIMPLE_KIND = {
    "Text": "text",
    "Long text": "long-text",
    "Number": "number",
    "Integer": "integer",
    "Date": "date",
    "Date/Time": "datetime",
    "Checkbox": "checkbox",
    "Select": "select",
    "Email": "email",
    "URL": "url",
    "User": "user",
}


def _person(pack: OrganizationPack, key: str) -> PersonSpec:
    person = next((candidate for candidate in pack.actors.people if candidate.key == key), None)
    if person is None:
        raise ValueError(f"Unknown phase person: {key}")
    return person


def _admin_key(pack: OrganizationPack) -> str:
    del pack
    # The login administrator is supplied by the run harness, not pack seed data.
    return "admin"


def _make_action(
    *,
    key: str,
    phase: str,
    kind: PhaseActionKind,
    actor_key: str,
    target_key: str,
    values: dict[str, PhaseJsonValue],
    expected_status: int = 200,
    expected_detail: str | None = None,
    expected_end_state: dict[str, PhaseJsonValue],
) -> PhaseAction:
    return PhaseAction(
        key=key,
        phase=cast(PhaseName, phase),
        kind=kind,
        actor_key=actor_key,
        target_key=target_key,
        values=values,
        expected_status=expected_status,
        expected_detail=expected_detail,
        expected_end_state=expected_end_state,
    )


def _board_level(pack: OrganizationPack, person_key: str, department_key: str) -> int:
    person = _person(pack, person_key)
    if person.status != "active":
        return 0
    if person.role == "admin":
        return 3
    spec = pack.content.data
    department_group, department_level = spec.department_groups[department_key]
    levels = [
        _LEVELS[level]
        for group, level in (*spec.project_groups, (department_group, department_level))
        if group in person.groups
    ]
    result = max(levels, default=0)
    return min(result, 1) if person.role == "guest" else result


def _move_preserves_access(
    pack: OrganizationPack,
    person_key: str,
    source_group: str,
    destination_group: str,
) -> bool:
    person = _person(pack, person_key)
    after_groups = tuple(group for group in person.groups if group != source_group) + (
        destination_group,
    )
    after_person = replace(person, groups=after_groups)
    after_pack = replace(
        pack,
        actors=replace(
            pack.actors,
            people=tuple(
                after_person if item.key == person_key else item for item in pack.actors.people
            ),
        ),
    )
    for department in pack.actors.department_keys:
        module_keys = (
            None,
            *(module.key for module in pack.catalog.modules if module.department == department),
        )
        for module_key in module_keys:
            if planned_access_level(after_pack, person_key, department, module_key) > (
                planned_access_level(pack, person_key, department, module_key)
            ):
                return False
    return all(
        _board_level(after_pack, person_key, department)
        <= _board_level(pack, person_key, department)
        for department in pack.actors.department_keys
    )


def _replacement_access(
    spec: GroupAccessChangeSpec, pack: OrganizationPack
) -> tuple[tuple[str, str | None, str], ...]:
    rows = pack.actors.group_access.get(spec.group_key)
    if rows is None:
        raise ValueError(f"Unknown group in phase access change: {spec.group_key}")
    matches = [
        (department, module, level)
        for department, module, level in rows
        if department == spec.department_key and module == spec.module_key
    ]
    if len(matches) != 1 or matches[0][2] != spec.current_level:
        raise ValueError("Phase access change does not match the pack's current grant")
    return tuple(
        (
            department,
            module,
            spec.replacement_level
            if (department, module) == (spec.department_key, spec.module_key)
            else level,
        )
        for department, module, level in rows
    )


def _module_score(module: ModuleSpec) -> int:
    kinds = {_SIMPLE_KIND[field.type] for field in module.fields}
    score = int(bool(kinds & {"date", "datetime"})) * 4
    score += int(bool(kinds & {"number", "integer"})) * 3
    score += int("select" in kinds) * 2
    score += int(bool(kinds & {"text", "long-text", "email", "url"}))
    return score


def _openview_source(pack: OrganizationPack, department_key: str) -> str:
    candidates = [
        module
        for module in pack.catalog.modules
        if module.department == department_key
        and module.fields
        and any(field.type in {"Date", "Date/Time"} for field in module.fields)
    ]
    candidates.sort(key=lambda module: (-_module_score(module), module.key))
    if not candidates:
        raise ValueError(f"OpenView phase has no date-report source in {department_key}")
    return candidates[0].key


def _manager_key(
    pack: OrganizationPack,
    department_key: str,
    module_key: str,
    *,
    department_scope: bool = False,
    excluded: frozenset[str] = frozenset(),
) -> str:
    lead = pack.content.data.leads[department_key]
    candidates = (lead, *(key for key in pack.actors.team_keys[department_key] if key != lead))
    return next(
        (
            key
            for key in candidates
            if key not in excluded
            if _person(pack, key).role != "admin"
            and planned_access_level(
                pack,
                key,
                department_key,
                None if department_scope else module_key,
            )
            >= 3
        ),
        "",
    )


def _document_version(
    dataset: SampleDataset,
    design_spec: DesignPhaseSpec,
    *,
    plan_values: Mapping[str, PhaseJsonValue] | None = None,
    closed: bool = False,
    include_new_module: bool = True,
) -> dict[str, object]:
    """Build the expected document before or after adding the new empty module."""
    values = plan_values or {}

    def planned_string(key: str, fallback: str) -> str:
        value = values.get(key)
        return value if isinstance(value, str) else fallback

    document = copy.deepcopy(dataset.document)
    design = cast(dict[str, object], document["design"])
    modules = cast(list[dict[str, object]], design["modules"])
    original_module_id = planned_string("module_id", dataset.module_ids[design_spec.module_key])
    original = next(module for module in modules if module["id"] == original_module_id)
    original["name"] = planned_string("renamed_module_name", design_spec.renamed_module_name)
    existing_fields = cast(list[dict[str, object]], original["fields"])
    new_field_key = "operational_review_notes"
    new_field_id = planned_string(
        "added_field_id",
        _doc_id(
            dataset.seed,
            "field",
            f"{design_spec.module_key}:{new_field_key}",
            dataset.organization,
        ),
    )
    existing_fields.append(
        {
            "id": new_field_id,
            "name": planned_string("added_field_name", design_spec.text_field_name),
            "type": "Long text",
            "required": False,
            "closed": False,
            "config": {"kind": "long-text"},
        }
    )
    select_id = planned_string(
        "select_field_id",
        dataset.field_ids[design_spec.module_key][design_spec.select_field_key],
    )
    select_doc = next(field for field in existing_fields if field["id"] == select_id)
    select_config = cast(dict[str, object], select_doc["config"])
    options = cast(list[dict[str, object]], select_config["options"])
    options.append(
        {
            "id": planned_string(
                "added_option_id",
                _doc_id(
                    dataset.seed,
                    "option",
                    f"{design_spec.module_key}:{design_spec.select_field_key}:{design_spec.select_option_label}",
                    dataset.organization,
                ),
            ),
            "label": planned_string("select_option_label", design_spec.select_option_label),
        }
    )

    if not include_new_module:
        return document

    new_module_id = planned_string(
        "new_module_id",
        _doc_id(dataset.seed, "module", design_spec.new_module_key, dataset.organization),
    )
    title_field_id = planned_string(
        "title_field_id",
        _doc_id(
            dataset.seed,
            "field",
            f"{design_spec.new_module_key}:name",
            dataset.organization,
        ),
    )
    new_module = {
        "id": new_module_id,
        "departmentId": planned_string(
            "new_module_department_id",
            dataset.department_ids[design_spec.new_module_department_key],
        ),
        "name": planned_string("new_module_name", design_spec.new_module_name),
        "closed": closed,
        "titleFieldId": title_field_id,
        "fields": [
            {
                "id": title_field_id,
                "name": planned_string("title_field_name", design_spec.new_module_title_field_name),
                "type": "Text",
                "required": False,
                "closed": False,
                "config": {"kind": "text"},
            }
        ],
    }
    modules.append(new_module)
    layout = cast(dict[str, dict[str, int]], design["layout"])
    department_id = planned_string(
        "new_module_department_id",
        dataset.department_ids[design_spec.new_module_department_key],
    )
    department_box = layout[department_id]
    child_count = sum(
        1
        for module in dataset.organization.catalog.modules
        if module.department == design_spec.new_module_department_key
    )
    layout[new_module_id] = {
        "x": department_box["x"] + 24 + (child_count % 2) * 336,
        "y": department_box["y"] + 64 + (child_count // 2) * 176,
        "width": 320,
        "height": 152,
    }
    return document


def _design_values(dataset: SampleDataset) -> dict[str, PhaseJsonValue]:
    spec = dataset.organization.phases
    if spec is None:
        raise ValueError("The organization pack must define lifecycle phase data")
    design = spec.design
    new_module_id = _doc_id(dataset.seed, "module", design.new_module_key, dataset.organization)
    title_field_id = _doc_id(
        dataset.seed, "field", f"{design.new_module_key}:name", dataset.organization
    )
    added_field_key = "operational_review_notes"
    added_field_id = _doc_id(
        dataset.seed, "field", f"{design.module_key}:{added_field_key}", dataset.organization
    )
    added_option_id = _doc_id(
        dataset.seed,
        "option",
        f"{design.module_key}:{design.select_field_key}:{design.select_option_label}",
        dataset.organization,
    )
    return {
        "module_key": design.module_key,
        "module_id": dataset.module_ids[design.module_key],
        "renamed_module_name": design.renamed_module_name,
        "added_field_key": added_field_key,
        "added_field_id": added_field_id,
        "added_field_name": design.text_field_name,
        "added_option_id": added_option_id,
        "select_field_key": design.select_field_key,
        "select_field_id": dataset.field_ids[design.module_key][design.select_field_key],
        "select_option_label": design.select_option_label,
        "new_module_key": design.new_module_key,
        "new_module_id": new_module_id,
        "new_module_name": design.new_module_name,
        "new_module_department_key": design.new_module_department_key,
        "new_module_department_id": dataset.department_ids[design.new_module_department_key],
        "title_field_key": "name",
        "title_field_id": title_field_id,
        "title_field_name": design.new_module_title_field_name,
        "open_version_key": "phase_design_open",
    }


def _sandbox_actions(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    """Build the planned Sandbox publications from this dataset's immutable IDs."""
    pack = dataset.organization
    spec = pack.phases
    if spec is None:
        raise ValueError("The organization pack must define lifecycle phase data")
    design_values = _design_values(dataset)
    admin = _admin_key(pack)
    base = {
        "phase": "reorganization",
        "actor_key": admin,
        "target_key": "sandbox:design",
    }
    return (
        _make_action(
            key="reorganization:sandbox_edit_publish",
            kind="sandbox_edit_publish",
            values={
                **design_values,
                "edit_publish_version_key": "phase_design_edited",
                "note": "Publish the planned Sandbox design.",
            },
            expected_status=201,
            expected_end_state={
                "renamed_module_name": spec.design.renamed_module_name,
                "added_field_key": "operational_review_notes",
                "new_option_id": design_values["added_option_id"],
                "new_module_id": design_values["new_module_id"],
                "new_module_closed": False,
            },
            **base,
        ),
        _make_action(
            key="reorganization:sandbox_close_empty_publish",
            kind="sandbox_close_empty_publish",
            values={
                "module_key": spec.design.new_module_key,
                "module_id": design_values["new_module_id"],
                "version_key": "phase_design_closed",
                "note": "Publish the planned empty-module close.",
            },
            expected_status=201,
            expected_end_state={"new_module_closed": True},
            **base,
        ),
        _make_action(
            key="reorganization:sandbox_reopen_empty_publish",
            kind="sandbox_reopen_empty_publish",
            values={
                "module_key": spec.design.new_module_key,
                "module_id": design_values["new_module_id"],
                "version_key": "phase_design_reopened",
                "note": "Publish the planned empty-module reopen.",
            },
            expected_status=201,
            expected_end_state={"new_module_closed": False},
            **base,
        ),
        _make_action(
            key="reorganization:sandbox_restore_publish",
            kind="sandbox_restore_publish",
            values={
                "restore_version_key": "phase_design_open",
                "checkpoint_version_key": "phase_before_restore_checkpoint",
                "version_key": "phase_design_restored",
                "note": "Publish the planned restored design.",
            },
            expected_status=201,
            expected_end_state={
                "final_version_key": "phase_design_restored",
                "new_module_closed": False,
            },
            **base,
        ),
    )
