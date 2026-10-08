from __future__ import annotations

from dataclasses import replace
from datetime import date
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest

import operations.sample.controls.verification as verification
from operations.sample.client import SampleClient
from operations.sample.controls import access_verification as sample_control_access_verification
from operations.sample.controls import account as sample_control_account
from operations.sample.controls import actions as sample_control_actions
from operations.sample.controls import board_verification as sample_control_board_verification
from operations.sample.controls import openview_verification as sample_control_openview_verification
from operations.sample.controls import sandbox_verification as sample_control_sandbox_verification
from operations.sample.controls.actions import plan_controls
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.plan import phase_action_to_manifest
from operations.sample.scenario import build_dataset
from operations.sample.verification.core import SampleVerificationError

ADMIN_ID = "55555555-5555-4555-8555-555555555555"
MANAGER_ID = "66666666-6666-4666-8666-666666666666"
BOARD_ID = "77777777-7777-4777-8777-777777777777"
REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


def _action(
    *,
    kind: str = "board_controls",
    operation: str = "board_duplicate",
    actor_key: str = "admin",
    status: int = 201,
    values: dict[str, Any] | None = None,
    key: str = "control:board:duplicate",
    target_key: str = "control:duplicate",
) -> PhaseAction:
    return PhaseAction(
        key=key,
        phase="reorganization",
        kind=kind,  # type: ignore[arg-type]
        actor_key=actor_key,
        target_key=target_key,
        values={"operation": operation, **(values or {})},
        expected_status=status,
        expected_detail=None,
        expected_end_state={"completed": True},
    )


def _request_evidence(
    *,
    request_id: str = REQUEST_ID,
    actor_key: str = "admin",
    actor_id: str = ADMIN_ID,
    method: str = "POST",
    path: str | None = None,
    status: int = 201,
    step: str = "duplicate_board",
) -> dict[str, Any]:
    return {
        "step": step,
        "actor_key": actor_key,
        "actor_id": actor_id,
        "method": method,
        "path": path or f"/api/boards/{BOARD_ID}/duplicate",
        "expected_status": status,
        "status_code": status,
        "request_id": request_id,
    }


def _result(action: PhaseAction, evidence: list[dict[str, Any]]) -> dict[str, Any]:
    actor_id = ADMIN_ID if action.actor_key == "admin" else MANAGER_ID
    return {
        "action_key": action.key,
        "actor_key": action.actor_key,
        "actor_id": actor_id,
        "target_key": action.target_key,
        "outcome": "completed",
        "request_evidence": evidence,
        "mappings": [],
    }


def _manifest(action: PhaseAction, evidence: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "control_plan": [phase_action_to_manifest(action)],
        "control_results": [_result(action, evidence)],
        "actor_ids": {"internal_finance_lead": MANAGER_ID},
        "mappings": {},
    }


def _patch_plan_and_final_verifiers(monkeypatch, action: PhaseAction) -> set[str]:
    monkeypatch.setattr(sample_control_actions, "plan_controls", lambda _dataset: (action,))
    called: set[str] = set()
    verifiers = (
        (sample_control_board_verification, "verify_board_controls"),
        (sample_control_account, "verify_account_controls"),
        (sample_control_openview_verification, "verify_openview_controls"),
        (sample_control_access_verification, "verify_access_controls"),
        (sample_control_sandbox_verification, "verify_sandbox_controls"),
    )
    for index, (module, name) in enumerate(verifiers):

        def verify(*_args, _index=index, _name=name, **_kwargs):
            called.add(_name)
            return {f"family_{_index}": 1}, []

        monkeypatch.setattr(module, name, verify)
    return called


def _verify(
    tmp_path: Path,
    manifest: dict[str, Any],
    dataset=None,
):
    def handle(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected request verification readback: {request.url.path}")

    dataset = dataset or build_dataset("small", seed=83, anchor_date=date(2026, 10, 2))
    with SampleClient(
        "https://sample.test",
        "https://workspace.test",
        tmp_path / "verification-requests.jsonl",
        transport=httpx.MockTransport(handle),
    ) as client:
        return verification.verify_controls(client, dataset, manifest, admin_id=ADMIN_ID)


def test_control_verifier_checks_request_and_all_final_families(
    tmp_path: Path, monkeypatch
) -> None:
    action = _action()
    called = _patch_plan_and_final_verifiers(monkeypatch, action)
    evidence = _request_evidence()
    manifest = _manifest(action, [evidence])
    counts, issues = _verify(tmp_path, manifest)

    assert issues == []
    assert counts["control_requests_verified"] == 1
    assert called == {
        "verify_board_controls",
        "verify_account_controls",
        "verify_openview_controls",
        "verify_access_controls",
        "verify_sandbox_controls",
    }
    assert all(counts[f"family_{index}"] == 1 for index in range(5))


@pytest.mark.parametrize(
    "fault",
    (
        "none",
        "missing_step",
        "reordered",
        "wrong_actor",
        "request_reuse",
        "bad_status",
        "foreign_path",
        "missing_mapping",
        "extra_mapping",
        "read_checks",
        "end_state",
        "unrestored_theme",
        "malformed_final_appearance",
        "record_remaining",
        "mapping_receipt",
        "search_step",
        "search_count",
        "search_read_checks",
    ),
)
def test_platform_verification_requires_exact_requests_and_restored_state(
    tmp_path, monkeypatch, fault
):
    import operations.sample.controls.openview_purge as frozen_helpers
    from operations.sample.controls.actions import execute_control_action
    from tests.operations.sample.controls.sample_platform_wire import PlatformWire
    from tests.operations.sample.controls.test_sample_control_sandbox import _context

    monkeypatch.setattr(frozen_helpers, "_PURGE_POLL_SECONDS", 0)
    dataset = build_dataset("small", seed=83, anchor_date=date(2026, 10, 2))
    wire = PlatformWire(dataset)
    context = _context(tmp_path, wire.handle)
    wire.bind(context)
    from operations.sample.controls.platform import OPERATIONS

    actions = tuple(row for row in plan_controls(dataset) if row.values["operation"] in OPERATIONS)
    setup = next(
        row
        for row in plan_controls(dataset)
        if row.values["operation"] == "prepare_lifecycle_bindings"
    )
    try:
        execute_control_action(setup, dataset, context)
        results = [execute_control_action(row, dataset, context) for row in actions]
        _patch_plan_and_final_verifiers(monkeypatch, actions[0])
        monkeypatch.setattr(sample_control_actions, "plan_controls", lambda _: actions)
        manifest = {
            "control_plan": [phase_action_to_manifest(row) for row in actions],
            "control_results": results,
            "mappings": context.runtime_mappings,
            "actor_ids": {},
        }
        evidence = results[0]["request_evidence"]
        if fault == "search_step":
            results[1]["request_evidence"][-1]["step"] = "search_event_page_20"
        if fault == "search_count":
            results[1]["search_pages"]["event"] = 101
        if fault == "search_read_checks":
            results[1]["read_checks"] = 9
        if fault == "missing_step":
            evidence.pop()
        if fault == "reordered":
            evidence.reverse()
        if fault == "wrong_actor":
            evidence[0]["actor_id"] = MANAGER_ID
        if fault == "request_reuse":
            evidence[1]["request_id"] = evidence[0]["request_id"]
        if fault == "bad_status":
            evidence[0]["status_code"] = 503
        if fault == "foreign_path":
            evidence[-1]["path"] = f"/api/records/{BOARD_ID}"
        if fault == "missing_mapping":
            manifest["mappings"]["platform_records"].pop("opening_review")
        if fault == "extra_mapping":
            manifest["mappings"]["platform_records"]["unexpected"] = BOARD_ID
        if fault == "read_checks":
            results[0]["read_checks"] = 0
        if fault == "end_state":
            results[2]["records_purged"] = False
        if fault == "mapping_receipt":
            results[0]["mappings"][0]["server_id"] = BOARD_ID
        if fault == "unrestored_theme":
            wire.theme = "light"
        if fault == "malformed_final_appearance":
            wire.appearance["keyboard_shortcuts"] = 0
        if fault == "record_remaining":
            key = wire.created[0]
            wire.records[key] = {"id": key, "module_id": BOARD_ID, "data": {}, "is_deleted": True}
        counts, issues = verification.verify_controls(
            context.clients["admin"], dataset, manifest, context.user_ids["admin"]
        )
        if fault == "none":
            assert issues == []
            assert results[1]["search_pages"] == dict(record=1, person=1, post=1, event=2)
            assert results[1]["read_checks"] == 10
            assert [
                int(r.url.params["offset"])
                for r in wire.requests
                if r.url.path == "/api/search" and r.url.params["kind"] == "event"
            ] == [0, 10]
            assert counts["platform_records_purged"] == 2 and counts["platform_theme_restored"] == 1
            assert counts["control_requests_verified"] == sum(
                len(row["request_evidence"]) for row in results
            )
        else:
            assert issues
            if fault == "malformed_final_appearance":
                assert "platform_theme_restored" not in counts
    finally:
        context.clients["admin"].close()


@pytest.mark.parametrize(
    ("operation", "tamper"),
    (
        ("audit_export", None),
        ("audit_export", "exported"),
        ("audit_export", "target_label"),
        ("audit_export", "read_checks"),
        ("audit_export", "row_count"),
        ("audit_review", "target_label"),
    ),
)
def test_audit_control_results_require_their_label_and_readback_outcome(
    tmp_path: Path, monkeypatch, operation: str, tamper: str | None
) -> None:
    dataset = build_dataset("small", seed=83, anchor_date=date(2026, 10, 2))
    module = dataset.organization.catalog.modules[0]
    end_state = {
        "exported" if operation == "audit_export" else "reviewed": True,
        "target_label": module.name,
        "read_checks": 2 if operation == "audit_export" else 3,
    }
    action = replace(
        _action(
            kind="audit_controls",
            operation=operation,
            status=200,
            key=f"control:{operation}",
            target_key=module.key,
            values={"expected_label": module.name},
        ),
        expected_end_state=end_state,
    )
    _patch_plan_and_final_verifiers(monkeypatch, action)
    manifest = _manifest(action, [])
    result = manifest["control_results"][0]
    result.update(end_state)
    if operation == "audit_export":
        result["row_count"] = 12
    else:
        result["audit_id"] = str(uuid4())
    if tamper == "read_checks" or tamper == "row_count":
        result[tamper] = True
    elif tamper is not None:
        result.pop(tamper)
    _counts, issues = _verify(tmp_path, manifest, dataset)
    assert bool(issues) is (tamper is not None)


@pytest.mark.parametrize("tamper", ("plan", "result"))
def test_control_plan_and_result_must_match_the_pack_derived_action(
    tmp_path: Path, monkeypatch, tamper: str
) -> None:
    action = _action()
    _patch_plan_and_final_verifiers(monkeypatch, action)
    manifest = _manifest(action, [_request_evidence()])
    if tamper == "plan":
        manifest["control_plan"][0]["target_key"] = "another-target"
    else:
        manifest["control_results"][0].update(
            actor_key="internal_finance_lead", target_key="other", outcome="failed"
        )

    _counts, issues = _verify(tmp_path, manifest)

    assert any(tamper in issue.lower() for issue in issues)


@pytest.mark.parametrize(
    "mutation",
    ("actor", "method", "path"),
)
def test_control_request_rejects_inconsistent_actor_method_or_path(
    tmp_path: Path, monkeypatch, mutation: str
) -> None:
    action = _action()
    _patch_plan_and_final_verifiers(monkeypatch, action)
    evidence = _request_evidence()
    manifest = _manifest(action, [evidence])
    if mutation == "actor":
        evidence["actor_id"] = MANAGER_ID
    elif mutation == "method":
        evidence["method"] = "GET"
    else:
        evidence["path"] = "/api/unregistered"

    _counts, issues = _verify(tmp_path, manifest)

    assert issues


def test_repeated_record_purge_review_keeps_the_same_step_and_unique_request_ids(
    tmp_path: Path, monkeypatch
) -> None:
    action = _action(kind="openview_controls", operation="relationship_delete", status=200)
    _patch_plan_and_final_verifiers(monkeypatch, action)
    evidence = _request_evidence(
        path=f"/api/records/{BOARD_ID}/purge/preview",
        status=200,
        step="preview_purge_relationship_source",
    )
    manifest = _manifest(action, [evidence, {**evidence, "request_id": str(uuid4())}])

    counts, issues = _verify(tmp_path, manifest)

    assert issues == []
    assert counts["control_requests_verified"] == 2


@pytest.mark.parametrize("request_id", ("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", REQUEST_ID))
def test_control_request_ids_must_be_canonical_and_unique(
    tmp_path: Path, monkeypatch, request_id: str
) -> None:
    action = _action()
    _patch_plan_and_final_verifiers(monkeypatch, action)
    evidence = _request_evidence(request_id=request_id)
    descriptors = [evidence]
    if request_id == REQUEST_ID:
        descriptors.append(
            _request_evidence(
                path=f"/api/boards/{BOARD_ID}/purge/preview",
                status=200,
                step="second_write",
            )
        )
    manifest = _manifest(action, descriptors)

    _counts, issues = _verify(tmp_path, manifest)

    assert any("request" in issue.lower() for issue in issues)


def test_openview_admin_substeps_require_the_admin_actor(tmp_path: Path, monkeypatch) -> None:
    action = _action(
        kind="openview_controls",
        operation="record_lifecycle",
        actor_key="internal_finance_lead",
        status=200,
        values={"admin_steps": ["preview_purge_record"]},
    )
    _patch_plan_and_final_verifiers(monkeypatch, action)
    create_id = str(uuid4())
    create_request = str(uuid4())
    preview_request = str(uuid4())
    evidence = [
        _request_evidence(
            request_id=create_request,
            actor_key=action.actor_key,
            actor_id=MANAGER_ID,
            path="/api/records",
            status=201,
            step="create_control_record",
        ),
        _request_evidence(
            request_id=preview_request,
            actor_key="admin",
            actor_id=ADMIN_ID,
            path=f"/api/records/{create_id}/purge/preview",
            status=200,
            step="preview_purge_record",
        ),
    ]
    manifest = _manifest(action, evidence)
    manifest["control_results"][0]["actor_id"] = MANAGER_ID
    _counts, issues = _verify(tmp_path, manifest)

    assert issues == []


def _configuration_manifest(dataset, restored, existing) -> dict[str, Any]:
    actions = plan_controls(dataset)
    return {
        "control_plan": [phase_action_to_manifest(action) for action in actions],
        "control_results": [
            {
                "action_key": action.key,
                "mappings": [
                    {"kind": "sandbox_control_tests", "logical_id": key, "server_id": value}
                    for key, value in restored.items()
                ],
            }
            for action in actions
            if action.values.get("operation") == "restore_test_history"
        ],
        "mappings": existing,
    }


def test_configuration_mappings_replaces_only_sandbox_test_ids_without_mutating_journal() -> None:
    dataset = build_dataset("small", seed=83, anchor_date=date(2026, 10, 2))
    authored = {vector.key.replace("-", "_") for vector in dataset.test_vectors}
    restored = {key: str(uuid4()) for key in sorted(authored)}
    existing = {
        "sandbox_tests": {key: str(uuid4()) for key in authored},
        "records": {"record-1": str(uuid4())},
        "sandbox_control_tests": {"preserve": "also-preserved"},
    }

    manifest = _configuration_manifest(dataset, restored, existing)

    projected = verification.configuration_mappings(manifest, dataset)

    assert projected == {**existing, "sandbox_tests": restored}
    assert manifest["mappings"] == existing


@pytest.mark.parametrize("bad_mapping", ("missing", "duplicate_id"))
def test_configuration_mappings_reject_incomplete_or_ambiguous_control_tests(
    bad_mapping: str,
) -> None:
    dataset = build_dataset("small", seed=83, anchor_date=date(2026, 10, 2))
    authored = sorted(vector.key.replace("-", "_") for vector in dataset.test_vectors)
    restored = {key: str(uuid4()) for key in authored}
    if bad_mapping == "missing":
        restored.pop(authored[0])
    elif len(authored) > 1:
        restored[authored[1]] = restored[authored[0]]
    manifest = _configuration_manifest(
        dataset,
        restored,
        {"sandbox_tests": {key: str(uuid4()) for key in authored}},
    )

    with pytest.raises(SampleVerificationError):
        verification.configuration_mappings(manifest, dataset)
