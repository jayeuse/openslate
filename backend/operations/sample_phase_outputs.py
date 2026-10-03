"""Expected final state projections and version snapshots for phase plans."""

from __future__ import annotations

import copy
from typing import TYPE_CHECKING, Any, cast

from app.systems.sandbox.designs.schemas import SandboxDocument
from operations.sample_packs.phase_types import DesignPhaseSpec, PhaseAction
from operations.sample_phase_planning import _document_version

if TYPE_CHECKING:
    from operations.sample_blueprint import SampleDataset


def phase_expected_projection(actions: tuple[PhaseAction, ...]) -> dict[str, object]:
    """Project expected final application state independently of execution results."""
    people: dict[str, dict[str, object]] = {}
    additions: set[tuple[str, str]] = set()
    removals: set[tuple[str, str]] = set()
    group_access: dict[str, list[dict[str, object]]] = {}
    boards: dict[str, dict[str, object]] = {}
    openview: dict[str, dict[str, object]] = {}
    ended_sessions: list[dict[str, object]] = []
    design: dict[str, object] = {}

    for action in actions:
        values = action.values
        if action.kind == "promote_user":
            people.setdefault(action.target_key, {})["role"] = "admin"
            removed_groups = values.get("removed_group_keys")
            if isinstance(removed_groups, list):
                for group in removed_groups:
                    if isinstance(group, str):
                        removals.add((group, action.target_key))
        elif action.kind == "demote_user":
            people.setdefault(action.target_key, {})["role"] = str(values["role"])
        elif action.kind == "remove_group_member":
            removals.add((str(values["source_group_key"]), action.target_key))
        elif action.kind == "add_group_member":
            additions.add((str(values["destination_group_key"]), action.target_key))
        elif action.kind == "replace_group_access":
            group_access[action.target_key] = [
                {
                    "department_key": row["department_key"],
                    "module_key": row["module_key"],
                    "level": row["level"],
                }
                for row in cast(list[dict[str, object]], values["access"])
            ]
        elif action.kind == "disable_user":
            people.setdefault(action.target_key, {})["status"] = "disabled"
        elif action.kind == "restore_disabled_user":
            people.setdefault(action.target_key, {})["status"] = "active"
        elif action.kind == "end_session":
            ended_sessions.append({"person_key": action.target_key, "current": True})
        elif action.kind in {
            "board_archive",
            "board_restore",
            "board_archive_purge_target",
            "board_purge",
            "board_create_purge_target",
        }:
            state = boards.setdefault(action.target_key, {"scope": "project"})
            if action.kind == "board_create_purge_target":
                state.update({"status": "active", "name": values["display_name"]})
            elif action.kind in {"board_archive", "board_archive_purge_target"}:
                state["status"] = "archived"
            elif action.kind == "board_restore":
                state["status"] = "active"
            else:
                state["status"] = "purged"
        elif action.kind in {"openview_archive", "openview_restore"}:
            state = openview.setdefault(
                action.target_key,
                {
                    "resource_kind": values["resource_kind"],
                    "department_key": values["department_key"],
                },
            )
            state["is_deleted"] = action.kind == "openview_archive"
        elif action.kind == "sandbox_edit_publish":
            design.update(
                {
                    "module_key": values["module_key"],
                    "renamed_module_name": values["renamed_module_name"],
                    "added_field_key": values["added_field_key"],
                    "added_field_id": values["added_field_id"],
                    "added_option_id": values["added_option_id"],
                    "new_module_key": values["new_module_key"],
                    "new_module_id": values["new_module_id"],
                    "title_field_key": values["title_field_key"],
                    "title_field_id": values["title_field_id"],
                    "edited_version_key": values["edit_publish_version_key"],
                    "open_version_key": values["open_version_key"],
                }
            )
        elif action.kind == "sandbox_close_empty_publish":
            design["new_module_closed"] = True
        elif action.kind in {"sandbox_reopen_empty_publish", "sandbox_restore_publish"}:
            design["new_module_closed"] = False
            if action.kind == "sandbox_restore_publish":
                design["final_version_key"] = values["version_key"]

    # A membership removed and later restored (or added and later removed) has no net change.
    unchanged = additions & removals
    additions -= unchanged
    removals -= unchanged
    return {
        "people": people,
        "membership_additions": sorted(additions),
        "membership_removals": sorted(removals),
        "group_access": group_access,
        "boards": boards,
        "openview": openview,
        "ended_sessions": ended_sessions,
        "design": design,
    }


def _required_string(action: PhaseAction, name: str) -> str:
    value = action.values.get(name)
    if not isinstance(value, str) or not value:
        raise ValueError(f"Recorded phase action has no valid {name}")
    return value


def _action_of_kind(
    actions: tuple[PhaseAction, ...], kind: str, *, required: bool = True
) -> PhaseAction | None:
    matches = [action for action in actions if action.kind == kind]
    if len(matches) > 1 or (required and not matches):
        raise ValueError(f"Expected one recorded phase action of kind {kind}")
    return matches[0] if matches else None


def _design_spec(action: PhaseAction) -> DesignPhaseSpec:
    return DesignPhaseSpec(
        module_key=_required_string(action, "module_key"),
        renamed_module_name=_required_string(action, "renamed_module_name"),
        text_field_name=_required_string(action, "added_field_name"),
        select_field_key=_required_string(action, "select_field_key"),
        select_option_label=_required_string(action, "select_option_label"),
        new_module_key=_required_string(action, "new_module_key"),
        new_module_name=_required_string(action, "new_module_name"),
        new_module_department_key=_required_string(action, "new_module_department_key"),
        new_module_title_field_name=_required_string(action, "title_field_name"),
    )


def _normalized(document: dict[str, object]) -> dict[str, object]:
    """The design as the server stores it: schema defaults filled, empty values dropped."""
    return SandboxDocument.model_validate(document).model_dump(
        by_alias=True, mode="json", exclude_none=True
    )


def phase_version_documents(
    dataset: SampleDataset, actions: tuple[PhaseAction, ...]
) -> dict[str, dict[str, object]]:
    """Build expected Sandbox snapshots using the recorded design action values."""
    edit = _action_of_kind(actions, "sandbox_edit_publish", required=False)
    if edit is None:
        return {}
    close = _action_of_kind(actions, "sandbox_close_empty_publish")
    reopen = _action_of_kind(actions, "sandbox_reopen_empty_publish")
    restore = _action_of_kind(actions, "sandbox_restore_publish")
    assert close is not None and reopen is not None and restore is not None

    spec = _design_spec(edit)
    planned_module_id = _required_string(edit, "new_module_id")
    for action in (close, reopen):
        if _required_string(action, "module_id") != planned_module_id:
            raise ValueError("Recorded Sandbox actions disagree on the new module ID")

    values = edit.values
    # Normalize like the generated design, so server-filled defaults match on readback.
    edited = _normalized(
        _document_version(dataset, spec, plan_values=values, include_new_module=False)
    )
    opened = _normalized(_document_version(dataset, spec, plan_values=values))
    closed = _normalized(_document_version(dataset, spec, plan_values=values, closed=True))
    from operations.sample_control_sandbox import VERSION_KEY, fixture_document

    return {
        "initial_checkpoint": copy.deepcopy(dataset.document),
        "published": copy.deepcopy(dataset.document),
        VERSION_KEY: fixture_document(dataset),
        _required_string(edit, "edit_publish_version_key"): edited,
        _required_string(edit, "open_version_key"): opened,
        _required_string(close, "version_key"): closed,
        _required_string(reopen, "version_key"): copy.deepcopy(opened),
        _required_string(restore, "checkpoint_version_key"): copy.deepcopy(opened),
        _required_string(restore, "version_key"): copy.deepcopy(opened),
    }


def expected_lifecycle_document(
    dataset: SampleDataset, operation: str, *, after: bool = False
) -> dict[str, Any]:
    from operations.sample_control_sandbox import OPERATIONS, fixture_document, fixture_values
    from operations.sample_phase_design_common import _canonical_document

    if operation == OPERATIONS[0]:
        return (
            fixture_document(dataset)
            if after
            else _canonical_document(dataset.document, step=operation)
        )
    document = fixture_document(dataset)
    values = fixture_values(dataset)
    design = document["design"]
    module = next(row for row in design["modules"] if row["id"] == values["module_sandbox_id"])
    department = next(
        row for row in design["departments"] if row["id"] == values["department_sandbox_id"]
    )
    verb, kind = operation.split("_")
    if kind != "field":
        module["fields"] = [
            row for row in module["fields"] if row["id"] != values["field_sandbox_id"]
        ]
    if kind == "department":
        design["modules"].remove(module)
        design["layout"].pop(module["id"])
    target = (
        department
        if kind == "department"
        else module
        if kind == "module"
        else next(row for row in module["fields"] if row["id"] == values["field_sandbox_id"])
    )
    target["closed"] = (verb == "close" and after) or (verb == "reopen" and not after)
    if verb == "purge" and after:
        if kind == "field":
            module["fields"].remove(target)
        else:
            design[kind + "s"].remove(target)
            design["layout"].pop(target["id"])
    return document
