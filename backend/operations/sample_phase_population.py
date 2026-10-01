"""Persist phase progress around the post-content API action executor."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from operations.sample_blueprint import SampleDataset
from operations.sample_client import SampleClient
from operations.sample_phase_actions import PhaseExecutionContext, execute_phase_action
from operations.sample_phase_expectations import read_phase_plan
from operations.sample_population import SamplePopulationError


def run_population_phases(
    dataset: SampleDataset,
    manifest: dict[str, Any],
    *,
    clients: Mapping[str, SampleClient],
    user_ids: Mapping[str, str],
    group_ids: Mapping[str, str],
    admin_password: str,
    save: Callable[[], None],
    mappings: Callable[[], dict[str, dict[str, str]]],
) -> dict[str, int]:
    """Execute only recorded actions after all ordinary activity has finished."""
    actions = read_phase_plan(manifest)
    if not actions:
        return {"phase_actions_executed": 0, "phase_requests_recorded": 0}
    initial = mappings()
    context = PhaseExecutionContext(
        clients=clients,
        user_ids=user_ids,
        group_ids=group_ids,
        department_ids=initial.get("departments", {}),
        module_ids=initial.get("modules", {}),
        field_ids=initial.get("fields", {}),
        mappings=initial,
        admin_password=admin_password,
    )
    results = manifest.setdefault("phase_results", [])
    if results:
        raise SamplePopulationError("Phase actions cannot resume without reconciliation")
    for action in actions:
        manifest["stage"] = action.phase
        manifest["step"] = action.key
        save()

        def substep(step: str, *, action_key: str = action.key) -> None:
            manifest["step"] = f"{action_key}:{step}"
            manifest["mappings"] = mappings()
            save()

        result = execute_phase_action(action, dataset, context, on_substep=substep)
        results.append(result)
        manifest["mappings"] = mappings()
        save()
    return {
        "phase_actions_executed": len(results),
        "phase_requests_recorded": sum(
            len(result.get("request_evidence", [])) for result in results
        ),
    }
