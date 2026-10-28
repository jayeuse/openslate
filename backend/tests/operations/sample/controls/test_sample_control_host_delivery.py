"""Prewritten host control admission/plan cases; never run a host during collection."""

import json
from contextlib import ExitStack
from copy import deepcopy
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

import httpx
import pytest

from operations.sample.packs.phase_types import PhaseAction
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.scenario import build_dataset
from tests.operations.sample.controls.test_sample_control_host_environment import (
    native_proof as native_proof,
)
from tests.operations.sample.controls.test_sample_control_host_environment import (
    topology_runtime as topology_runtime,
)
from tests.operations.sample.controls.test_sample_control_mfa import (
    ORIGIN,
    OWNER_ID,
    PASSWORD,
    MfaServer,
)


class HostWire(MfaServer):
    """Existing account fake plus current public backup DTOs; no physical proof."""

    def __init__(self, dataset, host, fault=None):
        super().__init__(dataset)
        self.host, self.host_fault, self.observed = host, fault, []
        self.queued, self.exported, self.run_calls = None, None, 0
        self.policy = {
            "schedule": "disabled",
            "retention_days": 30,
            "revision": 5,
            "timezone": "UTC",
            "next_due_at": None,
            "adopted": True,
        }

    def identity(self, request):
        sid, user, aal = super().identity(request)
        return sid, user, "aal2" if sid in getattr(self, "owner_sessions", ()) else aal

    def handle(self, request):
        from tests.operations.sample.controls.test_sample_control_backups import BackupWire

        self.observed.append(request)
        assert request.headers["origin"] in {ORIGIN, "https://localhost:9443"}
        if request.url.host == "localhost":
            assert self.host.phase == "production", "Production request after topology restoration"
        path = request.url.path
        _, user, aal = self.identity(request)
        if (
            user == OWNER_ID
            and self.factors[user]
            and aal != "aal2"
            and path not in {"/api/auth/login", "/api/auth/refresh", "/api/auth/mfa"}
        ):
            return self.response({"detail": {"code": "mfa_required"}}, 403)
        if path in {"/api/health", "/api/ready"}:
            body = (
                {"status": "ok"}
                if path.endswith("health")
                else {
                    "status": "ready",
                    "components": {
                        name: {"status": "ready"}
                        for name in ("database", "auth", "storage", "smtp")
                    },
                }
            )
            return self.response(
                body,
                headers=[
                    (
                        "X-OpenSlate-Instance",
                        "f" * 64 if self.host_fault == "wrong_instance" else "e" * 64,
                    )
                ],
            )
        if path.startswith("/api/backups") or path == "/api/workspace/security":
            self.requests.append(request)
            if path == "/api/workspace/security":
                return self.response({"mfa_require_admin": self.host_fault == "required_mfa"})
            if path == "/api/backups/status":
                # fmt: off
                return self.response({"policy": self.policy, "runner": {
                    "state": "available", "last_seen_at": "2026-10-07T00:00:00Z"},
                    "active_run": None, "queued_count": int(
                        self.queued is not None and self.queued["state"] == "queued")})
                # fmt: on
            if path == "/api/backups" and request.method == "POST":
                assert self.queued is None, "Queue write repeated"
                self.queued = BackupWire._run(self, json.loads(request.content)["name"])
                if self.host_fault == "unknown_queue":
                    raise httpx.ReadTimeout("fixture-only lost queue response", request=request)
                return self.response(
                    self.queued, 201, [("Location", "/api/backups?run_id=" + self.queued["id"])]
                )
            if path == "/api/backups":
                assert request.url.params["run_id"] == self.queued["id"]
                return self.page([self.queued], request)
            if path == "/api/backups/exports" and request.method == "POST":
                payload = json.loads(request.content)
                assert payload["backup_run_id"] == self.queued["id"]
                self.passphrase = payload["passphrase"]
                # fmt: off
                self.exported = {"id": str(uuid4()), "backup_run_id": self.queued["id"],
                    "state": "queued", "requested_at": "2026-10-07T00:00:00Z", "ready_at": None,
                    "expires_at": None, "size_bytes": None, "sha256": None, "failure_code": None}
                # fmt: on
                return self.response(
                    self.exported,
                    201,
                    [("Location", "/api/backups/exports/" + self.exported["id"])],
                )
            assert path == "/api/backups/exports/" + self.exported["id"]
            return self.response(self.exported)
        # This existing MFA fixture hardcodes its development origin. Adapt only
        # that external fixture assertion; keep the actual client's request above.
        adapted = httpx.Request(
            request.method,
            request.url,
            content=request.content,
            headers={**dict(request.headers), "origin": ORIGIN},
        )
        return super().handle(adapted)

    def run(self):
        self.run_calls += 1
        assert self.host.phase == "production"
        if self.run_calls == 1:
            assert self.queued["state"] == "queued"
            self.queued.update(
                state="succeeded",
                snapshot_id="b" * 64,
                manifest_sha256="c" * 64,
                started_at="2026-10-07T00:00:01Z",
                finished_at="2026-10-07T00:00:02Z",
                verified_at="2026-10-07T00:00:02Z",
                reconciled_at="2026-10-07T00:00:02Z",
            )
            return {"state": "succeeded", "run_id": self.queued["id"]}
        assert self.queued["state"] == "succeeded" and self.exported["state"] == "queued"
        now = datetime.now(UTC)
        self.exported.update(
            state="ready",
            ready_at=now.isoformat(),
            expires_at=(now + timedelta(hours=24)).isoformat(),
            size_bytes=26 * 1024 * 1024,
            sha256="d" * 64,
        )
        if self.host_fault == "wrong_export_source":
            self.exported["backup_run_id"] = str(uuid4())
        return {"state": "ready", "export_id": self.exported["id"]}


@pytest.fixture
def host_journey(host_dataset, topology_runtime, tmp_path, monkeypatch):
    from operations.sample.client import SampleClient
    from operations.sample.controls import host_delivery as delivery
    from operations.sample.population.people import SampleActorCredential

    runtime, host, original = topology_runtime
    wire = HostWire(host_dataset, host)
    original["owner_user_id"] = OWNER_ID
    host.on_run = wire.run
    with ExitStack() as stack:

        def client(origin=ORIGIN):
            return stack.enter_context(
                SampleClient(
                    origin, origin, runtime.journal_path, transport=httpx.MockTransport(wire.handle)
                )
            )

        admin, actor = client(), client()
        for c, key in ((admin, "admin"), (actor, wire.selected[0])):
            assert c.login(wire.users[key]["email"], PASSWORD).status_code == 200
        wire.owner_sessions = {sid for sid, user in wire.sessions.items() if user == OWNER_ID}
        monkeypatch.setattr(
            delivery, "https_client", lambda *_: client(runtime.origin), raising=False
        )

        # Cryptographic/native boundary outcomes are explicitly fake here. The
        # verification module has separate negative acceptance and Final is real.
        def verified(runtime, source, exported, passphrase, credential):
            # fmt: off
            proof = {
                "archive_size_bytes": exported.size_bytes, "archive_sha256": exported.sha256,
                "native_download_verified": True, "export_verified": True,
                "source_backup_verified": True, "source_snapshot_id": source.snapshot_id,
                "source_manifest_sha256": source.manifest_sha256,
                "source_backup_claim_id": str(uuid4()), "export_claim_id": str(uuid4()),
                "native_attempt_event_id": str(uuid4()),
                **{f"native_{step}_request_id": str(uuid4())
                   for step in ("login", "identity", "admission", "content")},
            }
            # fmt: on
            # fmt: off
            wire.events.append({"id": proof["native_attempt_event_id"],
                "occurred_at": datetime.now(UTC).isoformat(),
                "event_type": "backup.export.download",
                "source": "backup", "outcome": "attempt", "operation_id": str(exported.id),
                "actor_id": credential.user_id, "subject_id": str(exported.id),
                "request_id": proof["native_content_request_id"], "request_method": "GET",
                "request_path": f"/api/backups/exports/{exported.id}/content", "labels": {},
                "reason": None, "fingerprint": None, "metadata": {"backup_run_id": str(source.id),
                "size_bytes": exported.size_bytes, "sha256": exported.sha256}})
            # fmt: on
            return proof

        monkeypatch.setattr(delivery, "verify_delivery", verified, raising=False)
        # fmt: off
        # The installation operator owns the host backup; it is the wire's owner session.
        context = PhaseExecutionContext(clients={"operator": admin, wire.selected[0]: actor},
            user_ids={("operator" if key == "admin" else key): u["id"]
                      for key, u in wire.users.items()},
            group_ids={key: g["id"] for key, g in wire.groups.items()},
            department_ids={}, module_ids={}, field_ids={}, mappings={}, admin_password=PASSWORD,
            private_values={"credentials": {wire.selected[0]: SampleActorCredential(
                wire.actor, wire.users[wire.selected[0]]["email"], PASSWORD)}})
        # fmt: on
        yield (
            host_dataset,
            delivery.plan_host_controls(host_dataset)[0],
            context,
            runtime,
            host,
            wire,
        )


@pytest.fixture(params=("harbor", "school"))
def host_dataset(request):
    return build_dataset(
        "small", 83, date(2026, 10, 2), organization=get_pack(request.param), host_acceptance=True
    )


def test_host_plan_reuses_the_cleaned_mfa_member_without_the_original_backup_queue(host_dataset):
    from operations.sample.controls.backups import QUEUE_KEY
    from operations.sample.controls.host_delivery import plan_host_controls
    from operations.sample.controls.mfa import plan_mfa_controls

    actions = plan_host_controls(host_dataset)
    assert len(actions) == 1
    action = actions[0]
    person = next(p for p in host_dataset.organization.actors.people if p.key == action.actor_key)
    assert action.actor_key == plan_mfa_controls(host_dataset)[0].actor_key
    assert person.role == "member" and person.status == "active"
    assert action.kind == "backup_controls" and action.phase == "reorganization"
    assert action.key == "control:backups:physical_backup_export" and action.key != QUEUE_KEY
    assert action.values["operation"] == "physical_backup_export"
    assert action.target_key == "control:backups"


def test_host_control_without_trusted_runtime_fails_instead_of_omitting_acceptance(host_dataset):
    from operations.sample.controls.host_delivery import execute_host_control
    from operations.sample.controls.mfa import plan_mfa_controls

    action = PhaseAction(
        key="control:backups:physical_backup_export",
        phase="reorganization",
        kind="backup_controls",
        actor_key=plan_mfa_controls(host_dataset)[0].actor_key,
        target_key="control:backups",
        values={"operation": "physical_backup_export"},
        expected_status=200,
        expected_detail=None,
        expected_end_state={"development_restored": True},
    )
    context = PhaseExecutionContext(
        clients={},
        user_ids={},
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings={},
        admin_password="fixture-only-unused-password",
    )
    with pytest.raises(SamplePhaseActionError) as observed:
        execute_host_control(action, host_dataset, context)
    assert observed.value.step == "host_setup"
    assert context.runtime_mappings == {}
    assert context.private_values == {}


def test_host_control_refreshes_idle_clients_before_each_request(host_journey, monkeypatch):
    # The MFA control never refreshed and failed on 45-second tokens (F7); this control
    # copied that pattern (F8) and has no revoked-session probe that needs it.
    from operations.sample.client import SampleClient
    from operations.sample.controls.host_delivery import execute_host_control

    dataset, action, context, runtime, _, _ = host_journey
    skipped = []
    original = SampleClient.request

    def spy(self, method, path, **kwargs):
        if not kwargs.get("refresh_first", True):
            skipped.append((method, path))
        return original(self, method, path, **kwargs)

    monkeypatch.setattr(SampleClient, "request", spy)
    execute_host_control(action, dataset, context, runtime=runtime)

    assert skipped == []


@pytest.mark.parametrize("owner_has_factor", (False, True))
def test_source_export_restore_are_one_owned_journey_with_fresh_production_client(
    host_journey, owner_has_factor
):
    from operations.sample.controls.host_delivery import execute_host_control

    dataset, action, context, runtime, host, wire = host_journey
    if not owner_has_factor:
        wire.factors[OWNER_ID] = []
    original_groups = deepcopy(wire.groups)
    result = execute_host_control(action, dataset, context, runtime=runtime)
    assert result.get("outcome") == "completed"
    assert result["backup_run_id"] == wire.queued["id"]
    assert result["export_id"] == wire.exported["id"] and wire.run_calls == 2
    assert wire.users[wire.selected[0]]["role"] == "member"
    assert all(
        set(g["member_ids"]) == set(wire.groups[k]["member_ids"])
        for k, g in original_groups.items()
    )
    assert host.phase == "development" and host.api_running
    assert sum(r.method == "POST" and r.url.path == "/api/backups" for r in wire.observed) == 1
    assert all(
        r.headers["origin"] == runtime.origin
        for r in wire.observed
        if r.url.path.startswith("/api/backups") and r.url.path != "/api/backups/status"
    )
    encoded = json.dumps(result) + runtime.journal_path.read_text()
    assert PASSWORD not in encoded and wire.passphrase not in encoded
    assert "control:backups:queue_backup" not in context.runtime_mappings.get("backup_run", {})
    assert result["development_restored"] is True and result["role_groups_restored"] is True


@pytest.mark.parametrize(
    "fault", ("required_mfa", "existing_factor", "busy_policy", "no_credentials", "inactive")
)
def test_host_ineligible_actor_or_workload_refuses_before_promotion(host_journey, fault):
    from operations.sample.controls.host_delivery import execute_host_control

    dataset, action, context, runtime, host, wire = host_journey
    wire.host_fault = fault
    if fault == "existing_factor":
        wire.factors[wire.actor] = [
            {"id": str(uuid4()), "factor_type": "totp", "status": "verified"}
        ]
    if fault == "busy_policy":
        wire.policy["schedule"] = "weekly"
        wire.policy["next_due_at"] = "2026-10-10T00:00:00Z"
    if fault == "no_credentials":
        context.private_values["credentials"] = {}
    if fault == "inactive":
        wire.users[wire.selected[0]]["status"] = "disabled"
    with pytest.raises(SamplePhaseActionError):
        execute_host_control(action, dataset, context, runtime=runtime)
    assert wire.users[wire.selected[0]]["role"] == "member"
    runtime.stop_api.assert_not_called()
    assert not any(r.method == "PATCH" for r in wire.observed)


@pytest.mark.parametrize(
    "fault", ("unknown_queue", "wrong_export_source", "native_failure", "wrong_instance")
)
def test_delivery_failure_restores_member_groups_without_replaying_source(
    host_journey, monkeypatch, fault
):
    from operations.sample.controls import host_delivery as delivery

    dataset, action, context, runtime, host, wire = host_journey
    original_groups = deepcopy(wire.groups)
    wire.host_fault = fault
    if fault == "native_failure":

        def failed(*a, **k):
            raise RuntimeError("private-native-failure-payload")

        monkeypatch.setattr(delivery, "verify_delivery", failed)
    with pytest.raises(SamplePhaseActionError) as observed:
        delivery.execute_host_control(action, dataset, context, runtime=runtime)
    assert "private-native" not in str(observed.value)
    assert wire.users[wire.selected[0]]["role"] == "member"
    assert all(
        set(g["member_ids"]) == set(wire.groups[k]["member_ids"])
        for k, g in original_groups.items()
    )
    assert host.phase == "development" and host.api_running
    assert sum(r.method == "POST" and r.url.path == "/api/backups" for r in wire.observed) == (
        0 if fault == "wrong_instance" else 1
    )
    assert context.private_values["host_reconciliation"]["role_groups_restored"] is True


@pytest.mark.parametrize(
    "fault",
    (
        "wrong_actor",
        "wrong_export",
        "small",
        "threshold",
        "digest",
        "blob",
        "headers",
        "event",
        "request_correlation",
        "missing_journal",
        "held_descriptor",
        "secret",
    ),
)
def test_native_proof_cannot_complete_misattributed_incomplete_or_non_native_delivery(
    native_proof, fault
):
    from operations.sample.controls.host_verification import _native_evidence

    runtime, source, exported, credential, observed = native_proof
    if fault == "wrong_actor":
        observed["actor_id"] = str(uuid4())
    elif fault == "wrong_export":
        observed["export_id"] = str(uuid4())
    elif fault == "small":
        observed["size_bytes"] = 25 * 1024 * 1024
    elif fault == "threshold":
        exported = exported.model_copy(update={"size_bytes": 25 * 1024 * 1024})
        observed["size_bytes"] = exported.size_bytes
        observed["headers"]["content_length"] = str(exported.size_bytes)
        observed["attempt_event"]["metadata"]["size_bytes"] = exported.size_bytes
    elif fault == "digest":
        observed["sha256"] = "f" * 64
    elif fault == "blob":
        observed["used_fetch_blob"] = True
    elif fault == "headers":
        observed["headers"]["cache_control"] = "public"
    elif fault == "event":
        observed["attempt_event"]["metadata"]["backup_run_id"] = str(uuid4())
    elif fault == "request_correlation":
        observed["attempt_event"]["request_id"] = str(uuid4())
    elif fault == "missing_journal":
        observed["request_ids"]["content"] = str(uuid4())
    elif fault == "held_descriptor":
        observed["descriptors_released"] = False
    elif fault == "secret":
        observed["password"] = PASSWORD
    with pytest.raises(SamplePhaseActionError):
        _native_evidence(runtime, source, exported, credential, observed)


def test_native_proof_requires_observed_journal_ids_and_preserves_only_safe_facts(native_proof):
    from operations.sample.controls.host_verification import _native_evidence

    runtime, source, exported, credential, observed = native_proof
    result = _native_evidence(runtime, source, exported, credential, observed)
    assert result.get("native_download_verified") is True
    assert result["native_content_request_id"] == observed["request_ids"]["content"]
    assert result["native_attempt_event_id"] == observed["attempt_event"]["id"]
    assert PASSWORD not in json.dumps(result)


@pytest.mark.parametrize("fault", ("unverified_source", "wrong_source", "not_ready", "expired"))
def test_delivery_requires_current_verified_source_and_live_matching_export(native_proof, fault):
    from operations.sample.controls.host_verification import verify_delivery

    runtime, source, exported, credential, _ = native_proof
    if fault == "unverified_source":
        source = source.model_copy(update={"verified_at": None})
    elif fault == "wrong_source":
        exported = exported.model_copy(update={"backup_run_id": uuid4()})
    elif fault == "not_ready":
        exported = exported.model_copy(update={"state": "preparing"})
    elif fault == "expired":
        exported = exported.model_copy(update={"expires_at": datetime.now(UTC)})
    with pytest.raises(SamplePhaseActionError):
        verify_delivery(runtime, source, exported, "new-fixture-export-passphrase", credential)


def test_current_public_rows_without_owned_runner_claims_are_not_physical_proof(native_proof):
    from operations.sample.controls.host_verification import verify_delivery

    runtime, source, exported, credential, _ = native_proof
    with pytest.raises(SamplePhaseActionError):
        verify_delivery(runtime, source, exported, "new-fixture-export-passphrase", credential)


@pytest.mark.parametrize("fault", (None, "artifact", "event", "groups"))
def test_final_host_readback_cannot_accept_forged_delivery_or_lost_restoration(host_journey, fault):
    from operations.sample.controls.host_delivery import execute_host_control
    from operations.sample.controls.host_receipts import verify_host_controls

    dataset, action, context, runtime, _, wire = host_journey
    result = execute_host_control(action, dataset, context, runtime=runtime)
    assert result.get("outcome") == "completed"
    if fault == "artifact":
        wire.exported["sha256"] = "e" * 64
    if fault == "event":
        wire.events[0]["request_id"] = str(uuid4())
    if fault == "groups":
        next(g for g in wire.groups.values() if wire.actor in g["member_ids"])["member_ids"].remove(
            wire.actor
        )
    manifest = {
        "control_results": [result],
        "actor_ids": context.user_ids,
        "mappings": {"user": context.user_ids, "group": context.group_ids},
    }
    counts, issues = verify_host_controls(
        context.clients["operator"], dataset, manifest, OWNER_ID
    )
    if fault is None:
        assert issues == [] and counts["host_control_actions"] == 1
        assert counts["host_control_security_events"] == 1
    else:
        assert issues and counts["host_control_actions"] == 0
