"""Public, pack-neutral plan and projection helpers for sample lifecycle phases."""

from __future__ import annotations

import copy
import random
from dataclasses import replace
from typing import TYPE_CHECKING, cast

from operations.sample_boards import project_board_logical_id
from operations.sample_packs.phase_types import (
    PhaseAction,
    PhaseJsonValue,
)
from operations.sample_phase_outputs import (
    phase_expected_projection as phase_expected_projection,
)
from operations.sample_phase_outputs import (
    phase_version_documents as phase_version_documents,
)
from operations.sample_phase_planning import (
    _admin_key,
    _board_level,
    _make_action,
    _manager_key,
    _move_preserves_access,
    _openview_source,
    _replacement_access,
    _sandbox_actions,
)

if TYPE_CHECKING:
    from operations.sample_blueprint import SampleDataset


def plan_phases(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    """Plan the post-content phases without mutating the existing sample dataset."""
    pack = dataset.organization
    spec = pack.phases
    if spec is None:
        return ()
    rng = random.Random(f"{dataset.seed}:phases")
    admin = _admin_key(pack)
    actions: list[PhaseAction] = []

    promotion_candidates = [
        person
        for person in pack.actors.people
        if person.status == "active" and person.role == "member" and person.groups
    ]
    if not promotion_candidates:
        raise ValueError("A phase plan requires an active grouped member to promote")
    promoted = rng.choice(promotion_candidates)
    removed_group_keys = sorted(promoted.groups)

    move_spec = spec.group_move
    if move_spec.source_group_key == move_spec.destination_group_key:
        raise ValueError("Phase group move must use two distinct groups")
    move_candidates = [
        person
        for person in pack.actors.people
        if person.status == "active"
        and person.role in {"member", "guest"}
        and person.key != promoted.key
        and move_spec.source_group_key in person.groups
        and move_spec.destination_group_key not in person.groups
        and _move_preserves_access(
            pack,
            person.key,
            move_spec.source_group_key,
            move_spec.destination_group_key,
        )
    ]
    if not move_candidates:
        raise ValueError("No safe active member fits the pack's non-expanding group move")
    moved = rng.choice(move_candidates)

    status_candidates = [
        person
        for person in pack.actors.people
        if person.status == "active"
        and person.role == "member"
        and person.key not in {promoted.key, moved.key}
    ]
    if not status_candidates:
        raise ValueError(
            "A phase plan requires a separate active user for the disable/restore pair"
        )
    leaver = rng.choice(status_candidates)

    session_candidates = [
        person
        for person in pack.actors.people
        if person.status == "active"
        and person.role == "member"
        and person.key not in {promoted.key, moved.key, leaver.key}
    ]
    if not session_candidates:
        raise ValueError("A phase plan requires a separate active user session target")
    session_person = rng.choice(session_candidates)
    unavailable_after_admin = frozenset({leaver.key, session_person.key})

    refusal_candidates = [
        person
        for person in pack.actors.people
        if person.status == "active" and person.role == "member"
    ]
    if not refusal_candidates:
        raise ValueError("A phase plan requires an active non-admin refusal actor")
    refusal_actor = rng.choice(refusal_candidates)
    actions.append(
        _make_action(
            key="admin:refuse_role_change",
            phase="admin",
            kind="refuse_role_change",
            actor_key=refusal_actor.key,
            target_key=promoted.key,
            values={"role": "admin"},
            expected_status=403,
            expected_detail="Forbidden",
            expected_end_state={"role": "admin"},
        )
    )
    actions.append(
        _make_action(
            key="admin:promote_user",
            phase="admin",
            kind="promote_user",
            actor_key=admin,
            target_key=promoted.key,
            values={
                "role": "admin",
                "removed_group_keys": cast(PhaseJsonValue, removed_group_keys),
            },
            expected_end_state={"role": "admin", "groups": []},
        )
    )
    actions.append(
        _make_action(
            key="admin:remove_group_member",
            phase="admin",
            kind="remove_group_member",
            actor_key=admin,
            target_key=moved.key,
            values={
                "source_group_key": move_spec.source_group_key,
                "destination_group_key": move_spec.destination_group_key,
            },
            expected_end_state={"group_key": move_spec.source_group_key, "member": False},
        )
    )
    actions.append(
        _make_action(
            key="admin:add_group_member",
            phase="admin",
            kind="add_group_member",
            actor_key=admin,
            target_key=moved.key,
            values={
                "source_group_key": move_spec.source_group_key,
                "destination_group_key": move_spec.destination_group_key,
            },
            expected_end_state={"group_key": move_spec.destination_group_key, "member": True},
        )
    )

    old_access = pack.actors.group_access[spec.group_access_change.group_key]
    new_access = _replacement_access(spec.group_access_change, pack)
    before_access = [
        {"department_key": department, "module_key": module, "level": level}
        for department, module, level in old_access
    ]
    after_access = [
        {"department_key": department, "module_key": module, "level": level}
        for department, module, level in new_access
    ]
    actions.append(
        _make_action(
            key="admin:replace_group_access",
            phase="admin",
            kind="replace_group_access",
            actor_key=admin,
            target_key=spec.group_access_change.group_key,
            values={
                "before_access": cast(PhaseJsonValue, before_access),
                "access": cast(PhaseJsonValue, after_access),
            },
            expected_end_state={"access": cast(PhaseJsonValue, after_access)},
        )
    )
    actions.append(
        _make_action(
            key="admin:disable_user",
            phase="admin",
            kind="disable_user",
            actor_key=admin,
            target_key=leaver.key,
            values={"status": "disabled"},
            expected_end_state={"status": "disabled"},
        )
    )
    actions.append(
        _make_action(
            key="admin:restore_disabled_user",
            phase="admin",
            kind="restore_disabled_user",
            actor_key=admin,
            target_key=leaver.key,
            values={"status": "active"},
            expected_end_state={"status": "active"},
        )
    )
    actions.append(
        _make_action(
            key="admin:end_session",
            phase="admin",
            kind="end_session",
            actor_key=admin,
            target_key=session_person.key,
            values={"person_key": session_person.key, "current_session": True},
            expected_status=204,
            expected_end_state={"current_session_active": False},
        )
    )
    # The cover ends: the acting administrator returns to member and rejoins their teams,
    # so the run leaves only the preserved administrator and the guarded reset can clear it.
    actions.append(
        _make_action(
            key="admin:demote_user",
            phase="admin",
            kind="demote_user",
            actor_key=admin,
            target_key=promoted.key,
            values={
                "role": promoted.role,
                "restored_group_keys": cast(PhaseJsonValue, removed_group_keys),
            },
            expected_end_state={"role": promoted.role},
        )
    )
    for group_key in removed_group_keys:
        actions.append(
            _make_action(
                key=f"admin:restore_group_member:{group_key}",
                phase="admin",
                kind="add_group_member",
                actor_key=admin,
                target_key=promoted.key,
                values={"source_group_key": group_key, "destination_group_key": group_key},
                expected_end_state={"group_key": group_key, "member": True},
            )
        )

    final_people = []
    for person in pack.actors.people:
        role = person.role
        status = "active" if person.key == leaver.key else person.status
        groups = person.groups
        if person.key == moved.key:
            groups = tuple(group for group in groups if group != move_spec.source_group_key) + (
                move_spec.destination_group_key,
            )
        final_people.append(replace(person, role=role, status=status, groups=groups))
    final_group_access = dict(pack.actors.group_access)
    final_group_access[spec.group_access_change.group_key] = new_access
    final_pack = replace(
        pack,
        actors=replace(
            pack.actors,
            people=tuple(final_people),
            group_access=final_group_access,
        ),
    )

    project_name, _ = spec.existing_project_board
    if (project_name, spec.existing_project_board[1]) not in pack.content.data.projects:
        raise ValueError("The existing phase Board must be a pack project")
    board_logical_id = project_board_logical_id(
        spec.existing_project_board[1], spec.existing_project_board[0]
    )
    board_department = spec.existing_project_board[1]
    nonmanager_candidates = [
        person
        for person in final_pack.actors.people
        if person.status == "active"
        and person.role in {"member", "guest"}
        and person.key not in unavailable_after_admin
        and 2 <= _board_level(final_pack, person.key, board_department) < 3
    ]
    if not nonmanager_candidates:
        raise ValueError("A phase Board refusal requires an active non-manager with write access")
    board_refuser = rng.choice(nonmanager_candidates)
    actions.append(
        _make_action(
            key="reorganization:refuse_board_archive",
            phase="reorganization",
            kind="refuse_board_archive",
            actor_key=board_refuser.key,
            target_key=board_logical_id,
            values={"scope": "project"},
            expected_status=403,
            expected_detail="Forbidden",
            expected_end_state={"status": "active"},
        )
    )
    actions.append(
        _make_action(
            key="reorganization:board_archive",
            phase="reorganization",
            kind="board_archive",
            actor_key=admin,
            target_key=board_logical_id,
            values={"scope": "project", "actor_authority": "administrator_manager"},
            expected_end_state={"status": "archived"},
        )
    )
    actions.append(
        _make_action(
            key="reorganization:board_restore",
            phase="reorganization",
            kind="board_restore",
            actor_key=admin,
            target_key=board_logical_id,
            values={"scope": "project", "actor_authority": "administrator_manager"},
            expected_end_state={"status": "active"},
        )
    )

    purge_name = spec.purge_project_board_name
    purge_department = spec.purge_project_board_department
    if purge_department not in pack.actors.department_keys:
        raise ValueError("The phase purge Board department is not in the pack")
    if any(name == purge_name for name, _ in pack.content.data.projects):
        raise ValueError("The phase purge Board name must be new to the pack")
    purge_target = project_board_logical_id(purge_department, purge_name)
    purge_display_name = purge_name
    actions.extend(
        (
            _make_action(
                key="reorganization:board_create_purge_target",
                phase="reorganization",
                kind="board_create_purge_target",
                actor_key=admin,
                target_key=purge_target,
                values={
                    "name": purge_name,
                    "display_name": purge_display_name,
                    "description": f"Duplicate review Board for {pack.identity.workspace_name}.",
                    "department_key": purge_department,
                    "scope": "project",
                },
                expected_status=201,
                expected_end_state={"status": "active", "scope": "project"},
            ),
            _make_action(
                key="reorganization:board_archive_purge_target",
                phase="reorganization",
                kind="board_archive_purge_target",
                actor_key=admin,
                target_key=purge_target,
                values={"scope": "project"},
                expected_end_state={"status": "archived"},
            ),
            _make_action(
                key="reorganization:board_purge_preview",
                phase="reorganization",
                kind="board_purge_preview",
                actor_key=admin,
                target_key=purge_target,
                values={},
                expected_end_state={"preview_created": True, "application_audit": False},
            ),
            _make_action(
                key="reorganization:board_purge",
                phase="reorganization",
                kind="board_purge",
                actor_key=admin,
                target_key=purge_target,
                values={},
                expected_end_state={"status": "purged"},
            ),
        )
    )

    openview_departments = [
        department
        for department in spec.openview_department_candidates
        if department in pack.actors.department_keys
        and _manager_key(
            final_pack,
            department,
            _openview_source(pack, department),
            excluded=unavailable_after_admin,
        )
    ]
    if not openview_departments:
        raise ValueError("No configured department can manage a planned OpenView item")
    openview_department = rng.choice(openview_departments)
    openview_module = _openview_source(pack, openview_department)
    module_manager = _manager_key(
        final_pack,
        openview_department,
        openview_module,
        excluded=unavailable_after_admin,
    )
    dashboard_manager = _manager_key(
        final_pack,
        openview_department,
        openview_module,
        department_scope=True,
        excluded=unavailable_after_admin,
    )
    if not module_manager or not dashboard_manager:
        raise ValueError("Planned OpenView item has no available owner or manager")
    layout = pack.content.data.layouts[0]
    openview_targets = (
        (
            "view",
            f"department:{openview_department}:view:{openview_module}:{layout}",
            module_manager,
        ),
        ("dashboard", f"department:{openview_department}:dashboard", dashboard_manager),
        ("report", f"department:{openview_department}:report:01", module_manager),
    )
    for resource_kind, logical_id, actor_key in openview_targets:
        target_values: dict[str, PhaseJsonValue] = {
            "resource_kind": resource_kind,
            "logical_id": logical_id,
            "department_key": openview_department,
            "module_key": openview_module,
        }
        actions.append(
            _make_action(
                key=f"reorganization:openview_archive_{resource_kind}",
                phase="reorganization",
                kind="openview_archive",
                actor_key=actor_key,
                target_key=logical_id,
                values=target_values,
                expected_status=204,
                expected_end_state={"is_deleted": True},
            )
        )
        actions.append(
            _make_action(
                key=f"reorganization:openview_restore_{resource_kind}",
                phase="reorganization",
                kind="openview_restore",
                actor_key=actor_key,
                target_key=logical_id,
                values=target_values,
                expected_end_state={"is_deleted": False},
            )
        )

    actions.extend(_sandbox_actions(dataset))
    return tuple(actions)


def phase_action_to_manifest(action: PhaseAction) -> dict[str, object]:
    """Return the stable plain-data manifest form; runtime secrets never enter actions."""
    return {
        "key": action.key,
        "phase": action.phase,
        "kind": action.kind,
        "actor_key": action.actor_key,
        "target_key": action.target_key,
        "values": copy.deepcopy(action.values),
        "expected_status": action.expected_status,
        "expected_detail": action.expected_detail,
        "expected_end_state": copy.deepcopy(action.expected_end_state),
    }
