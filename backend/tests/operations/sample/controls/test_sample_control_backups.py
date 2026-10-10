"""Sample backup planning and the isolated metadata control boundary."""

import copy
from datetime import date
from uuid import uuid4

import httpx
import pytest

from app.systems.manage.backups.schemas import BackupCreate, BackupPolicyUpdate
from operations.sample.client import SampleWriteOutcomeUnknown
from operations.sample.controls.actions import execute_control_action, plan_controls
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import SamplePhaseActionError
from operations.sample.phases.plan import phase_action_to_manifest
from operations.sample.scenario import build_dataset
from tests.operations.sample.controls.test_sample_control_host_delivery import (
    host_dataset as host_dataset,
)
from tests.operations.sample.controls.test_sample_control_host_delivery import (
    host_journey as host_journey,
)
from tests.operations.sample.controls.test_sample_control_host_delivery import (
    topology_runtime as topology_runtime,
)
from tests.operations.sample.controls.test_sample_control_sandbox import _context, _login_response


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_backup_plan_adds_one_action_per_public_operation_with_authored_name(pack_key):
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack(pack_key))
    actions = plan_controls(dataset)
    backups = [row for row in actions if row.kind == "backup_controls"]
    assert [row.values["operation"] for row in backups] == [
        "review_backup_status",
        "update_restore_backup_policy",
        "queue_backup",
        "review_backup_history",
        "review_version",
    ]
    assert len({row.key for row in actions}) == len(actions)
    assert all(row.actor_key == "admin" and row.phase == "reorganization" for row in backups)
    queue = backups[2]
    assert queue.expected_status == 201
    assert (
        queue.values["name"] == f"{dataset.organization.identity.workspace_name} workspace backup"
    )
    assert queue.expected_end_state["queued"] is True
    assert actions[-1].values["operation"] == "revoke_user_sessions"
    assert actions[-3].values["operation"] == "revoke_admin_sessions"
    assert actions[-2].values["operation"] == "review_notifications"


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_host_backup_export_is_planned_only_for_host_acceptance(pack_key):
    # An ordinary run has no trusted host callback, so it must not plan the host step.
    plain = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack(pack_key))
    host = build_dataset(
        "small", 83, date(2026, 10, 2), organization=get_pack(pack_key), host_acceptance=True
    )
    plain_ops = [row.values["operation"] for row in plan_controls(plain)]
    host_actions = plan_controls(host)
    host_backups = [row for row in host_actions if row.kind == "backup_controls"]
    assert "physical_backup_export" not in plain_ops
    assert host_backups[0].values["operation"] == "physical_backup_export"
    assert host_backups[0].actor_key != "admin"
    assert len(host_actions) == len(plain_ops) + 1


class BackupWire:
    """The admitted public metadata boundary; no runner or successful snapshot."""

    def __init__(self, fault=None, version_status="unknown"):
        self.fault = fault
        self.requests = []
        self.policy = {
            "schedule": "weekly",
            "retention_days": 90,
            "revision": 5,
            "timezone": "Europe/London",
            "next_due_at": "2026-10-04T01:00:00Z",
            "adopted": True,
        }
        self.original = copy.deepcopy(self.policy)
        self.patches = []
        self.queued = None
        self.version = {
            "current_version": "2.7.1",
            "status": version_status,
            "latest_version": None,
            "observed_at": None,
            "checked_at": None,
            "failure_code": None,
            "release_url": None,
        }
        if version_status == "unavailable":
            self.version.update(
                checked_at="2026-10-03T00:00:00Z", failure_code="release_unavailable"
            )

    def _run(self, name):
        return {
            "id": str(uuid4()),
            "name": name,
            "provenance": "manual",
            "installation": "current",
            "state": "queued",
            "requested_at": "2026-10-03T00:00:00Z",
            "started_at": None,
            "finished_at": None,
            "reconciled_at": None,
            "schedule": self.policy["schedule"],
            "retention_days": self.policy["retention_days"],
            "snapshot_id": None,
            "manifest_sha256": None,
            "verified_at": None,
            "failure_code": None,
            "expired_at": None,
        }

    def handle(self, request):
        if response := _login_response(request):
            return response
        self.requests.append(request)
        method, path = request.method, request.url.path
        headers = {"Cache-Control": "no-store", "X-Request-ID": str(uuid4())}
        if self.fault == "no_store":
            headers.pop("Cache-Control")
        if self.fault == "request_id":
            headers.pop("X-Request-ID")
        if path == "/api/backups/status":
            if method == "PATCH":
                patch = BackupPolicyUpdate.model_validate_json(request.content)
                assert patch.revision == self.policy["revision"]
                self.patches.append(patch.model_dump(exclude_unset=True))
                self.policy.update(patch.model_dump(exclude_unset=True))
                self.policy["revision"] += 1
                self.policy["next_due_at"] = (
                    None if self.policy["schedule"] == "disabled" else "2026-10-04T01:00:00Z"
                )
                if self.fault == "revision":
                    self.policy["revision"] += 1
                if self.fault == "restore" and len(self.patches) == 2:
                    self.policy["retention_days"] = 7
            else:
                assert method == "GET" and not request.url.params
            body = {
                "policy": copy.deepcopy(self.policy),
                "runner": {"state": "unknown", "last_seen_at": None},
                "active_run": None,
                "queued_count": int(self.queued is not None),
            }
        elif path == "/api/backups" and method == "POST":
            assert self.queued is None, "The sampler repeated a queue write"
            assert request.headers["Idempotency-Key"]
            if self.fault == "lost_response":
                raise httpx.ReadTimeout("Synthetic lost response", request=request)
            payload = BackupCreate.model_validate_json(request.content)
            self.queued = self._run(payload.name)
            body = copy.deepcopy(self.queued)
            headers["Location"] = f"/api/backups?run_id={body['id']}"
            if self.fault == "location":
                headers["Location"] = "/api/backups"
            return httpx.Response(201, json=body, headers=headers)
        elif path == "/api/backups" and method == "GET":
            params = dict(request.url.params)
            run_id = params.pop("run_id", None)
            assert params == {
                "limit": "4",
                "offset": "0",
                "search": "",
                "sort_by": "requested_at",
                "sort_order": "desc",
                "deleted": "exclude",
            }
            if run_id:
                assert self.queued and run_id == self.queued["id"]
                rows, total = [copy.deepcopy(self.queued)], 1
                if self.fault == "missing_row":
                    rows, total = [], 0
                elif self.fault in {"state", "installation", "name", "snapshot_id"}:
                    rows[0][self.fault] = {
                        "state": "succeeded",
                        "installation": "previous",
                        "name": "Another request",
                        "snapshot_id": "a" * 64,
                    }[self.fault]
            else:
                # Newer unrelated requests fill the visible page; exact run_id is essential.
                rows, total = [self._run(f"Previous request {index}") for index in range(4)], 9
            body = {
                "items": rows,
                "pagination": {
                    "limit": 4,
                    "offset": 0,
                    "count": len(rows),
                    "total": total,
                    "has_more": total > len(rows),
                },
            }
            if self.fault == "pagination":
                body["pagination"]["has_more"] = True
        elif (method, path) == ("GET", "/api/version"):
            assert not request.url.params
            body = copy.deepcopy(self.version)
            if self.fault == "version_missing":
                body.pop("current_version")
            elif self.fault == "version_fiction":
                body["status"] = "current"
            elif self.fault == "version_naive_time":
                body.update(
                    status="unavailable",
                    checked_at="2026-10-03T00:00:00",
                    failure_code="release_timeout",
                )
        else:
            raise AssertionError(f"Unexpected sample backup request: {method} {path}")
        return httpx.Response(200, json=body, headers=headers)


def _backup_journey(tmp_path, fault=None, version_status="unknown", pack_key="harbor"):
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack(pack_key))
    wire = BackupWire(fault, version_status)
    context = _context(tmp_path, wire.handle)
    from operations.sample.controls.backups import plan_backup_controls

    actions = plan_backup_controls(dataset)
    return dataset, wire, context, actions


@pytest.mark.parametrize(
    "pack_key,version_status", [("harbor", "unknown"), ("school", "unavailable")]
)
def test_backup_controls_restore_policy_and_verify_queue_beyond_visible_history(
    tmp_path, pack_key, version_status
):
    dataset, wire, context, actions = _backup_journey(
        tmp_path, pack_key=pack_key, version_status=version_status
    )
    try:
        results = [execute_control_action(row, dataset, context) for row in actions]
        assert len(wire.patches) == 2
        assert wire.patches[0]["revision"] == 5 and wire.patches[1]["revision"] == 6
        assert wire.patches[0]["schedule"] != wire.original["schedule"]
        assert wire.patches[0]["retention_days"] != wire.original["retention_days"]
        assert wire.policy == {**wire.original, "revision": 7}
        assert sum(request.method == "POST" for request in wire.requests) == 1
        assert wire.queued["state"] == "queued" and wire.queued["snapshot_id"] is None
        assert results[2]["queued_run"] == wire.queued
        assert results[3]["owned_queue_verified"] is True
        assert results[4]["version_observation"] == wire.version
        assert results[4]["version_observation"]["current_version"] == "2.7.1"
        descriptors = [row for result in results for row in result["request_evidence"]]
        assert len(descriptors) == len(wire.requests) == 11
        assert len({row["request_id"] for row in descriptors}) == 11
        assert [result["read_checks"] for result in results] == [1, 3, 1, 2, 1]
        journal = (tmp_path / "requests.jsonl").read_text()
        assert "Idempotency-Key" not in journal
        assert dataset.organization.identity.workspace_name not in journal
    finally:
        context.clients["admin"].close()


@pytest.mark.parametrize(
    "fault",
    (
        "no_store",
        "request_id",
        "revision",
        "restore",
        "location",
        "missing_row",
        "pagination",
        "state",
        "installation",
        "name",
        "snapshot_id",
        "version_missing",
        "version_fiction",
        "version_naive_time",
    ),
)
def test_backup_controls_refuse_wire_or_state_mismatch_without_repeated_writes(tmp_path, fault):
    dataset, wire, context, actions = _backup_journey(tmp_path, fault)
    try:
        with pytest.raises(SamplePhaseActionError):
            for action in actions:
                execute_control_action(action, dataset, context)
        assert sum(request.method == "POST" for request in wire.requests) <= 1
    finally:
        context.clients["admin"].close()


def test_backup_queue_unknown_outcome_stops_without_replay(tmp_path):
    dataset, wire, context, actions = _backup_journey(tmp_path, "lost_response")
    try:
        with pytest.raises(SampleWriteOutcomeUnknown):
            for action in actions:
                execute_control_action(action, dataset, context)
        assert sum(request.method == "POST" for request in wire.requests) == 1
    finally:
        context.clients["admin"].close()


def test_version_review_preserves_non_numeric_running_version_and_last_observation(tmp_path):
    dataset, wire, context, actions = _backup_journey(tmp_path)
    wire.version.update(
        current_version="2.7.1-development",
        latest_version="2.7.1",
        observed_at="2026-10-03T00:00:00Z",
        checked_at="2026-10-03T00:00:00Z",
        release_url="https://github.com/jayeuse/openslate/releases/tag/v2.7.1",
    )
    try:
        result = execute_control_action(actions[-1], dataset, context)
        assert result["version_observation"] == wire.version
        assert all(request.method == "GET" for request in wire.requests)
    finally:
        context.clients["admin"].close()


@pytest.mark.parametrize(
    "tamper",
    (
        None,
        "missing_step",
        "reordered",
        "wrong_actor",
        "request_reuse",
        "path",
        "status",
        "read_checks",
        "end_state",
        "mapping",
        "mapping_receipt",
        "extra_mapping",
        "original_policy",
        "restore_final",
        "queue_final",
        "version_final",
        "final_no_store",
    ),
)
def test_backup_reconciliation_requires_exact_descriptors_and_current_owned_readbacks(
    tmp_path, monkeypatch, tamper
):
    import operations.sample.controls.actions as actions_module
    from operations.sample.controls.verification import verify_controls
    from tests.operations.sample.controls.test_sample_control_verification import (
        _patch_plan_and_final_verifiers,
    )

    dataset, wire, context, actions = _backup_journey(tmp_path)
    try:
        results = [execute_control_action(row, dataset, context) for row in actions]
        _patch_plan_and_final_verifiers(monkeypatch, actions[0])
        monkeypatch.setattr(actions_module, "plan_controls", lambda _: actions)
        manifest = {
            "control_plan": [phase_action_to_manifest(row) for row in actions],
            "control_results": results,
            "mappings": copy.deepcopy(context.runtime_mappings),
            "actor_ids": {},
        }
        evidence = results[1]["request_evidence"]
        if tamper == "missing_step":
            evidence.pop()
        elif tamper == "reordered":
            evidence.reverse()
        elif tamper == "wrong_actor":
            evidence[0]["actor_id"] = str(uuid4())
        elif tamper == "request_reuse":
            evidence[1]["request_id"] = evidence[0]["request_id"]
        elif tamper == "path":
            evidence[-1]["path"] = "/api/version"
        elif tamper == "status":
            evidence[1]["status_code"] = 503
        elif tamper == "read_checks":
            results[3]["read_checks"] = True
        elif tamper == "end_state":
            results[2]["queued"] = False
        elif tamper == "mapping":
            manifest["mappings"]["backup_requests"].clear()
        elif tamper == "mapping_receipt":
            results[2]["mappings"][0]["server_id"] = str(uuid4())
        elif tamper == "extra_mapping":
            manifest["mappings"]["backup_requests"]["extra"] = str(uuid4())
        elif tamper == "original_policy":
            results[0]["original_policy"]["schedule"] = "daily"
        elif tamper == "restore_final":
            wire.policy["retention_days"] = 7
        elif tamper == "queue_final":
            wire.queued["state"] = "running"
        elif tamper == "version_final":
            wire.version["current_version"] = "9.9.9"
        elif tamper == "final_no_store":
            wire.fault = "no_store"
        counts, issues = verify_controls(
            context.clients["admin"], dataset, manifest, context.user_ids["admin"]
        )
        assert bool(issues) is (tamper is not None)
        if tamper is None:
            assert counts["control_requests_verified"] == 11
            assert counts["backup_requests_queued"] == 1
            assert counts["backup_policy_restored"] == 1
            assert counts["backup_version_reviewed"] == 1
            assert sum(request.method == "POST" for request in wire.requests) == 1
    finally:
        context.clients["admin"].close()


@pytest.mark.parametrize("callback", [None, "untrusted-input"])
def test_host_control_requires_operator_callback_before_any_request(tmp_path, callback):
    from operations.sample.controls.host_delivery import plan_host_controls

    dataset = build_dataset(
        "small", 83, date(2026, 10, 2), organization=get_pack("harbor"), host_acceptance=True
    )
    wire = BackupWire()
    context = _context(tmp_path, wire.handle)
    context.private_values["host_control"] = callback
    try:
        with pytest.raises(SamplePhaseActionError) as failure:
            execute_control_action(plan_host_controls(dataset)[0], dataset, context)
        assert failure.value.step == "host_setup"
        assert not wire.requests
    finally:
        for client in context.clients.values():
            client.close()


def test_host_callback_and_public_receipts_reconcile_through_common_verifier(
    host_journey, monkeypatch
):
    from operations.sample.controls import verification
    from operations.sample.controls.host_delivery import execute_host_control
    from operations.sample.controls.request_verification import verify_request_evidence
    from tests.operations.sample.controls.test_sample_control_mfa import OWNER_ID
    from tests.operations.sample.controls.test_sample_control_verification import (
        _patch_plan_and_final_verifiers,
    )

    dataset, action, context, runtime, host, wire = host_journey
    context.private_values["host_control"] = lambda *a, **kw: execute_host_control(
        *a, **kw, runtime=runtime
    )
    result = execute_control_action(action, dataset, context)
    assert result["outcome"] == "completed" and host.phase == "development"
    assert wire.run_calls == 2
    manifest = {
        "control_plan": [phase_action_to_manifest(action)],
        "control_results": [result],
        "actor_ids": context.user_ids,
        "mappings": {"user": context.user_ids, "group": context.group_ids},
    }
    _patch_plan_and_final_verifiers(monkeypatch, action)
    # Only the host action is under this harness; the legacy queued control has
    # its own unstarted-request fixture above.
    monkeypatch.setattr(verification, "_verify_backup_final", lambda *a: None)
    counts, issues = verification.verify_controls(
        context.clients["admin"], dataset, manifest, OWNER_ID
    )
    assert issues == []
    assert counts["host_control_actions"] == 1
    assert counts["host_control_security_events"] == 1
    assert counts["control_requests_verified"] == len(result["request_evidence"])
    repeated = {result["native_content_request_id"]}
    observed, issues = {"control_requests_verified": 0}, []
    verify_request_evidence(
        dataset, manifest, action, result, context.user_ids, OWNER_ID, repeated, observed, issues
    )
    assert issues, "A request reused by an earlier action must fail global reconciliation"
    assert observed["control_requests_verified"] < len(result["request_evidence"])
