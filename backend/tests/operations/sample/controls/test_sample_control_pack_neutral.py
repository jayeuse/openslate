"""New run planning follows pack data rather than recognized pack keys."""

from __future__ import annotations

import ast
from dataclasses import asdict, replace
from datetime import date
from pathlib import Path
from typing import get_args

import pytest

import operations as operations_package
from app.systems.sandbox.designs.schemas import SandboxBindingResponse
from operations.sample.controls.actions import plan_controls
from operations.sample.packs.registry import get_pack
from operations.sample.phases.expectations import read_phase_plan
from operations.sample.scenario import build_dataset

REFERENCE_PACKS = ("harbor", "school")


@pytest.mark.parametrize("pack_key", REFERENCE_PACKS)
def test_small_control_planning_uses_supplied_data_even_with_an_unknown_pack_key(
    pack_key: str,
) -> None:
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack(pack_key))
    actions = plan_controls(dataset)
    assert {
        "openview_controls",
        "board_controls",
        "access_controls",
        "sandbox_controls",
        "account_controls",
        "comms_controls",
        "audit_controls",
        "read_controls",
        "manage_controls",
    } <= {action.kind for action in actions}, "Every control family must be planned offline"
    assert len({action.key for action in actions}) == len(actions)
    account_positions = [i for i, row in enumerate(actions) if row.kind == "account_controls"]
    comms_positions = [i for i, row in enumerate(actions) if row.kind == "comms_controls"]
    assert account_positions and comms_positions
    assert max(account_positions) < min(comms_positions), (
        "Partner Comms must follow the account's real partner-membership admission"
    )
    lifecycle = [
        action
        for action in actions
        if action.kind == "sandbox_controls"
        and action.values["operation"]
        in {
            "prepare_lifecycle_bindings",
            "close_field",
            "reopen_field",
            "purge_field",
            "close_module",
            "reopen_module",
            "purge_module",
            "close_department",
            "reopen_department",
            "purge_department",
        }
    ]
    assert len(lifecycle) == 10
    spec = dataset.organization.phases.design
    assert all(
        action.actor_key == "admin"
        and action.values["module_name"] == spec.new_module_name
        and action.values["field_name"] == spec.text_field_name
        and action.values["department_name"]
        == f"{dataset.organization.identity.workspace_name} structure review"
        and action.values["department_sandbox_id"] not in dataset.department_ids.values()
        for action in lifecycle
    )
    audit = [action for action in actions if action.kind == "audit_controls"]
    assert [action.values["operation"] for action in audit] == ["audit_review", "audit_export"]
    modules = {module.key: module for module in dataset.organization.catalog.modules}
    assert len({action.target_key for action in audit}) == 1
    assert all(
        action.actor_key == "admin"
        and action.target_key in modules
        and action.values["expected_label"] == modules[action.target_key].name
        for action in audit
    )
    manage = [action for action in actions if action.kind == "manage_controls"]
    assert {action.values["operation"] for action in manage} == {
        "review_admin_sessions",
        "revoke_admin_sessions",
        "review_workspace_security",
        "update_workspace_security",
        "review_mfa_status",
    }
    bulk = next(
        action for action in manage if action.values["operation"] == "revoke_admin_sessions"
    )
    required = {
        "real_mfa_reset",
        "generic_record_file",
        "generic_library_file",
        "workspace_logo_files",
        "review_people_security",
        "review_workspace_appearance",
        "review_notifications",
    }
    operations = [action.values["operation"] for action in actions]
    assert required <= set(operations), "Every implemented control must enter the real run plan"
    # The host backup step joins the plan only for host acceptance runs.
    assert "physical_backup_export" not in operations
    assert all(operations.count(operation) == 1 for operation in required)
    assert operations.index("self_service_security") < operations.index("real_mfa_reset")
    assert operations.index("real_mfa_reset") < operations.index("review_people_security")
    assert all(
        operations.index(operation) < operations.index("review_backup_status")
        for operation in (
            "review_people_security",
            "generic_record_file",
            "generic_library_file",
            "workspace_logo_files",
        )
    ), "Mail-dependent and file controls must finish before host backup work"
    host_operations = [
        action.values["operation"]
        for action in plan_controls(replace(dataset, host_acceptance=True))
    ]
    assert host_operations.index("workspace_logo_files") < host_operations.index(
        "physical_backup_export"
    )
    assert host_operations.index("physical_backup_export") < host_operations.index("queue_backup")
    assert actions[-3] == bulk
    assert actions[-2].values["operation"] == "review_notifications"
    assert actions[-1].values["operation"] == "revoke_user_sessions"
    actors = {person.key for person in dataset.organization.actors.people} | {"admin"}
    assert all(action.actor_key in actors for action in actions)
    assert read_phase_plan({"phase_plan": [asdict(action) for action in actions]}) == actions
    unknown_pack = replace(
        dataset.organization,
        identity=replace(dataset.organization.identity, key="unrecognized-reference-pack"),
    )
    probe = plan_controls(replace(dataset, organization=unknown_pack))
    assert [asdict(action) for action in probe] == [asdict(action) for action in actions]


def test_generic_control_planners_contain_no_fixed_pack_module_or_department_keys() -> None:
    packs = [get_pack(key) for key in REFERENCE_PACKS]
    forbidden = set(REFERENCE_PACKS)
    forbidden.update(module.key for pack in packs for module in pack.catalog.modules)
    forbidden.update(key for pack in packs for key, _ in pack.catalog.departments)
    # Required API binding kinds may coincide with catalog keys; only the
    # actual backend schema defines this wire-vocabulary exception.
    forbidden.difference_update(get_args(SandboxBindingResponse.model_fields["kind"].annotation))
    engine = Path(operations_package.__file__).resolve().parent / "sample"
    paths = sorted(path for path in engine.rglob("*.py") if "packs" not in path.parts)
    assert len(paths) > 50, "the generic sample engine was not found"
    violations = []
    for path in paths:
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and node.value in forbidden
            ):
                violations.append(f"{path.name}:{node.lineno}: {node.value}")
    assert not violations, f"Pack-specific keys in generic control code: {violations}"
