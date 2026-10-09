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
        *(
            ("harbor", fault)
            for fault in (
                "none",
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
        if fault not in {
            "none",
            "final_binding",
            "final_live",
            "final_board",
            "final_snapshot",
            "final_request",
            "final_document_shape",
            "final_mapping_shape",
        }:
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
            assert any("lifecycle" in issue.lower() for issue in issues), issues
            return
        assert not issues
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
