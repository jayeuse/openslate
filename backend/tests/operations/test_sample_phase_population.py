"""Offline phase orchestration must persist progress and stop at a failed write."""

import copy
from datetime import date

import pytest

from operations import sample_phase_population as workflow
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_packs.registry import get_pack
from operations.sample_phase_actions import SamplePhaseActionError
from operations.sample_phases import phase_action_to_manifest, plan_phases
from operations.sample_scenario import build_dataset
from operations.sample_verification import failure_report
from operations.seed_sample_data import build_plan_summary


def test_control_journeys_run_before_admin_phases_and_save_separate_evidence(monkeypatch):
    dataset = build_dataset("small", 42, date(2026, 9, 30))
    control = PhaseAction(
        key="control:records_query",
        phase="reorganization",
        kind="openview_controls",
        actor_key="admin",
        target_key="control:query",
        values={"operation": "records_query"},
        expected_status=200,
        expected_detail=None,
        expected_end_state={},
    )
    phase = plan_phases(dataset)[0]
    manifest = {
        "control_plan": [phase_action_to_manifest(control)],
        "control_results": [],
        "phase_plan": [phase_action_to_manifest(phase)],
        "phase_results": [],
    }
    executed, snapshots = [], []

    def execute(action, actual_dataset, context, *, on_substep):
        assert actual_dataset is dataset
        on_substep("readback")
        assert snapshots[-1]["step"] == f"{action.key}:readback"
        executed.append(action.key)
        return {"action_key": action.key, "request_evidence": []}

    monkeypatch.setattr(workflow, "execute_phase_action", execute)
    observed = workflow.run_population_phases(
        dataset,
        manifest,
        clients={},
        user_ids={},
        group_ids={},
        admin_password="fixture-memory-only",
        save=lambda: snapshots.append(copy.deepcopy(manifest)),
        mappings=lambda: {},
    )
    assert executed == [control.key, phase.key]
    assert [row["action_key"] for row in manifest["control_results"]] == [control.key]
    assert [row["action_key"] for row in manifest["phase_results"]] == [phase.key]
    assert observed["control_actions_executed"] == 1
    assert observed["phase_actions_executed"] == 1
    assert "fixture-memory-only" not in str(snapshots)


@pytest.mark.parametrize("fail_second", (False, True))
def test_phase_progress_is_saved_before_each_substep_and_never_continues_after_failure(
    monkeypatch, fail_second
):
    dataset = build_dataset("small", 42, date(2026, 9, 30))
    actions = plan_phases(dataset)[:2]
    manifest = {
        "phase_plan": [phase_action_to_manifest(action) for action in actions],
        "phase_results": [],
    }
    snapshots = []
    calls = []
    initial = {
        "departments": dataset.department_ids,
        "modules": dataset.module_ids,
        "fields": {
            f"{module}:{field}": uid
            for module, fields in dataset.field_ids.items()
            for field, uid in fields.items()
        },
    }

    def execute(action, actual_dataset, context, *, on_substep):
        assert actual_dataset is dataset
        assert snapshots[-1]["step"] == action.key
        calls.append(action.key)
        on_substep("update_user")
        assert snapshots[-1]["step"] == f"{action.key}:update_user"
        if fail_second and len(calls) == 2:
            raise SamplePhaseActionError("Planned phase request failed", step="update_user")
        return {"key": action.key, "actor_key": action.actor_key, "request_evidence": []}

    monkeypatch.setattr(workflow, "execute_phase_action", execute)
    kwargs = dict(
        clients={},
        user_ids={},
        group_ids={},
        admin_password="in-memory-value",
        save=lambda: snapshots.append(copy.deepcopy(manifest)),
        mappings=lambda: copy.deepcopy(initial),
    )
    if fail_second:
        with pytest.raises(SamplePhaseActionError):
            workflow.run_population_phases(dataset, manifest, **kwargs)
        assert len(manifest["phase_results"]) == 1
    else:
        observed = workflow.run_population_phases(dataset, manifest, **kwargs)
        assert observed["phase_actions_executed"] == 2
        assert len(manifest["phase_results"]) == 2
    assert calls == [action.key for action in actions]
    assert manifest["phase_plan"] == [phase_action_to_manifest(action) for action in actions]
    assert all("in-memory-value" not in str(snapshot) for snapshot in snapshots)


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_offline_summary_includes_recorded_phase_actors_targets_and_refusals(pack_key):
    dataset = build_dataset("small", 42, date(2026, 9, 30), organization=get_pack(pack_key))
    summary = build_plan_summary(dataset)
    assert summary["phase_plan"] == [
        phase_action_to_manifest(action) for action in plan_phases(dataset)
    ]
    assert summary["phase_counts"]["admin"] > 0
    assert summary["phase_counts"]["reorganization"] > 0
    assert summary["phase_counts"]["refusals"] == 2


def test_phase_stop_retains_safe_operator_detail_and_request_identifier():
    request_id = "c2b3645a-cc4c-4e8e-a468-3d94ed44627c"
    error = SamplePhaseActionError(
        "Planned Board purge preview failed",
        step="preview_board_purge",
        status_code=409,
        request_id=request_id,
    )
    report = failure_report(
        "reorganization", error, step="reorganization:purge:preview_board_purge"
    )
    assert report["message"] == "Planned Board purge preview failed"
    assert report["request_id"] == request_id
    assert report["status_code"] == "409"
