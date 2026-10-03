from __future__ import annotations

from datetime import date
from pathlib import Path

import httpx
import pytest

from operations.sample_blueprint import SampleDataset
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_packs.registry import get_pack
from operations.sample_phase_verification import verify_phases
from operations.sample_phases import phase_action_to_manifest
from operations.sample_scenario import build_dataset
from tests.operations.sample_phase_verification_helpers import (
    ADMIN_ID,
    MEMBER_ID,
    _client,
    _request,
    _request_spec,
    _server_revocation_event,
)

TARGET_ID = "e40862a7-fbb7-4e71-a590-90e11f4e893d"
ORIGINAL_BOARD_ID = "aa29e25d-37b3-497c-9dc8-f6faf03f70ca"
PURGE_BOARD_ID = "e25032b0-4dbe-41c1-bc4e-7e32fa344cf4"
VIEW_ID = "637511d1-65ad-4493-bad2-cb30770aa27d"
DASHBOARD_ID = "c852b64a-2229-4ca8-980f-78b42b0c6f27"
REPORT_ID = "8664784e-69b7-44f7-83c4-9a4b4b31f7f1"
SESSION_ID = "4e540179-0147-4b5a-966e-087770204a41"
MODULE_ID = "e8ea3068-2084-4c6f-9a60-e35871e15db7"
VERSION_ID = "ee2c6f72-4c67-4dbe-8d71-7e2aa15e89e8"


@pytest.fixture
def dataset() -> SampleDataset:
    return build_dataset("small", 42, date(2026, 9, 30), organization=get_pack("harbor"))


def _action(
    key: str,
    kind: str,
    target: str,
    actor: str = "admin",
    values: dict[str, object] | None = None,
    status: int = 200,
) -> PhaseAction:
    return PhaseAction(
        key=key,
        phase="admin" if key.startswith("admin:") else "reorganization",
        kind=kind,  # type: ignore[arg-type]
        actor_key=actor,
        target_key=target,
        values=values or {},  # type: ignore[arg-type]
        expected_status=status,
        expected_detail="Forbidden" if status == 403 else None,
        expected_end_state={},
    )


def _result(
    action: PhaseAction,
    requests: list[dict[str, object]],
    **extra: object,
) -> dict[str, object]:
    return {
        "action_key": action.key,
        "actor_key": action.actor_key,
        "actor_id": ADMIN_ID if action.actor_key == "admin" else MEMBER_ID,
        "target_key": action.target_key,
        "request_evidence": requests,
        "mappings": [],
        **extra,
    }


def _manifest(
    actions: list[PhaseAction],
    results: list[dict[str, object]],
    mappings: dict[str, dict[str, str]] | None = None,
) -> dict[str, object]:
    return {
        "phase_plan": [phase_action_to_manifest(action) for action in actions],
        "phase_results": results,
        "actor_ids": {"admin": ADMIN_ID, "member": MEMBER_ID, "manager": MEMBER_ID},
        "people": {"member": {"user_id": TARGET_ID}},
        "mappings": mappings or {},
    }


@pytest.mark.parametrize(
    "audit_fault",
    ("missing", "duplicate", "actor", "route", "missing_actor", "refusal", "refusal_audit"),
)
def test_planned_user_write_rejects_missing_or_incoherent_audit_rows(
    tmp_path: Path, dataset: SampleDataset, audit_fault: str
) -> None:
    refusal = audit_fault in {"refusal", "refusal_audit"}
    action = _action(
        "admin:refuse_role_change" if refusal else "admin:promote_user",
        "refuse_role_change" if refusal else "promote_user",
        "member",
        actor="manager"
        if audit_fault in {"missing_actor", "refusal", "refusal_audit"}
        else "admin",
        values={"role": "admin"},
        status=403 if refusal else 200,
    )
    evidence, correct_rows = _request(
        action,
        "update_user",
        "PATCH",
        f"/api/users/{TARGET_ID}",
        status=403 if refusal else None,
        entity="users",
        entity_id=TARGET_ID,
        audit="update" if audit_fault == "refusal_audit" else None if refusal else "update",
        audit_count=1 if audit_fault == "refusal_audit" else 0 if refusal else 1,
        related=[] if refusal else ["groups", "group_members"],
    )
    rows = [] if audit_fault in {"missing", "refusal"} else correct_rows.copy()
    if audit_fault == "duplicate":
        rows.extend(correct_rows)
    if audit_fault == "actor":
        rows.append(
            correct_rows[0]
            | {"entity_type": "group_members", "action": "delete", "performed_by": MEMBER_ID}
        )
    if audit_fault == "route":
        rows[0]["request_path"] = "/api/users/a-different-user"
    if audit_fault == "missing_actor":
        evidence["actor_id"] = None
        rows[0]["performed_by"] = None
    if refusal:
        evidence.update(
            primary_entity_type=None,
            primary_entity_id=None,
            primary_action=None,
            expected_audit_rows=0,
        )
    if audit_fault == "missing":
        evidence["expected_audit_rows"] = 0
    result = _result(action, requests=[evidence])
    if audit_fault == "missing_actor":
        result["actor_id"] = None
    manifest = _manifest([action], [result])
    if audit_fault == "missing_actor":
        manifest["actor_ids"] = {"admin": ADMIN_ID}

    with _client(tmp_path, {str(evidence["request_id"]): rows}) as client:
        observed, issues = verify_phases(
            client, dataset=dataset, manifest=manifest, admin_id=ADMIN_ID
        )

    if audit_fault == "refusal":
        assert observed["phase_primary_audits"] == 0 and issues == []
    else:
        assert observed.get("phase_primary_audits") == 0 and bool(issues)
    if audit_fault == "missing":
        assert any("planned primary audit" in issue for issue in issues)
    if audit_fault == "refusal_audit":
        assert any("unexpectedly created application audit rows" in issue for issue in issues)
    if audit_fault == "missing_actor":
        assert any(
            "phase request actor differs from the planned actor" in issue for issue in issues
        )


@pytest.mark.parametrize("mapping_conflict", (False, True))
def test_project_board_archive_restore_and_purge_preserve_planned_audits(
    tmp_path: Path, dataset: SampleDataset, mapping_conflict: bool
) -> None:
    actions = [
        _action("reorganization:board_archive", "board_archive", "original-board"),
        _action("reorganization:board_restore", "board_restore", "original-board"),
        _action(
            "reorganization:board_create_purge_target",
            "board_create_purge_target",
            "purge-board",
            status=201,
            values={"scope": "project", "display_name": "Temporary Review Board"},
        ),
        _action(
            "reorganization:board_archive_purge_target",
            "board_archive_purge_target",
            "purge-board",
        ),
        _action(
            "reorganization:board_purge_preview",
            "board_purge_preview",
            "purge-board",
            status=200,
        ),
        _action(
            "reorganization:board_purge",
            "board_purge",
            "purge-board",
            status=200,
        ),
    ]
    steps = (
        ("archive_board", "POST", f"/api/boards/{ORIGINAL_BOARD_ID}/archive", "update", 1),
        ("restore_board", "POST", f"/api/boards/{ORIGINAL_BOARD_ID}/restore", "update", 1),
        ("create_purge_board", "POST", "/api/boards", "create", 1),
        ("archive_purge_board", "POST", f"/api/boards/{PURGE_BOARD_ID}/archive", "update", 1),
        (
            "preview_board_purge",
            "POST",
            f"/api/boards/{PURGE_BOARD_ID}/purge/preview",
            None,
            0,
        ),
        ("purge_board", "POST", f"/api/boards/{PURGE_BOARD_ID}/purge", "delete", 1),
    )
    results = []
    audits: dict[str, list[dict[str, object]]] = {}
    for action, (step, method, path, primary_action, audit_count) in zip(
        actions, steps, strict=True
    ):
        board_id = PURGE_BOARD_ID if action.target_key == "purge-board" else ORIGINAL_BOARD_ID
        evidence, audit_rows = _request(
            action,
            step,
            method,
            path,
            entity="boards" if audit_count else None,
            entity_id=board_id if audit_count else None,
            audit=primary_action,
            audit_count=audit_count,
        )
        result = _result(action, [evidence])
        if action.kind == "board_create_purge_target":
            result["mappings"] = [
                {
                    "kind": "phase_boards",
                    "logical_id": "purge-board",
                    "server_id": ORIGINAL_BOARD_ID if mapping_conflict else PURGE_BOARD_ID,
                }
            ]
        results.append(result)
        if audit_rows:
            audits[str(evidence["request_id"])] = audit_rows
    manifest = _manifest(
        actions,
        results,
        mappings={
            "boards": {"original-board": ORIGINAL_BOARD_ID},
            "phase_boards": {"purge-board": PURGE_BOARD_ID},
        },
    )

    with _client(
        tmp_path,
        audits,
        reads={
            f"/api/boards/{ORIGINAL_BOARD_ID}": {
                "id": ORIGINAL_BOARD_ID,
                "scope": "project",
                "status": "active",
            },
            f"/api/boards/{PURGE_BOARD_ID}": httpx.Response(404),
        },
    ) as client:
        observed, issues = verify_phases(
            client, dataset=dataset, manifest=manifest, admin_id=ADMIN_ID
        )

    if mapping_conflict:
        assert any("phase result mapping differs from the manifest" in issue for issue in issues)
    else:
        assert observed.get("phase_primary_audits") == 5
        assert observed["phase_state_checks"] >= 2
        assert issues == []


def test_openview_items_are_read_back_in_their_planned_resource_kind(
    tmp_path: Path, dataset: SampleDataset
) -> None:
    specs = (("view", VIEW_ID), ("dashboard", DASHBOARD_ID), ("report", REPORT_ID))
    actions = []
    results = []
    audits: dict[str, list[dict[str, object]]] = {}
    mappings: dict[str, dict[str, str]] = {}
    reads: dict[str, object] = {}
    endpoints = {"view": "views", "dashboard": "dashboards", "report": "reports"}
    entities = {"view": "saved_views", "dashboard": "dashboards", "report": "reports"}
    for kind, server_id in specs:
        logical_id = f"department:finance:{kind}:source"
        mappings[endpoints[kind]] = {logical_id: server_id}
        for verb in ("archive", "restore"):
            action = _action(
                f"reorganization:openview_{verb}_{kind}",
                f"openview_{verb}",
                logical_id,
                actor="manager",
                values={"resource_kind": kind, "department_key": "finance"},
                status=204 if verb == "archive" else 200,
            )
            actions.append(action)
            method = "DELETE" if verb == "archive" else "POST"
            suffix = "" if verb == "archive" else "/restore"
            path = f"/api/{endpoints[kind]}/{server_id}{suffix}"
            evidence, rows = _request(
                action,
                f"{verb}_openview_item",
                method,
                path,
                entity=entities[kind],
                entity_id=server_id,
                audit="delete" if verb == "archive" else "update",
                audit_count=1,
            )
            results.append(_result(action, [evidence]))
            audits[str(evidence["request_id"])] = rows
        body: dict[str, object] = {"id": server_id, "is_deleted": False}
        if kind == "view":
            body["is_default"] = False
        reads[f"/api/{endpoints[kind]}/{server_id}"] = body
    manifest = _manifest(actions, results, mappings=mappings)

    with _client(tmp_path, audits, reads) as client:
        observed, issues = verify_phases(
            client, dataset=dataset, manifest=manifest, admin_id=ADMIN_ID
        )

    assert observed.get("phase_primary_audits") == 6
    assert observed["phase_state_checks"] >= 3
    assert issues == []


def test_session_revocation_and_empty_reopened_module_are_read_back(
    tmp_path: Path, dataset: SampleDataset, monkeypatch: pytest.MonkeyPatch
) -> None:
    actions = [
        _action("admin:disable_user", "disable_user", "member"),
        _action("admin:restore_disabled_user", "restore_disabled_user", "member"),
        _action("admin:end_session", "end_session", "member", status=204),
        _action(
            "reorganization:sandbox_reopen_empty_publish",
            "sandbox_reopen_empty_publish",
            "sandbox:design",
            status=201,
            values={
                "module_key": "review_notes",
                "version_key": "phase_design_reopened",
            },
        ),
    ]
    results: list[dict[str, object]] = []
    audits: dict[str, list[dict[str, object]]] = {}
    security_events = []
    request_sets = [
        (f"update_user|PATCH|/api/users/{TARGET_ID}|200|users|{TARGET_ID}|update|1|admin",),
        (f"update_user|PATCH|/api/users/{TARGET_ID}|200|users|{TARGET_ID}|update|1|admin",),
        (
            f"revoke_user_session|DELETE|/api/users/{TARGET_ID}/sessions/{SESSION_ID}|204||||0|admin",
        ),
        (
            "save_reopened_document|PUT|/api/sandbox/document|200|sandbox_documents||update|1|admin",
            "preview_reopened_document|POST|/api/sandbox/publication-previews|200||||0|admin",
            f"publish_reopened_document|POST|/api/sandbox/publications|201|sandbox_versions|{VERSION_ID}|create|1|admin",
        ),
    ]
    for action, specs in zip(actions, request_sets, strict=True):
        evidence_rows = []
        for spec in specs:
            evidence, rows = _request_spec(action, spec)
            evidence_rows.append(evidence)
            if rows:
                audits[str(evidence["request_id"])] = rows
        result = _result(action, evidence_rows)
        if action.kind == "end_session":
            result["session_id"] = SESSION_ID
            security_events.append(
                _server_revocation_event(
                    monkeypatch,
                    actor_id=ADMIN_ID,
                    person_id=TARGET_ID,
                    session_id=SESSION_ID,
                    request_id=str(evidence_rows[0]["request_id"]),
                )
            )
        results.append(result)
    results[-1]["mappings"] = [
        {"kind": "sandbox_versions", "logical_id": "phase_design_reopened", "server_id": VERSION_ID}
    ]
    manifest = _manifest(
        actions,
        results,
        mappings={
            "modules": {"review_notes": MODULE_ID},
            "sandbox_versions": {"phase_design_reopened": VERSION_ID},
        },
    )

    with _client(
        tmp_path,
        audits,
        reads={
            f"/api/users/{TARGET_ID}/sessions": [],
            f"/api/modules/{MODULE_ID}": {"id": MODULE_ID, "is_deleted": False},
            "/api/records": [],
            "/api/security-events": security_events,
        },
    ) as client:
        observed, issues = verify_phases(
            client, dataset=dataset, manifest=manifest, admin_id=ADMIN_ID
        )

    assert observed.get("phase_primary_audits") == 4
    assert observed["phase_security_events"] == 1
    assert observed["phase_state_checks"] >= 3
    assert issues == []
