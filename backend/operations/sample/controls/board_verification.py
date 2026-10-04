"""Read-only request outcomes and final-state reconciliation for Board controls."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.expectations import read_phase_plan
from operations.sample.population.boards import project_board_logical_id
from operations.sample.verification.core import SampleVerificationError


def _planned_controls(manifest: Mapping[str, Any]) -> tuple[PhaseAction, ...]:
    actions = read_phase_plan({"phase_plan": manifest.get("control_plan", [])})
    return tuple(action for action in actions if action.kind == "board_controls")


def _purged(admin: SampleClient, board_id: str, issues: list[str]) -> bool:
    try:
        response = admin.request("GET", f"/api/boards/{board_id}")
    except SampleClientError:
        issues.append("Temporary Board final-state readback failed")
        return False
    if response.status_code != 404:
        issues.append("A temporary Board remains after its planned purge")
        return False
    return True


def verify_board_controls(
    admin: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    *,
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    """Check recorded request outcomes, temporary Board purges, and the source Board."""
    observed = {"board_control_actions": 0, "board_control_requests": 0}
    issues: list[str] = []
    try:
        actions = _planned_controls(manifest)
    except (SampleVerificationError, TypeError, ValueError):
        return observed, ["Board control plan is invalid"]
    raw_results = manifest.get("control_results")
    if not isinstance(raw_results, list) or any(
        not isinstance(row, Mapping) for row in raw_results
    ):
        return observed, ["Board control results are missing or invalid"]
    keys = {action.key for action in actions}
    results = [row for row in raw_results if row.get("action_key") in keys]
    if [row.get("action_key") for row in results] != [action.key for action in actions]:
        issues.append("Board control result order differs from its plan")
    by_key = {str(row.get("action_key")): row for row in results}
    actors = manifest.get("actor_ids")
    if not isinstance(actors, Mapping):
        actors = {}
    for action in actions:
        result = by_key.get(action.key)
        if result is None:
            issues.append("A planned Board control has no result")
            continue
        observed["board_control_actions"] += 1
        evidence = result.get("request_evidence")
        if not isinstance(evidence, list) or not evidence:
            issues.append("A Board control result has no request evidence")
            continue
        actor_id = admin_id if action.actor_key == "admin" else actors.get(action.actor_key)
        for item in evidence:
            if not isinstance(item, Mapping):
                issues.append("A Board control request descriptor is invalid")
                continue
            observed["board_control_requests"] += 1
            request_id = item.get("request_id")
            if (
                item.get("actor_key") != action.actor_key
                or item.get("actor_id") != actor_id
                or not isinstance(request_id, str)
                or item.get("status_code") != item.get("expected_status")
                or item.get("expected_status") != action.expected_status
            ):
                issues.append("A Board control request differs from its planned actor or result")
                continue
            try:
                UUID(request_id)
            except ValueError:
                issues.append("A Board control request ID is invalid")
                continue
    mappings = manifest.get("mappings")
    board_mappings = mappings.get("control_boards") if isinstance(mappings, Mapping) else None
    if not isinstance(board_mappings, Mapping):
        issues.append("Board control Board mappings are missing")
        board_mappings = {}
    for key in ("control:duplicate", "control:import"):
        try:
            board_id = str(UUID(str(board_mappings.get(key))))
        except (TypeError, ValueError):
            issues.append("A temporary Board mapping is invalid")
            continue
        if _purged(admin, board_id, issues):
            observed["board_control_boards_purged"] = (
                observed.get("board_control_boards_purged", 0) + 1
            )

    phase = dataset.organization.phases
    source_mappings = mappings.get("boards") if isinstance(mappings, Mapping) else None
    if phase is not None and isinstance(source_mappings, Mapping):
        name, department = phase.existing_project_board
        source_id = source_mappings.get(project_board_logical_id(department, name))
        try:
            source_uuid = str(UUID(str(source_id)))
            response = admin.request("GET", f"/api/boards/{source_uuid}")
            source = response.json() if response.status_code == 200 else None
        except (SampleClientError, ValueError):
            source = None
        if (
            not isinstance(source, Mapping)
            or source.get("id") != source_uuid
            or (source.get("name") != name or source.get("status") != "active")
        ):
            issues.append("The authored source Board changed during the control run")
    return observed, issues
