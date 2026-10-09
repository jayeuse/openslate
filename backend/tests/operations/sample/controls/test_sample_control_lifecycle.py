"""Bound structural lifecycle within the existing authenticated Sandbox journey."""

from __future__ import annotations

import copy
import json
import re
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleWriteOutcomeUnknown
from operations.sample.controls.actions import plan_controls
from operations.sample.controls.sandbox import (
    CONTROL_ROUTES,
    OPERATIONS,
    execute_sandbox_control,
    plan_sandbox_controls,
    verify_sandbox_controls,
)
from operations.sample.phases.actions import SamplePhaseActionError
from tests.operations.sample.controls.sample_sandbox_control_wire import SandboxControlWire
from tests.operations.sample.controls.test_sample_control_sandbox import (
    ADMIN_ID,
    _context,
    _dataset,
)


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_platform_plan_uses_disposable_structure_and_preserves_lifecycle_order(pack_key):
    dataset = _dataset(pack_key)
    document = copy.deepcopy(dataset.document)
    actions = plan_controls(dataset)
    from operations.sample.controls.platform import OPERATIONS

    platform = [action for action in actions if action.values["operation"] in OPERATIONS]
    # Other control families have their own plan tests; this checks Platform lifecycle order.
    assert [action.values["operation"] for action in platform] == [
        "import_csv_rows",
        "search_workspace",
        "export_and_purge_csv_rows",
        "review_self_theme",
        "toggle_restore_self_theme",
    ]
    operations = [action.values["operation"] for action in actions]
    assert operations.index("prepare_lifecycle_bindings") < operations.index("import_csv_rows")
    assert operations.index("export_and_purge_csv_rows") < operations.index("close_field")
    assert operations.index("toggle_restore_self_theme") < operations.index("revoke_admin_sessions")
    assert all(action.actor_key == "admin" for action in platform)
    assert platform[0].values["module_name"] == dataset.organization.phases.design.new_module_name
    assert platform[0].values["headers"] == [
        dataset.organization.phases.design.new_module_title_field_name,
        dataset.organization.phases.design.text_field_name,
    ]
    assert dataset.document == document


def _route(request: httpx.Request) -> tuple[str, str]:
    path = request.url.path
    if re.fullmatch(r"/api/sandbox/versions/[0-9a-f-]{36}", path):
        path = "/api/sandbox/versions/{version_id}"
    if re.fullmatch(r"/api/sandbox/tests/[0-9a-f-]{36}", path):
        path = "/api/sandbox/tests/{run_id}"
    for resource, parameter in (
        ("fields", "field"),
        ("modules", "module"),
        ("departments", "department"),
        ("boards", "board"),
    ):
        path = re.sub(
            rf"/api/{resource}/[0-9a-f-]{{36}}", f"/api/{resource}/{{{parameter}_id}}", path
        )
    return request.method, path


@pytest.mark.parametrize(
    "pack_key,fault",
    [
        ("school", "none"),
        ("school", "history_export_valid"),
        *(
            ("harbor", fault)
            for fault in (
                "none",
                "history_export_missing",
                "history_export_null",
                "history_export_duplicate",
                "history_export_omitted",
                "history_export_foreign",
                "history_export_order",
                "history_export_label",
                "history_export_note",
                "history_export_published",
                "history_export_date",
                "history_export_invalid_date",
                "history_export_snapshot",
                "history_export_document",
                "history_export_revision_race",
                "history_export_history_race",
                "history_export_503",
                "stale_bindings",
                "duplicate_binding",
                "internal_field_id",
                "wrong_parent",
                "invalid_live_id",
                "missing_binding",
                "alias_binding",
                "bad_snapshot",
                "publication_503",
                "wrong_preview_target",
                "empty_confirmation",
                "preview_blocker",
                "no_document_sync",
                "wrong_revision",
                "live_unsynced",
                "wrong_mutation_actor",
                "purge_disabled",
                "purge_draft_remains",
                "board_page_types",
                "final_history_missing",
                "final_history_actor",
                "final_history_query",
                "final_history_request_id",
                "final_history_body_hash",
                "final_history_body_content",
                "final_binding",
                "final_live",
                "final_board",
                "final_snapshot",
                "final_request",
                "final_document_shape",
                "final_mapping_shape",
            )
        ),
    ],
)
def test_sandbox_controls_use_ui_shapes_and_recreate_exact_test_vectors(
    tmp_path: Path, pack_key: str, fault: str
) -> None:
    dataset = _dataset(pack_key)
    actions = plan_sandbox_controls(dataset)
    wire = SandboxControlWire(dataset, actions, fault)
    context = _context(tmp_path, wire.handle)
    try:
        wire.prepare(context, tmp_path / "requests.jsonl")
        lifecycle, requests = wire.lifecycle, wire.requests
        if fault not in {"none", "history_export_valid"} and not fault.startswith("final_"):
            expected_steps = {
                "bad_snapshot": "read_lifecycle_snapshot",
                "wrong_preview_target": "preview_close_field",
                "empty_confirmation": "preview_close_field",
                "preview_blocker": "preview_close_field",
                "wrong_mutation_actor": "close_field",
                "no_document_sync": "read_after_close_field",
                "wrong_revision": "read_after_close_field",
                "live_unsynced": "bindings_after_close_field",
                "purge_disabled": "preview_purge_field",
                "purge_draft_remains": "read_after_purge_field",
                "board_page_types": "read_lifecycle_department_board",
            }
            with pytest.raises((SamplePhaseActionError, SampleWriteOutcomeUnknown)) as raised:
                for action in actions:
                    wire.begin_action(action)
                    execute_sandbox_control(action, dataset, context)
            if fault.startswith("history_export_"):
                assert raised.value.step == (
                    "export_document_with_history"
                    if fault == "history_export_503"
                    else "history_export_proof"
                )
                assert wire.history_export_calls == 1
                assert not any(
                    request.method == "POST" and request.url.path == "/api/sandbox/imports"
                    for request in requests
                )
                return
            if fault == "publication_503":
                assert raised.value.status_code == 503
                assert requests[-1].url.path == "/api/sandbox/publications"
                journal = (tmp_path / "requests.jsonl").read_text()
                assert '"status_code":503' in journal.replace(" ", "")
                from operations.sample.verification.route_coverage import read_route_evidence

                assert (
                    sum(read_route_evidence(tmp_path / "requests.jsonl")["failures_5xx"].values())
                    == 1
                )
            else:
                assert raised.value.step == expected_steps.get(fault, "read_fixture_bindings")
            return
        results = []
        for action in actions:
            wire.begin_action(action)
            results.append(execute_sandbox_control(action, dataset, context))
        by_key = {result["action_key"]: result for result in results}
        lifecycle_actions = [
            action for action in actions if action.values["operation"] in OPERATIONS
        ]
        lifecycle.final_mode = True
        if fault == "final_request":
            next(result for result in results if result["action_key"].endswith(":reopen_field"))[
                "request_evidence"
            ][0]["path"] = f"/api/fields/{str(uuid4())}/reopen"
        export_action = next(
            action for action in actions if action.values["operation"] == "export_import_document"
        )
        export_result = by_key[export_action.key]
        if fault.startswith("final_history_"):
            receipt = export_result["history_export_reads"]["with_history"]
            if fault == "final_history_missing":
                del export_result["history_export_reads"]
            if fault == "final_history_actor":
                receipt["actor_id"] = str(uuid4())
            if fault == "final_history_query":
                receipt["params"] = {"includeVersions": "false"}
            if fault == "final_history_request_id":
                receipt["request_id"] = str(uuid4())
            if fault == "final_history_body_hash":
                receipt["payload"] += " "
            if fault == "final_history_body_content":
                import hashlib

                payload = json.loads(receipt["payload"])
                payload["versions"][0]["label"] = "Rehashed wrong content"
                receipt["payload"] = json.dumps(payload)
                receipt["sha256"] = hashlib.sha256(receipt["payload"].encode()).hexdigest()
        manifest = {
            "control_plan": [asdict(action) for action in actions],
            "control_results": results,
            "mappings": copy.deepcopy(context.runtime_mappings),
        }
        if fault == "final_mapping_shape":
            manifest["mappings"] = None

        counts, issues = verify_sandbox_controls(
            context.clients["admin"], dataset, manifest, admin_id=ADMIN_ID
        )

        if fault.startswith("final_"):
            expected_issue = "history export" if fault.startswith("final_history_") else "lifecycle"
            assert any(expected_issue in issue.lower() for issue in issues), issues
            return
        assert not issues
        export_action = next(
            action for action in actions if action.values["operation"] == "export_import_document"
        )
        export_result = by_key[export_action.key]
        assert wire.history_export_calls == 1
        assert isinstance(export_result.get("history_export_reads"), dict)
        imports = [
            request
            for request in requests
            if request.method == "POST" and request.url.path == "/api/sandbox/imports"
        ]
        assert len(imports) == 1 and "versions" not in json.loads(imports[0].content)["bundle"]
        assert counts["sandbox_prune_verified"] == 1
        assert counts["sandbox_prune_versions_removed"] == 49
        assert counts["sandbox_prune_audit_rows"] == 187
        prune_action = next(
            action for action in actions if action.values["operation"] == "prune_versions"
        )
        receipts = by_key[prune_action.key]["request_evidence"]
        assert len(receipts) == len({row["request_id"] for row in receipts}) == 89
        finished = {
            row.get("request_id")
            for row in (
                json.loads(line) for line in (tmp_path / "requests.jsonl").read_text().splitlines()
            )
            if row["event"] == "request_finished"
        }
        assert {row["request_id"] for row in receipts} <= finished
        from operations.sample.controls.sandbox_export import validate_history_export_reads

        journal_rows = [
            json.loads(line) for line in (tmp_path / "requests.jsonl").read_text().splitlines()
        ]
        started = {
            row["attempt_id"]: row for row in journal_rows if row["event"] == "request_started"
        }
        actual_read_ids = {
            row.get("request_id")
            for row in journal_rows
            if row["event"] == "request_finished" and started[row["attempt_id"]]["method"] == "GET"
        }
        assert (
            validate_history_export_reads(export_result["history_export_reads"], ADMIN_ID)
            <= actual_read_ids
        )
        assert counts["sandbox_test_runs_verified"] == len(dataset.test_vectors)
        assert counts["sandbox_temporary_versions_removed"] == 2
        assert (
            wire.import_checkpoint_id is not None and wire.import_checkpoint_id not in wire.history
        )
        assert len(wire.created_test_ids) == len(dataset.test_vectors)
        observed = {_route(request) for request in requests}
        assert CONTROL_ROUTES <= observed
        assert lifecycle.document == dataset.document
        assert not lifecycle.live
        assert lifecycle.board["purged"] is True
        assert counts["sandbox_lifecycle_targets_purged"] == 4
        assert counts["sandbox_lifecycle_boards_purged"] == 1
        assert counts["sandbox_lifecycle_versions_verified"] == 1
        assert {
            row["server_id"]
            for row in by_key[lifecycle_actions[0].key]["mappings"]
            if row["kind"] == "sandbox_lifecycle"
        } == {*lifecycle.identities.values(), lifecycle.board_id}
        assert all(
            "expected_audit_rows" not in row
            for action in lifecycle_actions
            for row in by_key[action.key]["request_evidence"]
        )
        from operations.sample.verification.route_coverage import read_route_evidence

        covered = {
            (row["method"], row["path"])
            for row in read_route_evidence(tmp_path / "requests.jsonl")["covered"]
        }
        lifecycle_routes = {("GET", "/api/sandbox/bindings")}
        lifecycle_routes.update(
            ("POST", f"/api/{kind}s/{{{kind}_id}}/{operation}")
            for kind in ("department", "module", "field")
            for operation in ("close/preview", "close", "reopen", "purge/preview", "purge")
        )
        assert lifecycle_routes <= covered
        journal = (tmp_path / "requests.jsonl").read_text()
        assert "fixture-admin-password" not in journal and "publication-fixture" not in journal
    finally:
        context.clients["admin"].close()


@pytest.mark.parametrize("history", ("empty", "older_snapshot"))
def test_sandbox_history_export_matches_independent_stored_snapshots(
    tmp_path: Path, history: str
) -> None:
    from operations.sample.controls.sandbox_export import validate_history_export_reads

    dataset = _dataset()
    actions = plan_sandbox_controls(dataset)
    wire = SandboxControlWire(dataset, actions, "none")
    context = _context(tmp_path, wire.handle)
    client = context.clients["admin"]
    try:
        if history == "older_snapshot":
            older = copy.deepcopy(dataset.document)
            older["design"]["departments"][0]["name"] = "Earlier department structure"
            assert (
                client.request(
                    "PUT",
                    "/api/sandbox/document",
                    json_body={"expectedRevision": wire.revision, "document": older},
                ).status_code
                == 200
            )
            assert (
                client.request(
                    "POST",
                    "/api/sandbox/versions",
                    json_body={
                        "expectedRevision": wire.revision,
                        "kind": "checkpoint",
                        "label": "Earlier saved design",
                        "note": None,
                    },
                ).status_code
                == 201
            )
        assert (
            client.request(
                "PUT",
                "/api/sandbox/document",
                json_body={"expectedRevision": wire.revision, "document": dataset.document},
            ).status_code
            == 200
        )
        wire.controls_started = True
        action = next(
            action for action in actions if action.values["operation"] == "export_import_document"
        )
        initial = (copy.deepcopy(wire.document), wire.revision, copy.deepcopy(wire.versions))
        wire.begin_action(action)
        if history == "empty":
            with pytest.raises(SamplePhaseActionError) as raised:
                execute_sandbox_control(action, dataset, context)
            assert raised.value.step == "history_export_import_precondition"
            assert wire.history_export_calls == 1 and wire.last_history_export["versions"] == []
            assert (wire.document, wire.revision, wire.versions) == initial
            assert not any(
                request.method == "POST" and request.url.path == "/api/sandbox/imports"
                for request in wire.requests
            )
            return
        result = execute_sandbox_control(action, dataset, context)
        assert wire.history_export_state == initial
        assert wire.history_export_calls == 1
        reads = result["history_export_reads"]
        validate_history_export_reads(reads, ADMIN_ID)
        exported = json.loads(reads["with_history"]["payload"])
        assert exported["versions"] == (
            []
            if history == "empty"
            else [
                {
                    "id": initial[2][0]["id"],
                    "label": "Earlier saved design",
                    "kind": "checkpoint",
                    "document": {
                        k: v for k, v in older.items() if k not in {"kind", "schemaVersion"}
                    },
                    "published": False,
                    "date": initial[2][0]["createdAt"],
                    "note": None,
                }
            ]
        )
        assert (
            len(
                [
                    request
                    for request in wire.requests
                    if request.method == "POST" and request.url.path == "/api/sandbox/imports"
                ]
            )
            == 1
        )
        cleanup = next(
            action for action in actions if action.values["operation"] == "delete_import_checkpoint"
        )
        execute_sandbox_control(cleanup, dataset, context)
        assert wire.document == initial[0]
        assert wire.active() == initial[2]
        assert wire.import_checkpoint_id not in wire.history
    finally:
        client.close()
