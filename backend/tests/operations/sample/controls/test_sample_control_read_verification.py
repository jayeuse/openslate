from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest

import operations.sample.controls.access_verification as access_verification
import operations.sample.controls.account as account_verification
import operations.sample.controls.actions as control_actions
import operations.sample.controls.board_verification as board_verification
import operations.sample.controls.openview_verification as openview_verification
import operations.sample.controls.sandbox_verification as sandbox_verification
import operations.sample.controls.verification as verification
from operations.sample.client import SampleClient
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.plan import phase_action_to_manifest
from operations.sample.scenario import build_dataset

ADMIN_ID = "55555555-5555-4555-8555-555555555555"
OPERATOR_ID = "0b6f1f5e-2c39-4f4e-9d0a-0c2bb1f6a1d4"
TARGET_ID = "66666666-6666-4666-8666-666666666666"
REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
READ_COUNTS = {
    "review_view_fields": 4,
    "review_report_run": 2,
    "review_board_tools": 9,
    "review_my_events": 1,
    "review_member_candidates": 1,
}


def _case(operation: str, *, target_key: str | None = None):
    dataset = build_dataset("small", seed=83, anchor_date=date(2026, 10, 2))
    if operation == "revoke_user_sessions" and target_key is None:
        from operations.sample.controls.reads import plan_read_controls

        target_key = next(
            action.target_key
            for action in plan_read_controls(dataset)
            if action.values.get("operation") == "revoke_user_sessions"
        )
    target_key = target_key or "review_target"
    action = PhaseAction(
        key="control:revoke-user-sessions"
        if operation == "revoke_user_sessions"
        else f"control:{operation}",
        phase="reorganization",
        kind="read_controls",
        actor_key="admin",
        target_key=target_key,
        values={"operation": operation},
        expected_status=204 if operation == "revoke_user_sessions" else 200,
        expected_detail=None,
        expected_end_state={"sessions_revoked": True}
        if operation == "revoke_user_sessions"
        else {"read_checks": READ_COUNTS[operation]},
    )
    result = {
        "action_key": action.key,
        "actor_key": action.actor_key,
        "actor_id": ADMIN_ID,
        "target_key": action.target_key,
        "outcome": "completed",
        "read_checks": 2 if operation == "revoke_user_sessions" else READ_COUNTS[operation],
        "request_evidence": [],
    }
    if operation == "revoke_user_sessions":
        result["sessions_revoked"] = True
    manifest = {
        "control_plan": [phase_action_to_manifest(action)],
        "control_results": [result],
        "actor_ids": {target_key: TARGET_ID},
        "people": {target_key: {"user_id": TARGET_ID, "role": "member", "status": "active"}},
        "mappings": {"user": {target_key: TARGET_ID}},
    }
    return dataset, action, manifest


def _revoke_descriptor() -> dict[str, Any]:
    return {
        "step": "revoke_user_sessions",
        "actor_key": "admin",
        "actor_id": ADMIN_ID,
        "method": "DELETE",
        "path": f"/api/users/{TARGET_ID}/sessions",
        "expected_status": 204,
        "status_code": 204,
        "request_id": REQUEST_ID,
    }


def _verify(
    tmp_path: Path,
    dataset,
    manifest: dict[str, Any],
):
    def handle(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected request verification readback: {request.url.path}")

    with SampleClient(
        "https://sample.test",
        "https://workspace.test",
        tmp_path / "verification-requests.jsonl",
        transport=httpx.MockTransport(handle),
    ) as client:
        return verification.verify_controls(
            client, dataset, {"operator_id": OPERATOR_ID, **manifest}, ADMIN_ID, operator=client
        )


def _patch(monkeypatch, action: PhaseAction) -> None:
    monkeypatch.setattr(control_actions, "plan_controls", lambda _dataset: (action,))
    for module, name in (
        (board_verification, "verify_board_controls"),
        (account_verification, "verify_account_controls"),
        (openview_verification, "verify_openview_controls"),
        (access_verification, "verify_access_controls"),
        (sandbox_verification, "verify_sandbox_controls"),
    ):
        monkeypatch.setattr(module, name, lambda *_args, **_kwargs: ({}, []))


@pytest.mark.parametrize(("operation", "expected_checks"), READ_COUNTS.items())
def test_get_only_read_control_requires_its_exact_read_check_count(
    tmp_path: Path, monkeypatch, operation: str, expected_checks: int
) -> None:
    dataset, action, manifest = _case(operation)
    _patch(monkeypatch, action)

    _counts, issues = _verify(tmp_path, dataset, manifest)

    assert issues == []
    assert manifest["control_results"][0]["read_checks"] == expected_checks


@pytest.mark.parametrize("read_checks", (3, 5, True))
def test_get_only_read_control_rejects_missing_or_tampered_checks(
    tmp_path: Path, monkeypatch, read_checks: object
) -> None:
    dataset, action, manifest = _case("review_view_fields")
    _patch(monkeypatch, action)
    manifest["control_results"][0]["read_checks"] = read_checks

    _counts, issues = _verify(tmp_path, dataset, manifest)

    assert any("read check" in issue.lower() for issue in issues)


def test_get_only_read_control_requires_an_integer_expected_count(
    tmp_path: Path, monkeypatch
) -> None:
    dataset, action, manifest = _case("review_my_events")
    action.expected_end_state["read_checks"] = True
    _patch(monkeypatch, action)

    _counts, issues = _verify(tmp_path, dataset, manifest)

    assert any("plan" in issue.lower() for issue in issues)


def test_get_only_read_control_rejects_write_evidence(tmp_path: Path, monkeypatch) -> None:
    dataset, action, manifest = _case("review_view_fields")
    _patch(monkeypatch, action)
    manifest["control_results"][0]["request_evidence"] = [{}]

    _counts, issues = _verify(tmp_path, dataset, manifest)

    assert any("request evidence" in issue.lower() for issue in issues)


@pytest.mark.parametrize("mutation", ("path", "status", "query"))
def test_bulk_session_revocation_requires_the_exact_write_descriptor(
    tmp_path: Path, monkeypatch, mutation: str
) -> None:
    dataset, action, manifest = _case("revoke_user_sessions")
    _patch(monkeypatch, action)
    descriptor = _revoke_descriptor()
    if mutation == "path":
        descriptor["path"] += "/"
    elif mutation == "status":
        descriptor["expected_status"] = descriptor["status_code"] = 200
    else:
        descriptor["query"] = {"limit": 1}
    manifest["control_results"][0]["request_evidence"] = [descriptor]

    _counts, issues = _verify(tmp_path, dataset, manifest)

    assert issues


def test_bulk_session_revocation_requires_confirmed_result_state(
    tmp_path: Path, monkeypatch
) -> None:
    dataset, action, manifest = _case("revoke_user_sessions")
    _patch(monkeypatch, action)
    manifest["control_results"][0]["sessions_revoked"] = False
    manifest["control_results"][0]["request_evidence"] = [_revoke_descriptor()]

    _counts, issues = _verify(tmp_path, dataset, manifest)

    assert any("end state" in issue.lower() for issue in issues)


@pytest.mark.parametrize("target", ("account_actor", "phase_actor", "alias"))
def test_bulk_session_revocation_rejects_protected_targets(
    tmp_path: Path, monkeypatch, target: str
) -> None:
    from operations.sample.controls.account import plan_account_controls
    from operations.sample.phases.plan import plan_phases

    dataset = build_dataset("small", seed=83, anchor_date=date(2026, 10, 2))
    if target == "account_actor":
        target_key = plan_account_controls(dataset)[0].actor_key
    elif target == "phase_actor":
        people = {person.key: person for person in dataset.organization.actors.people}
        target_key = next(
            action.actor_key
            for action in plan_phases(dataset)
            if action.actor_key != plan_account_controls(dataset)[0].actor_key
            and people[action.actor_key].role == "member"
            and people[action.actor_key].status == "active"
        )
    else:
        from operations.sample.controls.reads import plan_read_controls

        target_key = plan_read_controls(dataset)[0].target_key
    dataset, action, manifest = _case("revoke_user_sessions", target_key=target_key)
    _patch(monkeypatch, action)
    if target == "alias":
        manifest["actor_ids"]["duplicate_identity"] = manifest["actor_ids"][target_key]

    _counts, issues = _verify(tmp_path, dataset, manifest)

    assert any("eligible mapped member" in issue.lower() for issue in issues)
