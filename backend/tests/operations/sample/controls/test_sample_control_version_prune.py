"""Owned API prune journeys and refusal proofs, authored before executor behavior."""

import copy
import json
from dataclasses import replace

import httpx
import pytest

from operations.sample.client import SampleClient, SampleClientError
from operations.sample.controls.sandbox import execute_sandbox_control, plan_sandbox_controls
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.population import workflow
from operations.sample.population.people import SampleActorCredential
from tests.operations.sample.controls.sample_version_prune_wire import (
    ADMIN_ID,
    RUN_ID,
    VersionPruneWire,
)
from tests.operations.sample.controls.test_sample_control_sandbox import _dataset


def _dataset_for(pack):
    dataset = _dataset("school" if pack == "school" else "harbor")
    if pack == "neutral":
        dataset = replace(
            dataset,
            organization=replace(
                dataset.organization,
                identity=replace(dataset.organization.identity, key="other-pack"),
            ),
        )
    return dataset


def _action():
    return PhaseAction(
        key="controls:sandbox:prune_versions",
        phase="reorganization",
        kind="sandbox_controls",
        actor_key="admin",
        target_key="owned_version_capacity",
        values={"operation": "prune_versions"},
        expected_status=200,
        expected_detail=None,
        expected_end_state={
            "deleted_count": 10,
            "temporary_versions_removed": 49,
            "document_preserved": True,
            "published_preserved": True,
        },
    )


def _context(tmp_path, dataset):
    wire = VersionPruneWire(dataset)
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(wire.handle),
    )
    assert client.login("fixture@example.test", "fixture-only").status_code == 200
    return wire, PhaseExecutionContext(
        clients={"admin": client},
        user_ids={"admin": ADMIN_ID},
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings={},
        admin_password="fixture-only",
    )


def _literal_setup(tmp_path, pack="harbor"):
    """Exercise actual preparation/retention with independent transport behavior."""
    dataset = _dataset_for(pack)
    wire, context = _context(tmp_path, dataset)
    client = context.clients["admin"]
    fixture = workflow._publish_sandbox(client, dataset, "fixture-only", RUN_ID, ADMIN_ID)
    assert fixture is not None
    context.private_values["sandbox_prune_fixture"] = fixture
    context.runtime_mappings.update(workflow._journal_mappings(tmp_path / "requests.jsonl"))
    return dataset, wire, context, _action()


@pytest.mark.parametrize("pack", ("harbor", "school", "neutral"))
def test_prune_is_a_planned_owned_sandbox_operation(pack):
    from operations.sample.controls.actions import plan_controls

    dataset = _dataset_for(pack)
    before = copy.deepcopy(dataset.document)
    actions = plan_sandbox_controls(dataset)
    matches = [row for row in actions if row.values["operation"] == "prune_versions"]
    assert matches == [_action()]
    assert actions[0] == _action()
    global_actions = plan_controls(dataset)
    assert global_actions[0] == _action()
    assert sum(row.values["operation"] == "prune_versions" for row in global_actions) == 1
    assert dataset.document == before


def test_actual_population_prepares_only_owned_versions_before_its_authored_checkpoint(
    tmp_path,
    monkeypatch,
):
    dataset = _dataset_for("harbor")
    wire, context = _context(tmp_path, dataset)
    captured = {}
    original = workflow._publish_sandbox

    def publish(*args, **kwargs):
        captured["fixture"] = original(*args, **kwargs)
        return captured["fixture"]

    class SandboxFinished(RuntimeError):
        pass

    def catalogue(*_args):
        raise SandboxFinished

    monkeypatch.setattr(workflow, "SampleClient", lambda *_args: context.clients["admin"])
    # One fixture session acts as the operator and as the pack administrator it invites.
    monkeypatch.setattr(workflow, "create_run_roster", lambda *_args: None)
    monkeypatch.setattr(
        workflow,
        "invite_pack_administrator",
        lambda *_args, **_kwargs: SampleActorCredential(
            ADMIN_ID, "fixture@example.test", "fixture-only"
        ),
    )
    monkeypatch.setattr(
        workflow,
        "assert_pristine_baseline",
        lambda *_args, **_kwargs: {
            "workspace": {"revision": 1},
            "boards": [],
        },
    )
    monkeypatch.setattr(workflow, "assert_empty_content", lambda *_args: None)
    monkeypatch.setattr(workflow, "_publish_sandbox", publish)
    monkeypatch.setattr(workflow, "_catalogue", catalogue)
    with pytest.raises(SandboxFinished):
        workflow.run_population(
            api_url="http://sample.test",
            origin="http://localhost",
            mailpit_url="http://mail.test",
            operator_email="fixture@example.test",
            operator_password="fixture-only",
            expected_operator_id=ADMIN_ID,
            run_directory=tmp_path,
            run_id=RUN_ID,
            dataset=dataset,
            manifest={},
        )
    temporary = [row for row in wire.versions if row["label"].startswith("Sample prune ")]
    assert len(temporary) == 49
    assert len(wire.active()) == 51
    assert [row["kind"] for row in wire.versions[-2:]] == ["checkpoint", "published"]
    assert all(row["sequence"] < wire.versions[-2]["sequence"] for row in temporary)
    fixture = captured["fixture"]
    assert {row["id"] for row in fixture["versions"]} == {row["id"] for row in temporary}
    assert fixture["actor_id"] == ADMIN_ID
    required = {
        "sourceDocumentRevision",
        "sourceVersionId",
        "note",
        "byteCount",
        "metadataRevision",
        "createdAt",
        "isDeleted",
        "deletedAt",
    }
    assert all(required <= row.keys() and "document" not in row for row in fixture["versions"])
    assert [row["sourceDocumentRevision"] for row in fixture["versions"]] == list(range(2, 51))


def test_population_hands_the_real_preparation_to_the_existing_private_context(
    tmp_path, monkeypatch
):
    from tests.operations.sample.population.test_sample_population_actors import _isolated_workflow

    _dataset, _wire, context, _action_value = _literal_setup(tmp_path / "receipts")
    fixture = context.private_values["sandbox_prune_fixture"]
    invoke, _state, _manifest, _active, _people = _isolated_workflow(
        tmp_path, monkeypatch, complete=True
    )
    monkeypatch.setattr(workflow, "_publish_sandbox", lambda *_args: fixture)
    handed = {}

    def phases(*_args, **kwargs):
        handed.update(kwargs["private_values"])
        return {}

    monkeypatch.setattr(workflow, "run_population_phases", phases)
    try:
        invoke()
        assert handed.get("sandbox_prune_fixture") is fixture
    finally:
        context.clients["admin"].close()


@pytest.mark.parametrize("pack", ("harbor", "school", "neutral"))
def test_prune_real_client_deletes_only_owned_oldest_and_preserves_authored_history(tmp_path, pack):
    _dataset, wire, context, action = _literal_setup(tmp_path, pack)
    owned = copy.deepcopy(wire.versions[:49])
    protected = copy.deepcopy(wire.versions[49:])
    before = copy.deepcopy(wire.document)
    try:
        result = execute_sandbox_control(action, _dataset, context)
        assert result["outcome"] == "completed"
        assert result["deleted_count"] == 10
        assert result["pruned_ids"] == [row["id"] for row in owned[:10]]
        assert set(result["cleanup_ids"]) == {row["id"] for row in owned[10:]}
        assert wire.prune_calls == 1 and len(wire.delete_calls) == 39
        assert wire.active() == protected
        assert wire.document == before
        assert len(result["request_evidence"]) == 89
        receipt_ids = [row["request_id"] for row in result["request_evidence"]]
        assert len(set(receipt_ids)) == 89
        journal = [
            json.loads(line) for line in (tmp_path / "requests.jsonl").read_text().splitlines()
        ]
        completed = {row["request_id"] for row in journal if row["event"] == "request_finished"}
        assert set(receipt_ids) <= completed
    finally:
        context.clients["admin"].close()


@pytest.mark.parametrize(
    "fault,step",
    (
        ("foreign_row", "prune_scan"),
        ("underfilled_page", "prune_scan"),
        ("duplicate_id", "prune_scan"),
        ("wrong_kind", "prune_scan"),
        ("coerced_count", "prune_scan"),
        ("wrong_capacity", "prune_scan"),
        ("revision_race", "prune_scan_revision"),
        ("precontrol_race", "prune_scan"),
        ("stale_prune", "prune_versions"),
        ("wrong_deleted_count", "prune_result"),
        ("wrong_deleted_rows", "prune_readback"),
    ),
)
def test_prune_refuses_unknown_history_or_conflicts_without_cleanup(tmp_path, fault, step):
    dataset, wire, context, action = _literal_setup(tmp_path)
    wire.fault = fault
    try:
        with pytest.raises(SamplePhaseActionError) as caught:
            execute_sandbox_control(action, dataset, context)
        assert caught.value.step == step
        assert wire.delete_calls == []
        assert wire.prune_calls == (
            fault in {"stale_prune", "wrong_deleted_count", "wrong_deleted_rows"}
        )
    finally:
        context.clients["admin"].close()


@pytest.mark.parametrize("fault", ("missing_request_id", "cleanup_failure"))
def test_unknown_write_or_cleanup_outcome_is_never_retried(tmp_path, fault):
    dataset, wire, context, action = _literal_setup(tmp_path)
    wire.fault = fault
    try:
        with pytest.raises((SampleClientError, SamplePhaseActionError)):
            execute_sandbox_control(action, dataset, context)
        assert wire.prune_calls == 1
        assert len(wire.delete_calls) == (fault == "cleanup_failure")
    finally:
        context.clients["admin"].close()


def _completed(tmp_path):
    dataset, wire, context, action = _literal_setup(tmp_path)
    result = execute_sandbox_control(action, dataset, context)
    return dataset, wire, context, action, result


def _verify(dataset, context, action, result):
    from operations.sample.controls.version_prune_verification import verify_version_prune
    from operations.sample.phases.plan import phase_action_to_manifest

    manifest = {
        "control_plan": [phase_action_to_manifest(action)],
        "control_results": [result],
        "mappings": copy.deepcopy(context.runtime_mappings),
    }
    return verify_version_prune(context.clients["admin"], dataset, manifest, ADMIN_ID)


def test_final_prune_proof_uses_receipts_and_api_end_state_without_audit_reads(tmp_path):
    dataset, wire, context, action, result = _completed(tmp_path)
    try:
        counts, issues = _verify(dataset, context, action, result)
        assert issues == []
        assert counts["sandbox_prune_verified"] == 1
        assert counts["sandbox_prune_versions_removed"] == 49
        assert "sandbox_prune_audit_rows" not in counts
        assert not any(row.url.path == "/api/audit-logs" for row in wire.requests)
    finally:
        context.clients["admin"].close()


@pytest.mark.parametrize(
    "fault",
    (
        "underfilled_page",
        "duplicate_id",
        "wrong_kind",
        "coerced_count",
        "wrong_capacity",
        "missing_list_createdAt",
        "missing_detail_sourceDocumentRevision",
    ),
)
def test_final_prune_proof_refuses_incomplete_api_end_state(tmp_path, fault):
    dataset, wire, context, action, result = _completed(tmp_path)
    wire.fault = fault
    try:
        counts, issues = _verify(dataset, context, action, result)
        assert issues
        assert counts["sandbox_prune_verified"] == 0
        assert counts["sandbox_prune_versions_removed"] == 0
    finally:
        context.clients["admin"].close()


@pytest.mark.parametrize(
    "tamper",
    (
        "missing_receipt",
        "reused_request",
        "wrong_actor",
        "foreign_id",
        "missing_recorded_dto",
        "protected_source_revision",
    ),
)
def test_final_prune_proof_refuses_forged_or_incomplete_receipts(tmp_path, tamper):
    dataset, _wire, context, action, result = _completed(tmp_path)
    result = copy.deepcopy(result)
    if tamper == "missing_receipt":
        result["request_evidence"].pop()
    elif tamper == "reused_request":
        result["request_evidence"][1]["request_id"] = result["request_evidence"][0]["request_id"]
    elif tamper == "wrong_actor":
        result["request_evidence"][0]["actor_id"] = result["cleanup_ids"][0]
    elif tamper == "foreign_id":
        result["pruned_ids"][0] = context.runtime_mappings["sandbox_versions"]["initial_checkpoint"]
    elif tamper == "missing_recorded_dto":
        del result["protected_versions"][0]["createdAt"]
    else:
        result["protected_versions"][0]["sourceDocumentRevision"] += 1
    try:
        counts, issues = _verify(dataset, context, action, result)
        assert issues and counts["sandbox_prune_verified"] == 0
    finally:
        context.clients["admin"].close()
