from __future__ import annotations

import copy
import json
import re
from dataclasses import replace
from datetime import date

import pytest

from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.designs.validation import validate_document
from operations.sample.actors import planned_access_level
from operations.sample.packs import get_pack
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.plan import (
    phase_action_to_manifest,
    phase_expected_projection,
    phase_version_documents,
    plan_phases,
)
from operations.sample.scenario import build_dataset
from tests.operations.sample.sample_datasets import sample_dataset


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_registry_packs_supply_required_lifecycle_phase_data(pack_key: str) -> None:
    pack = get_pack(pack_key)

    assert getattr(pack, "phases", None) is not None, (
        f"{pack_key} must define the lifecycle and admin targets consumed by the phase planner"
    )


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_seeded_phase_plan_is_complete_json_safe_and_does_not_change_sample_data(
    pack_key: str,
) -> None:
    dataset = sample_dataset(pack=pack_key)
    before = (
        copy.deepcopy(dataset.document),
        dataset.records,
        dataset.edges,
        dataset.test_vectors,
    )

    actions = plan_phases(dataset)
    repeated = plan_phases(dataset)
    serialized = [phase_action_to_manifest(action) for action in actions]

    assert actions == repeated
    assert len({action.key for action in actions}) == len(actions)
    assert all(re.fullmatch(r"[A-Za-z0-9_:-]{1,160}", action.key) for action in actions)
    assert {action.phase for action in actions} == {"admin", "reorganization"}
    kinds = {action.kind for action in actions}
    assert {
        "refuse_role_change",
        "promote_user",
        "remove_group_member",
        "add_group_member",
        "replace_group_access",
        "disable_user",
        "restore_disabled_user",
        "end_session",
        "openview_archive",
        "openview_restore",
        "refuse_board_archive",
        "board_archive",
        "board_restore",
        "board_create_purge_target",
        "board_archive_purge_target",
        "board_purge_preview",
        "board_purge",
        "sandbox_edit_publish",
        "sandbox_close_empty_publish",
        "sandbox_reopen_empty_publish",
        "sandbox_restore_publish",
    } <= kinds
    assert actions.index(next(a for a in actions if a.kind == "end_session")) < next(
        index
        for index, action in enumerate(actions)
        if action.kind in {"openview_archive", "board_archive", "sandbox_edit_publish"}
    )
    json.dumps(serialized, sort_keys=True)
    assert "password" not in json.dumps(serialized).lower()
    assert "previewtoken" not in json.dumps(serialized).lower()

    assert dataset.document == before[0]
    assert dataset.records == before[1]
    assert dataset.edges == before[2]
    assert dataset.test_vectors == before[3]


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_phase_projection_and_version_documents_match_planned_end_state(pack_key: str) -> None:
    dataset = sample_dataset(pack=pack_key)
    actions = plan_phases(dataset)

    projection = phase_expected_projection(actions)
    documents = phase_version_documents(dataset, actions)

    assert set(projection) == {
        "people",
        "membership_additions",
        "membership_removals",
        "group_access",
        "boards",
        "openview",
        "ended_sessions",
        "design",
    }
    promoted = next(action for action in actions if action.kind == "promote_user")
    demoted = next(action for action in actions if action.kind == "demote_user")
    assert demoted.target_key == promoted.target_key
    # The acting administrator returns to member and rejoins every team they left.
    assert projection["people"][promoted.target_key]["role"] == "member"
    assert set(demoted.values["restored_group_keys"]) == set(promoted.values["removed_group_keys"])
    assert all(
        person != promoted.target_key
        for _group, person in (
            *projection["membership_removals"],
            *projection["membership_additions"],
        )
    )
    disabled = next(action for action in actions if action.kind == "restore_disabled_user")
    assert projection["people"][disabled.target_key]["status"] == "active"
    assert len(projection["ended_sessions"]) == 1
    assert sum(board["status"] == "purged" for board in projection["boards"].values()) == 1
    assert all(item["is_deleted"] is False for item in projection["openview"].values())
    assert projection["design"]["final_version_key"] == "phase_design_restored"
    assert projection["design"]["new_module_closed"] is False

    assert set(documents) == {
        "initial_checkpoint",
        "published",
        "control_lifecycle_published",
        "phase_design_edited",
        "phase_design_open",
        "phase_design_closed",
        "phase_design_reopened",
        "phase_before_restore_checkpoint",
        "phase_design_restored",
    }
    assert documents["initial_checkpoint"] == dataset.document
    assert documents["published"] == dataset.document
    assert documents["phase_design_edited"] != dataset.document
    edit = next(action for action in actions if action.kind == "sandbox_edit_publish")
    assert all(
        module["id"] != edit.values["new_module_id"]
        for module in documents["phase_design_edited"]["design"]["modules"]
    )
    assert len(documents["phase_design_edited"]["design"]["modules"]) == len(
        dataset.document["design"]["modules"]
    )
    assert documents["phase_design_open"] == documents["phase_design_reopened"]
    assert documents["phase_design_open"] == documents["phase_before_restore_checkpoint"]
    assert documents["phase_design_open"] == documents["phase_design_restored"]
    for document in documents.values():
        parsed = SandboxDocument.model_validate(document)
        assert validate_document(parsed) == []

    design = dataset.document["design"]
    before_modules = {item["id"]: item for item in design["modules"]}
    final_design = documents["phase_design_restored"]["design"]
    final_modules = {item["id"]: item for item in final_design["modules"]}
    assert set(before_modules) <= set(final_modules)
    assert len(final_modules) == len(before_modules) + 1
    assert len(final_design["relationships"]) == len(design["relationships"])
    assert documents["phase_design_closed"]["design"]["modules"][-1]["closed"] is True
    assert documents["phase_design_reopened"]["design"]["modules"][-1]["closed"] is False
    assert all(final_modules[key]["id"] == module["id"] for key, module in before_modules.items())


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_planned_group_move_does_not_expand_existing_access(pack_key: str) -> None:
    dataset = sample_dataset(pack=pack_key)
    pack = dataset.organization
    move = next(action for action in plan_phases(dataset) if action.kind == "remove_group_member")
    member = next(person for person in pack.actors.people if person.key == move.target_key)
    updated_groups = tuple(
        group for group in member.groups if group != move.values["source_group_key"]
    ) + (str(move.values["destination_group_key"]),)
    updated_member = replace(member, groups=updated_groups)
    updated_people = tuple(
        updated_member if person.key == member.key else person for person in pack.actors.people
    )
    updated_pack = replace(pack, actors=replace(pack.actors, people=updated_people))

    for department in pack.actors.department_keys:
        modules = [
            None,
            *(module.key for module in pack.catalog.modules if module.department == department),
        ]
        for module in modules:
            assert planned_access_level(
                updated_pack, member.key, department, module
            ) <= planned_access_level(pack, member.key, department, module)
    board_levels = {"read": 1, "write": 2, "manage": 3}
    before_board = max(
        (
            board_levels[level]
            for group, level in pack.content.data.project_groups
            if group in member.groups
        ),
        default=1,
    )
    after_board = max(
        (
            board_levels[level]
            for group, level in pack.content.data.project_groups
            if group in updated_member.groups
        ),
        default=1,
    )
    assert after_board <= before_board


def test_phase_action_rejects_unknown_recorded_kind() -> None:
    with pytest.raises(ValueError, match="phase action kind"):
        PhaseAction(
            key="admin.invalid",
            phase="admin",
            kind="unknown",  # type: ignore[arg-type]
            actor_key="admin",
            target_key="person",
            values={},
            expected_status=200,
            expected_detail=None,
            expected_end_state={},
        )


def test_pack_without_phase_data_keeps_the_minimal_offline_contract() -> None:
    pack = replace(get_pack("harbor"), phases=None)
    dataset = build_dataset("small", seed=42, anchor_date=date(2026, 9, 30), organization=pack)

    assert plan_phases(dataset) == ()


@pytest.mark.parametrize(
    ("pack_key", "seed"),
    (("harbor", 9223372036854775808), ("school", 11)),
)
def test_later_phase_actors_have_sessions_after_admin_revocations(pack_key: str, seed: int) -> None:
    dataset = build_dataset(
        "small", seed=seed, anchor_date=date(2026, 9, 30), organization=get_pack(pack_key)
    )
    actions = plan_phases(dataset)
    unavailable = {
        action.target_key for action in actions if action.kind in {"disable_user", "end_session"}
    }
    later_ui_actions = [
        action
        for action in actions
        if action.phase == "reorganization"
        and action.kind
        in {
            "refuse_board_archive",
            "board_archive",
            "board_restore",
            "openview_archive",
            "openview_restore",
        }
    ]

    assert all(action.actor_key not in unavailable for action in later_ui_actions)
    assert all(
        action.actor_key != "admin"
        for action in later_ui_actions
        if action.kind in {"refuse_board_archive", "openview_archive", "openview_restore"}
    )
    board_lifecycle = [
        action for action in later_ui_actions if action.kind in {"board_archive", "board_restore"}
    ]
    assert len(board_lifecycle) == 2
    assert all(action.actor_key == "admin" for action in board_lifecycle)
    assert all(
        action.values["actor_authority"] == "administrator_manager" for action in board_lifecycle
    )


def test_phase_version_documents_follow_recorded_design_values_after_pack_drift() -> None:
    dataset = sample_dataset()
    actions = plan_phases(dataset)
    edit = next(action for action in actions if action.kind == "sandbox_edit_publish")
    assert dataset.organization.phases is not None
    changed_design = replace(
        dataset.organization.phases.design,
        renamed_module_name="Unrecorded module rename",
        text_field_name="Unrecorded field name",
        select_option_label="Unrecorded option",
        new_module_key="unrecorded_checklist",
        new_module_name="Unrecorded checklist",
        new_module_department_key="field",
        new_module_title_field_name="Unrecorded title",
    )
    changed_phases = replace(dataset.organization.phases, design=changed_design)
    changed_pack = replace(dataset.organization, phases=changed_phases)
    changed_dataset = replace(dataset, organization=changed_pack)

    documents = phase_version_documents(changed_dataset, actions)
    edited_modules = documents["phase_design_edited"]["design"]["modules"]
    open_modules = documents["phase_design_open"]["design"]["modules"]
    renamed = next(module for module in edited_modules if module["id"] == edit.values["module_id"])
    new_module = next(
        module for module in open_modules if module["id"] == edit.values["new_module_id"]
    )
    added_field = next(
        field
        for module in edited_modules
        for field in module["fields"]
        if field["id"] == edit.values["added_field_id"]
    )

    assert renamed["name"] == edit.values["renamed_module_name"]
    assert added_field["name"] == edit.values["added_field_name"]
    assert new_module["name"] == edit.values["new_module_name"]
    assert new_module["departmentId"] == edit.values["new_module_department_id"]
